/**
 * SQLite LedgerStore — the canonical on-device store (expo-sqlite).
 *
 * Design notes (§5.4 write protocol):
 *  - WAL journal + synchronous=NORMAL: appends return immediately, the OS
 *    checkpoints — a killed app loses zero committed evidence.
 *  - Single serialized write chain lives in ledger.ts, NOT here; this file
 *    is a dumb, fast adapter.
 *  - Indices: events(ts), listens(started_ts) — every read path is a range
 *    scan; no table ever gets scanned whole outside compaction.
 *  - The kv table holds the compacted profile snapshot (aggregates are
 *    kept forever; raw rows age out per RETENTION).
 */

import * as SQLite from 'expo-sqlite';
import type { LedgerStore } from './store';
import type { LedgerEvent, ListenRecord, SessionRecord } from './types';
import type { HistoricalDay } from './historical';
import {
  encodeArtistList,
  encodeMinutes,
  encodeTrackList,
  type EncodedArtist,
  type EncodedTrack,
} from './historical';

/** The full mindbeat.db schema — exported for the locks (a lock test runs
 *  the REAL DDL through a real SQLite engine; see waveA_a1 locks). */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  trackId TEXT,
  artistId TEXT,
  surface TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS listens (
  trackId TEXT NOT NULL,
  artistId TEXT,
  artist TEXT NOT NULL,
  title TEXT,
  language TEXT,
  genre TEXT,
  energy REAL NOT NULL,
  valence REAL NOT NULL,
  sessionId TEXT NOT NULL,
  surface TEXT NOT NULL,
  startedTs INTEGER NOT NULL,
  listenedMs INTEGER NOT NULL,
  durationMs INTEGER NOT NULL,
  completionRatio REAL NOT NULL,
  grade TEXT NOT NULL,
  skipBucket INTEGER,
  wasRecommended INTEGER NOT NULL,
  reasonCode TEXT,
  explorationSlot INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_listens_ts ON listens(startedTs);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  startTs INTEGER NOT NULL,
  endTs INTEGER,
  daypart TEXT NOT NULL,
  dayKind TEXT NOT NULL,
  trackCount INTEGER NOT NULL,
  totalListenMs INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- F9 · TIME MACHINE: the summary table (NEW — the events table above is
-- byte-identical to pre-F9; sacred-ground law L1). One row per LOCAL
-- day, written only by the compaction pass's fold.
CREATE TABLE IF NOT EXISTS historical_summary (
  dayKey TEXT PRIMARY KEY,
  dayStartTs INTEGER NOT NULL,
  minutes REAL NOT NULL,
  streams INTEGER NOT NULL,
  topTracks TEXT NOT NULL,
  topArtists TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_historical_start ON historical_summary(dayStartTs);
`;

// ── WAVE A (A1) — hot-path index migration ──────────────────────────────
// The three most-queried `events` patterns (Smart Crates by track,
// hygiene/engine reads by type, session folding by sessionId) previously
// full-scanned up to the retention cap (~10k rows) because the only index
// was idx_events_ts. The DDL lives OUTSIDE SCHEMA on purpose: the SCHEMA
// block stays byte-identical to pre-Wave-A (sacred-ground law L1), and
// the migration is flag-gated so a steady-state boot runs ZERO migration
// work (potato-phone law — the check is one kv SELECT, nothing more).
//
// Mission sketch said events(track_id …) — the REAL column names are the
// camelCase ones above (trackId / sessionId); SQLite would refuse the
// snake_case form, so the shipped DDL follows the actual schema.
export const WAVE_A_INDEXES = {
  /** The exactly-once witness. Present ⇒ indexes were verified/created on
   *  a previous open; the sqlite_master probe is skipped entirely. Only
   *  set AFTER the CREATE INDEX statements succeeded, so a crashed
   *  migration re-runs honestly on the next open. */
  flagKey: 'mig.wave_a_indexes_v1',
  names: ['idx_events_track_ts', 'idx_events_type_ts', 'idx_events_session'] as const,
  statements: [
    'CREATE INDEX IF NOT EXISTS idx_events_track_ts ON events(trackId, ts DESC)',
    'CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, ts DESC)',
    'CREATE INDEX IF NOT EXISTS idx_events_session ON events(sessionId)',
  ] as const,
} as const;

/**
 * The once-per-device migration law, PURE so it is lockable without a
 * device: a present flag means the work already happened (create nothing,
 * touch nothing); an absent flag means probe sqlite_master, create ONLY
 * the missing indexes (never rebuild what exists), and ALWAYS raise the
 * flag when absent — a pass that found every index already in place
 * (restored backup, pre-flag device) has verified them and converges to
 * the steady state: from the next open on, the migration costs one kv
 * SELECT and nothing else.
 */
export function planIndexMigration(
  flagPresent: boolean,
  existingIndexNames: string[],
): { create: readonly string[]; setFlag: boolean } {
  if (flagPresent) return { create: [], setFlag: false };
  const have = new Set(existingIndexNames);
  const create = WAVE_A_INDEXES.names.filter((n) => !have.has(n));
  return { create, setFlag: true };
}

interface EventRow {
  id: string;
  ts: number;
  type: string;
  sessionId: string;
  trackId: string | null;
  artistId: string | null;
  surface: string | null;
  payload: string;
}

interface ListenRow {
  trackId: string;
  artistId: string | null;
  artist: string;
  title: string | null;
  language: string | null;
  genre: string | null;
  energy: number;
  valence: number;
  sessionId: string;
  surface: string;
  startedTs: number;
  listenedMs: number;
  durationMs: number;
  completionRatio: number;
  grade: string;
  skipBucket: number | null;
  wasRecommended: number;
  reasonCode: string | null;
  explorationSlot: number;
}

interface SessionRow {
  id: string;
  startTs: number;
  endTs: number | null;
  daypart: string;
  dayKind: string;
  trackCount: number;
  totalListenMs: number;
}

/** Parse a JSON array column defensively (corrupt row ≠ dead read path). */
function safeParseArray<T>(raw: string): T[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

export async function createLedgerStore(): Promise<LedgerStore> {
  const db = await SQLite.openDatabaseAsync('mindbeat.db');

  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
  `);
  await db.execAsync(SCHEMA);

  // WAVE A (A1) — the flag-gated hot-path index migration. Steady state
  // (flag present) costs ONE kv SELECT; first open after the upgrade
  // probes sqlite_master, creates only the missing indexes, and raises
  // the flag. The plan is computed by the PURE planIndexMigration so the
  // exactly-once law is lockable without a device.
  try {
    const flagRow = await db.getFirstAsync<{ value: string }>(
      `SELECT value FROM kv WHERE key = ?`,
      [WAVE_A_INDEXES.flagKey],
    );
    const existing = await db.getAllAsync<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (?, ?, ?)`,
      [...WAVE_A_INDEXES.names],
    );
    const plan = planIndexMigration(!!flagRow, existing.map((r) => r.name));
    const ddlByName = new Map<string, string>(
      WAVE_A_INDEXES.names.map((n, i) => [n, WAVE_A_INDEXES.statements[i]]),
    );
    for (const name of plan.create) {
      const ddl = ddlByName.get(name);
      if (ddl) await db.execAsync(ddl);
    }
    if (plan.setFlag) {
      await db.runAsync(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`, [
        WAVE_A_INDEXES.flagKey,
        JSON.stringify({ appliedAt: Date.now(), indexes: WAVE_A_INDEXES.names }),
      ]);
    }
  } catch {
    /* a failed migration must never block the ledger from opening — the
       next open retries (the flag is only raised on success) */
  }

  const impl: LedgerStore = {
    async appendEvents(events: LedgerEvent[]): Promise<void> {
      if (!events.length) return;
      await db.withTransactionAsync(async () => {
        for (const e of events) {
          await db.runAsync(
            `INSERT OR IGNORE INTO events (id, ts, type, sessionId, trackId, artistId, surface, payload)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              e.id,
              e.ts,
              e.type,
              e.sessionId,
              e.trackId ?? null,
              e.artistId ?? null,
              e.surface ?? null,
              JSON.stringify(e.payload ?? {}),
            ],
          );
        }
      });
    },

    async getEvents(sinceTs?: number): Promise<LedgerEvent[]> {
      const rows: EventRow[] = sinceTs == null
        ? await db.getAllAsync(`SELECT * FROM events ORDER BY ts ASC`)
        : await db.getAllAsync(`SELECT * FROM events WHERE ts >= ? ORDER BY ts ASC`, [sinceTs]);
      return rows.map((r) => ({
        id: r.id,
        ts: r.ts,
        type: r.type as LedgerEvent['type'],
        sessionId: r.sessionId,
        trackId: r.trackId ?? undefined,
        artistId: r.artistId ?? undefined,
        surface: (r.surface ?? undefined) as LedgerEvent['surface'],
        payload: JSON.parse(r.payload) as Record<string, unknown>,
      }));
    },

    async countEvents(): Promise<number> {
      const row = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM events`);
      return row?.n ?? 0;
    },

    async deleteEventsBefore(cutoffTs: number): Promise<number> {
      const res = await db.runAsync(`DELETE FROM events WHERE ts < ?`, [cutoffTs]);
      return res.changes;
    },

    async appendListen(record: ListenRecord): Promise<void> {
      await db.runAsync(
        `INSERT INTO listens (
           trackId, artistId, artist, title, language, genre, energy, valence,
           sessionId, surface, startedTs, listenedMs, durationMs, completionRatio,
           grade, skipBucket, wasRecommended, reasonCode, explorationSlot
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          record.trackId,
          record.artistId ?? null,
          record.artist,
          record.title ?? null,
          record.language ?? null,
          record.genre ?? null,
          record.energy,
          record.valence,
          record.sessionId,
          record.surface,
          record.startedTs,
          record.listenedMs,
          record.durationMs,
          record.completionRatio,
          record.grade,
          record.skipBucket ?? null,
          record.wasRecommended ? 1 : 0,
          record.reasonCode ?? null,
          record.explorationSlot ? 1 : 0,
        ],
      );
    },

    async getlistens(sinceTs?: number): Promise<ListenRecord[]> {
      const rows: ListenRow[] = sinceTs == null
        ? await db.getAllAsync(`SELECT * FROM listens ORDER BY startedTs ASC`)
        : await db.getAllAsync(`SELECT * FROM listens WHERE startedTs >= ? ORDER BY startedTs ASC`, [sinceTs]);
      return rows.map((r) => ({
        trackId: r.trackId,
        artistId: r.artistId ?? undefined,
        artist: r.artist,
        title: r.title ?? undefined,
        language: r.language ?? undefined,
        genre: r.genre ?? undefined,
        energy: r.energy,
        valence: r.valence,
        sessionId: r.sessionId,
        surface: r.surface as ListenRecord['surface'],
        startedTs: r.startedTs,
        listenedMs: r.listenedMs,
        durationMs: r.durationMs,
        completionRatio: r.completionRatio,
        grade: r.grade as ListenRecord['grade'],
        skipBucket: r.skipBucket ?? undefined,
        wasRecommended: !!r.wasRecommended,
        reasonCode: (r.reasonCode ?? undefined) as ListenRecord['reasonCode'],
        explorationSlot: !!r.explorationSlot,
      }));
    },

    async deleteListensBefore(cutoffTs: number): Promise<number> {
      const res = await db.runAsync(`DELETE FROM listens WHERE startedTs < ?`, [cutoffTs]);
      return res.changes;
    },

    async upsertSession(session: SessionRecord): Promise<void> {
      await db.runAsync(
        `INSERT OR REPLACE INTO sessions (id, startTs, endTs, daypart, dayKind, trackCount, totalListenMs)
         VALUES (?,?,?,?,?,?,?)`,
        [
          session.id,
          session.startTs,
          session.endTs ?? null,
          session.daypart,
          session.dayKind,
          session.trackCount,
          session.totalListenMs,
        ],
      );
    },

    async getSessions(sinceTs?: number): Promise<SessionRecord[]> {
      const rows: SessionRow[] = sinceTs == null
        ? await db.getAllAsync(`SELECT * FROM sessions ORDER BY startTs ASC`)
        : await db.getAllAsync(`SELECT * FROM sessions WHERE startTs >= ? ORDER BY startTs ASC`, [sinceTs]);
      return rows.map((r) => ({
        id: r.id,
        startTs: r.startTs,
        endTs: r.endTs ?? undefined,
        daypart: r.daypart as SessionRecord['daypart'],
        dayKind: r.dayKind as SessionRecord['dayKind'],
        trackCount: r.trackCount,
        totalListenMs: r.totalListenMs,
      }));
    },

    // ── F9 · historical_summary (the Time Machine's own table) ──────

    async upsertHistoricalDay(day: HistoricalDay): Promise<void> {
      await db.runAsync(
        `INSERT OR REPLACE INTO historical_summary (dayKey, dayStartTs, minutes, streams, topTracks, topArtists)
         VALUES (?,?,?,?,?,?)`,
        [
          day.dayKey,
          day.dayStartTs,
          encodeMinutes(day.minutes),
          day.streams,
          JSON.stringify(encodeTrackList(day.topTracks ?? [])),
          JSON.stringify(encodeArtistList(day.topArtists ?? [])),
        ],
      );
    },

    async getHistoricalDays(sinceTs?: number): Promise<HistoricalDay[]> {
      const rows: Array<{
        dayKey: string;
        dayStartTs: number;
        minutes: number;
        streams: number;
        topTracks: string;
        topArtists: string;
      }> = sinceTs == null
        ? await db.getAllAsync(`SELECT * FROM historical_summary ORDER BY dayStartTs ASC`)
        : await db.getAllAsync(`SELECT * FROM historical_summary WHERE dayStartTs >= ? ORDER BY dayStartTs ASC`, [sinceTs]);
      return rows.map((r) => ({
        dayKey: r.dayKey,
        dayStartTs: r.dayStartTs,
        minutes: r.minutes,
        streams: r.streams,
        topTracks: safeParseArray<EncodedTrack>(r.topTracks).map(([id, title, artist, plays]) => ({
          id,
          title,
          artist,
          plays,
        })),
        topArtists: safeParseArray<EncodedArtist>(r.topArtists).map(([name, plays]) => ({ name, plays })),
      }));
    },

    async deleteHistoricalDaysBefore(cutoffTs: number): Promise<number> {
      const res = await db.runAsync(`DELETE FROM historical_summary WHERE dayStartTs < ?`, [cutoffTs]);
      return res.changes;
    },

    async getKV<T>(key: string): Promise<T | null> {
      const row = await db.getFirstAsync<{ value: string }>(`SELECT value FROM kv WHERE key = ?`, [key]);
      if (!row) return null;
      try {
        return JSON.parse(row.value) as T;
      } catch {
        return null;
      }
    },

    async setKV<T>(key: string, value: T): Promise<void> {
      await db.runAsync(
        `INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`,
        [key, JSON.stringify(value)],
      );
    },

    async close(): Promise<void> {
      try {
        await db.closeAsync();
      } catch {
        /* already closed */
      }
    },
  };

  return impl;
}
