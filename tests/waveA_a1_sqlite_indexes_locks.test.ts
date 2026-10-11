/**
 * WAVE A · A1 — hot-path SQLite index locks.
 *
 * Two evidence classes, both REAL:
 *
 *  1. BEHAVIORAL over an actual SQLite engine (bun:sqlite, in-memory):
 *     the REAL SCHEMA from storeSqlite.ts + the REAL migration DDL are
 *     executed, then EXPLAIN QUERY PLAN must show the new indexes used
 *     by the three hot query shapes (by-track, by-type, by-session) —
 *     the exact bar from the mission ("USING INDEX idx_events_track_ts
 *     instead of SCAN TABLE").
 *
 *  2. THE ONCE-PER-DEVICE LAW, pure: planIndexMigration is the decision
 *     function the sqlite adapter calls on every open. Flag present ⇒
 *     zero work; flag absent ⇒ create only what is missing and raise the
 *     flag exactly then.
 *
 * Mutations proven RED (see the worklog):
 *  M-A1-1  planIndexMigration always says "nothing to do"  → the pure
 *          law tests fail;
 *  M-A1-2  the by-track index is created as (ts, trackId) instead of
 *          (trackId, ts) → the EXPLAIN QUERY PLAN bar fails (SQLite
 *          cannot serve WHERE trackId=? ORDER BY ts DESC from that
 *          shape and falls back to a different index / scan).
 */

import { describe, expect, test, mock } from 'bun:test';
import { Database } from 'bun:sqlite';

// storeSqlite.ts imports expo-sqlite at module scope; the locks only need
// the PURE exports (SCHEMA / WAVE_A_INDEXES / planIndexMigration), so the
// native seam is stubbed before the dynamic import — the established
// pattern (tests/ai/wave2_library_locks.test.ts).
mock.module('expo-sqlite', () => ({
  openDatabaseAsync: async () => {
    throw new Error('expo-sqlite not used by the A1 locks');
  },
}));

const { SCHEMA, WAVE_A_INDEXES, planIndexMigration } = await import('../src/ai/core/storeSqlite');

// ── 1. the DDL is real and creates real indexes in a real engine ────────

function openMigratedDb(opts?: { skipMigration?: boolean }): Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  if (!opts?.skipMigration) {
    for (const ddl of WAVE_A_INDEXES.statements) db.exec(ddl);
  }
  return db;
}

function seedEvents(db: Database, n: number): void {
  const ins = db.prepare(
    `INSERT INTO events (id, ts, type, sessionId, trackId, artistId, surface, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < n; i += 1) {
    ins.run(`e${i}`, 1_700_000_000_000 + i, i % 2 ? 'PLAY_START' : 'SKIP', `sess-${i % 7}`, `tr-${i % 13}`, 'ar-1', 'radio', '{}');
  }
}

function planOf(db: Database, sql: string, params: string[]): string[] {
  // EXPLAIN QUERY PLAN rows expose a `detail` column — the human-readable
  // plan ("SEARCH events USING INDEX idx_...", "SCAN events").
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map(
    (r) => r.detail,
  );
}

describe('WAVE A · A1 — the hot-path indexes exist and get USED (real SQLite)', () => {
  test('the migration DDL creates exactly the three named indexes in sqlite_master', () => {
    const db = openMigratedDb();
    const rows = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (?, ?, ?)`)
      .all(...WAVE_A_INDEXES.names) as Array<{ name: string }>;
    expect(rows.map((r) => r.name).sort()).toEqual([...WAVE_A_INDEXES.names].sort());
  });

  test('by-track hot query: USING INDEX idx_events_track_ts, never SCAN TABLE', () => {
    const db = openMigratedDb();
    seedEvents(db, 500);
    const plan = planOf(
      db,
      `SELECT * FROM events WHERE trackId = ? ORDER BY ts DESC LIMIT 10`,
      ['tr-3'],
    );
    expect(plan.join(' ')).toContain('USING INDEX idx_events_track_ts');
    expect(plan.join(' ')).not.toContain('SCAN events');
  });

  test('by-type hot query: USING INDEX idx_events_type_ts', () => {
    const db = openMigratedDb();
    seedEvents(db, 500);
    const plan = planOf(
      db,
      `SELECT * FROM events WHERE type = ? ORDER BY ts DESC LIMIT 10`,
      ['PLAY_START'],
    );
    expect(plan.join(' ')).toContain('USING INDEX idx_events_type_ts');
  });

  test('by-session hot query: USING INDEX idx_events_session', () => {
    const db = openMigratedDb();
    seedEvents(db, 500);
    const plan = planOf(
      db,
      `SELECT * FROM events WHERE sessionId = ? ORDER BY ts DESC LIMIT 10`,
      ['sess-2'],
    );
    expect(plan.join(' ')).toContain('USING INDEX idx_events_session');
  });

  test('without the migration the by-track query is NOT served by the wave-A index', () => {
    // the control group: the same EXPLAIN against a pre-migration db must
    // NOT name idx_events_track_ts — proving the test detects the index's
    // presence, not the query's wording (a test that passes on both is
    // theatre).
    const db = openMigratedDb({ skipMigration: true });
    seedEvents(db, 500);
    const plan = planOf(
      db,
      `SELECT * FROM events WHERE trackId = ? ORDER BY ts DESC LIMIT 10`,
      ['tr-3'],
    );
    expect(plan.join(' ')).not.toContain('idx_events_track_ts');
  });
});

// ── 2. the once-per-device law (pure) ───────────────────────────────────

describe('WAVE A · A1 — planIndexMigration: the migration runs exactly once per device', () => {
  test('flag present ⇒ ZERO work (steady-state boot: one kv SELECT, nothing else)', () => {
    const plan = planIndexMigration(true, []);
    expect(plan.create).toEqual([]);
    expect(plan.setFlag).toBe(false);
  });

  test('flag absent + nothing exists ⇒ create all three, raise the flag', () => {
    const plan = planIndexMigration(false, ['idx_events_ts']);
    expect([...plan.create].sort()).toEqual(['idx_events_session', 'idx_events_track_ts', 'idx_events_type_ts'].sort());
    expect(plan.setFlag).toBe(true);
  });

  test('flag absent + some exist ⇒ create only the missing (never rebuild)', () => {
    const plan = planIndexMigration(false, ['idx_events_ts', 'idx_events_type_ts']);
    expect(plan.create).toEqual(['idx_events_track_ts', 'idx_events_session']);
    expect(plan.setFlag).toBe(true);
  });

  test('flag absent + ALL exist ⇒ create nothing but STILL raise the flag (the honest witness)', () => {
    // a device whose indexes predate the flag (e.g. restored backup) must
    // converge: no re-creation, flag raised, next boot costs one SELECT.
    const plan = planIndexMigration(false, ['idx_events_track_ts', 'idx_events_type_ts', 'idx_events_session']);
    expect(plan.create).toEqual([]);
    expect(plan.setFlag).toBe(true);
  });
});

// ── 3. source locks — the wiring is flag-gated and crash-honest ─────────

describe('WAVE A · A1 — the adapter wiring is flag-gated (source locks)', () => {
  const fs = require('fs');
  const src = fs.readFileSync('src/ai/core/storeSqlite.ts', 'utf8');

  test('createLedgerStore probes the kv flag BEFORE touching sqlite_master', () => {
    expect(src).toContain(`WHERE key = ?`);
    expect(src).toContain('WAVE_A_INDEXES.flagKey');
    expect(src).toContain(`type = 'index'`);
  });

  test('the flag is raised only AFTER creation, so a crashed migration retries', () => {
    const wiring = src.slice(src.indexOf('// WAVE A (A1) — the flag-gated'), src.indexOf('const impl: LedgerStore'));
    const setFlagAt = wiring.indexOf('if (plan.setFlag)');
    const createAt = wiring.indexOf('for (const name of plan.create)');
    expect(createAt).toBeGreaterThan(-1);
    expect(setFlagAt).toBeGreaterThan(createAt); // flag strictly after creates
  });

  test('a failed migration never blocks the ledger from opening', () => {
    expect(src).toContain('a failed migration must never block the ledger from opening');
  });

  test('SCHEMA itself is untouched by the wave (sacred-ground L1) — the three names live in the migration, not SCHEMA', () => {
    const schemaBlock = src.slice(src.indexOf('const SCHEMA = `'), src.indexOf('`;'));
    for (const name of WAVE_A_INDEXES.names) {
      expect(schemaBlock).not.toContain(name);
    }
    // the pre-existing index stays
    expect(schemaBlock).toContain('idx_events_ts');
  });
});
