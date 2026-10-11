/**
 * APP CONTENT TABLES (MAGNUM OPUS) — the SQLite home for the user's own
 * factual data: song stories (F6), audio bookmarks (F7), memory tags
 * (F20), session snapshots (F15). SEPARATE from the event ledger's
 * mindbeat.db ownership: these are user-content tables, not intelligence
 * evidence, so they live in their own database file (appcontent.db) and
 * never share a write path with the ledger.
 *
 * WEB/PARITY (house rule ⑮): metro redirects this file to
 * src/webmocks/appTables.ts on platform 'web' — same exports, in-memory
 * Maps. The Android bundle is byte-verified to contain no webmock
 * strings (scripts/verify_v*_apk.py).
 *
 * Every table declares its cap in constants.ts (potato rule ⑯); the
 * caps are enforced by the pure services, not by the schema.
 */

import * as SQLite from 'expo-sqlite';
import { recordingKey } from '../api/recording';
import {
  createSongStories,
  type SongStoriesService,
  type SongStoriesStore,
  type SongStory,
} from './songStories';
import {
  createBookmarks,
  type BookmarksService,
  type BookmarksStore,
  type Bookmark,
} from '../player/bookmarks';
import {
  createSessionSnapshots,
  type SessionSnapshotsService,
  type SessionSnapshotsStore,
  type SessionSnapshot,
} from '../ai/sessionMemory';
import {
  createMemoryTags,
  type MemoryTagsService,
  type MemoryTagsStore,
  type MemoryTag,
} from './memoryTags';
import {
  createIndexedStories,
  createIndexedMemoryTags,
  noteEntryKey,
  ftsQueryFor,
  snippetFor,
  MIN_NOTE_QUERY_CHARS,
  type NotesIndex,
  type NoteEntry,
  type PersonalNoteHit,
} from './noteIndex';

export type { NotesIndex, NoteEntry, PersonalNoteHit };

/** Parse a JSON array column defensively (corrupt row ≠ dead read path). */
function safeParseArray<T>(raw: string): T[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS song_stories (
  recordingKey TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY,
  recordingKey TEXT NOT NULL,
  positionMs INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_track ON bookmarks(recordingKey);

-- prepared for later waves (schema ships once; accessors land with their
-- features so this file's diff stays reviewable):
CREATE TABLE IF NOT EXISTS memory_tags (
  id TEXT PRIMARY KEY,
  recordingKey TEXT NOT NULL,
  lat REAL,
  lng REAL,
  at INTEGER NOT NULL,
  photoUri TEXT,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_memory_tags_track ON memory_tags(recordingKey);

CREATE TABLE IF NOT EXISTS session_snapshots (
  id TEXT PRIMARY KEY,
  vibeLabel TEXT NOT NULL,
  seedTrackIds TEXT NOT NULL,
  startedAt INTEGER NOT NULL,
  endedAt INTEGER NOT NULL
);
`;

// Wave C · C2 — the full-text index over the user's own words. The
// brief's sketch listed recording_key twice (once searchable, once
// UNINDEXED — invalid SQL, duplicate column): the working schema keeps
// recording_key + note_text + source SEARCHABLE (THE BAR's "heartbreak"
// example matches a story through its recording identity) and adds an
// UNINDEXED entry_key so deletes/upserts can target exactly one row.
const NOTES_FTS_SCHEMA = `CREATE VIRTUAL TABLE IF NOT EXISTS personal_notes_fts USING fts5(
  recording_key, note_text, source, UNINDEXED(entry_key)
);`;

export interface AppTables {
  stories: SongStoriesService;
  bookmarks: BookmarksService;
  /** F15 — the last few session snapshots (FIFO max 3). */
  sessions: SessionSnapshotsService;
  /** F20 (LITE) — the listener's tagged moments. */
  memoryTags: MemoryTagsService;
  /** Wave C · C2 — full-text search over stories + memory-tag notes. */
  notes: NotesIndex;
}

let instance: Promise<AppTables> | null = null;

/** Open (once) and bind the pure services to the SQLite adapters. */
export function getAppTables(): Promise<AppTables> {
  if (!instance) {
    instance = (async () => {
      const db = await SQLite.openDatabaseAsync('appcontent.db');
      await db.execAsync(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;`);
      await db.execAsync(SCHEMA);

      // ── Wave C · C2: the FTS5 index over the user's own words ──
      // expo-sqlite compiles with -DSQLITE_ENABLE_FTS5=1; if a build
      // ever ships without it, the honest degradation is a LIKE scan
      // over the (capped) source tables — the feature never dies.
      let fts = false;
      try {
        await db.execAsync(NOTES_FTS_SCHEMA);
        fts = true;
      } catch {
        fts = false;
      }

      const sqliteNotesIndex = (useFts: boolean): NotesIndex => ({
        async upsert(entry: NoteEntry) {
          if (!useFts) return; // the LIKE fallback reads the source tables
          await db.runAsync(
            `DELETE FROM personal_notes_fts WHERE entry_key = ?`,
            [entry.entryKey],
          );
          await db.runAsync(
            `INSERT INTO personal_notes_fts (recording_key, note_text, source, entry_key) VALUES (?,?,?,?)`,
            [entry.recordingKey, entry.text, entry.source, entry.entryKey],
          );
        },
        async remove(entryKey) {
          if (!useFts) return;
          await db.runAsync(`DELETE FROM personal_notes_fts WHERE entry_key = ?`, [entryKey]);
        },
        async search(query, limit = 8) {
          if (String(query ?? '').trim().length < MIN_NOTE_QUERY_CHARS) return [];
          if (!useFts) {
            // honest LIKE fallback (potato-safe: capped tables)
            const like = `%${String(query).trim().toLowerCase()}%`;
            const rows = await db.getAllAsync<{ recording_key: string; note_text: string; source: string }>(
              `SELECT recordingKey AS recording_key, text AS note_text, 'story' AS source FROM song_stories WHERE lower(text) LIKE ?
               UNION ALL
               SELECT recordingKey AS recording_key, note AS note_text, 'memory_tag' AS source FROM memory_tags WHERE lower(note) LIKE ?
               LIMIT ?`,
              [like, like, limit],
            );
            return rows.map((r) => ({
              entryKey: noteEntryKey(r.source as 'story' | 'memory_tag', r.recording_key),
              recordingKey: r.recording_key,
              text: r.note_text,
              source: r.source as 'story' | 'memory_tag',
              snippet: snippetFor(r.note_text, query),
            }));
          }
          const match = ftsQueryFor(query);
          if (!match) return [];
          const rows = await db.getAllAsync<{
            recording_key: string;
            note_text: string;
            source: string;
            snip: string;
          }>(
            `SELECT recording_key, note_text, source,
                    snippet(personal_notes_fts, 1, '', '', '…', 12) AS snip
             FROM personal_notes_fts WHERE personal_notes_fts MATCH ?
             ORDER BY rank LIMIT ?`,
            [match, limit],
          );
          return rows.map((r) => ({
            entryKey: noteEntryKey(r.source as 'story' | 'memory_tag', r.recording_key),
            recordingKey: r.recording_key,
            text: r.note_text,
            source: r.source as 'story' | 'memory_tag',
            snippet: r.snip || snippetFor(r.note_text, query),
          }));
        },
        async count() {
          if (!useFts) {
            const r = await db.getFirstAsync<{ c: number }>(
              `SELECT (SELECT COUNT(*) FROM song_stories) + (SELECT COUNT(*) FROM memory_tags WHERE note != '') AS c`,
            );
            return r?.c ?? 0;
          }
          const r = await db.getFirstAsync<{ c: number }>(`SELECT COUNT(*) AS c FROM personal_notes_fts`);
          return r?.c ?? 0;
        },
      });
      const notesIndex = sqliteNotesIndex(fts);

      if (fts) {
        // one-time migration: an empty index with populated source
        // tables means the C2 upgrade just landed — backfill once
        const c = await db.getFirstAsync<{ c: number }>(`SELECT COUNT(*) AS c FROM personal_notes_fts`);
        if ((c?.c ?? 0) === 0) {
          await db.runAsync(
            `INSERT INTO personal_notes_fts (recording_key, note_text, source, entry_key)
             SELECT recordingKey, text, 'story', 'story:' || recordingKey FROM song_stories`,
          );
          await db.runAsync(
            `INSERT INTO personal_notes_fts (recording_key, note_text, source, entry_key)
             SELECT recordingKey, note, 'memory_tag', 'tag:' || id FROM memory_tags WHERE note IS NOT NULL AND note != ''`,
          );
        }
      }

      // Wave C · C2 — the stores below are INDEXED: every write (user
      // save or service LRU eviction) keeps the index in sync for free.
      const storiesStore: SongStoriesStore = {
        async getStory(key) {
          const row = await db.getFirstAsync<{
            recordingKey: string;
            text: string;
            createdAt: number;
            updatedAt: number;
          }>(`SELECT * FROM song_stories WHERE recordingKey = ?`, [key]);
          return row ?? null;
        },
        async upsertStory(story: SongStory) {
          await db.runAsync(
            `INSERT OR REPLACE INTO song_stories (recordingKey, text, createdAt, updatedAt) VALUES (?,?,?,?)`,
            [story.recordingKey, story.text, story.createdAt, story.updatedAt],
          );
        },
        async deleteStory(key) {
          await db.runAsync(`DELETE FROM song_stories WHERE recordingKey = ?`, [key]);
        },
        async allStories() {
          return db.getAllAsync<SongStory>(`SELECT * FROM song_stories`);
        },
      };

      const bookmarksStore: BookmarksStore = {
        async forTrack(recordingKey) {
          return db.getAllAsync<Bookmark>(`SELECT * FROM bookmarks WHERE recordingKey = ?`, [
            recordingKey,
          ]);
        },
        async all() {
          return db.getAllAsync<Bookmark>(`SELECT * FROM bookmarks`);
        },
        async put(b: Bookmark) {
          await db.runAsync(
            `INSERT OR REPLACE INTO bookmarks (id, recordingKey, positionMs, note, createdAt) VALUES (?,?,?,?,?)`,
            [b.id, b.recordingKey, b.positionMs, b.note, b.createdAt],
          );
        },
        async del(id) {
          await db.runAsync(`DELETE FROM bookmarks WHERE id = ?`, [id]);
        },
      };

      const sessionsStore: SessionSnapshotsStore = {
        async put(snapshot: SessionSnapshot) {
          await db.runAsync(
            `INSERT OR REPLACE INTO session_snapshots (id, vibeLabel, seedTrackIds, startedAt, endedAt) VALUES (?,?,?,?,?)`,
            [snapshot.id, snapshot.vibeLabel, JSON.stringify(snapshot.seedTrackIds), snapshot.startedAt, snapshot.endedAt],
          );
        },
        async all() {
          const rows = await db.getAllAsync<{ id: string; vibeLabel: string; seedTrackIds: string; startedAt: number; endedAt: number }>(
            `SELECT * FROM session_snapshots`,
          );
          return rows.map((r) => ({
            id: r.id,
            vibeLabel: r.vibeLabel,
            seedTrackIds: safeParseArray<string>(r.seedTrackIds),
            startedAt: r.startedAt,
            endedAt: r.endedAt,
          }));
        },
        async del(id) {
          await db.runAsync(`DELETE FROM session_snapshots WHERE id = ?`, [id]);
        },
      };

      const memoryTagsStore: MemoryTagsStore = {
        async get(id) {
          const row = await db.getFirstAsync<MemoryTag>(`SELECT * FROM memory_tags WHERE id = ?`, [id]);
          return row ?? null;
        },
        async all() {
          return db.getAllAsync<MemoryTag>(`SELECT * FROM memory_tags`);
        },
        async put(tag) {
          await db.runAsync(
            `INSERT OR REPLACE INTO memory_tags (id, recordingKey, lat, lng, at, photoUri, note) VALUES (?,?,?,?,?,?,?)`,
            [tag.id, tag.recordingKey, tag.lat, tag.lng, tag.at, tag.photoUri, tag.note],
          );
        },
        async del(id) {
          await db.runAsync(`DELETE FROM memory_tags WHERE id = ?`, [id]);
        },
      };

      const indexedStoriesStore = createIndexedStories(storiesStore, notesIndex);
      const indexedTagsStore = createIndexedMemoryTags(memoryTagsStore, notesIndex);

      return {
        stories: createSongStories(indexedStoriesStore),
        bookmarks: createBookmarks(bookmarksStore),
        sessions: createSessionSnapshots(sessionsStore),
        memoryTags: createMemoryTags(indexedTagsStore),
        notes: notesIndex,
      };
    })();
    instance.catch(() => {
      instance = null; // a failed open retries on the next call
    });
  }
  return instance;
}

/** recordingKey for a track — the ONE place the UI derives content keys.
 *  DELEGATES to the canonical recordingKey (src/api/recording.ts) so a
 *  story/bookmark survives provider re-listings (diacritics, credit
 *  noise, punctuation variants) — the blind critic's P1: a weaker
 *  local normalizer broke the "portable across providers" law. */
export function contentKeyOf(track: { title: string; artist: string }): string {
  return recordingKey(track);
}
