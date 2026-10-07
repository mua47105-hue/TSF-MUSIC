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

export interface AppTables {
  stories: SongStoriesService;
  bookmarks: BookmarksService;
  /** F15 — the last few session snapshots (FIFO max 3). */
  sessions: SessionSnapshotsService;
  /** F20 (LITE) — the listener's tagged moments. */
  memoryTags: MemoryTagsService;
}

let instance: Promise<AppTables> | null = null;

/** Open (once) and bind the pure services to the SQLite adapters. */
export function getAppTables(): Promise<AppTables> {
  if (!instance) {
    instance = (async () => {
      const db = await SQLite.openDatabaseAsync('appcontent.db');
      await db.execAsync(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;`);
      await db.execAsync(SCHEMA);

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

      return {
        stories: createSongStories(storiesStore),
        bookmarks: createBookmarks(bookmarksStore),
        sessions: createSessionSnapshots(sessionsStore),
        memoryTags: createMemoryTags(memoryTagsStore),
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
