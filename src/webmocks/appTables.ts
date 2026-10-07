/**
 * WEB MOCK · APP CONTENT TABLES — the in-memory twin of
 * src/storage/appTables.ts (metro redirects on platform 'web').
 * Same exports, same caps (enforced by the shared pure services),
 * Maps instead of SQLite. House rule ⑮ parity.
 */

import {
  createSongStories,
  type SongStoriesService,
  type SongStoriesStore,
  type SongStory,
} from '../storage/songStories';
import { recordingKey } from '../api/recording';
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

export interface AppTables {
  stories: SongStoriesService;
  bookmarks: BookmarksService;
  /** F15 — the last few session snapshots (FIFO max 3). */
  sessions: SessionSnapshotsService;
}

const storiesMap = new Map<string, SongStory>();
const bookmarksMap = new Map<string, Bookmark>();
const sessionsMap = new Map<string, SessionSnapshot>();

let instance: Promise<AppTables> | null = null;

export function getAppTables(): Promise<AppTables> {
  if (!instance) {
    const storiesStore: SongStoriesStore = {
      async getStory(key) {
        return storiesMap.get(key) ?? null;
      },
      async upsertStory(story: SongStory) {
        storiesMap.set(story.recordingKey, { ...story });
      },
      async deleteStory(key) {
        storiesMap.delete(key);
      },
      async allStories() {
        return [...storiesMap.values()];
      },
    };
    const bookmarksStore: BookmarksStore = {
      async forTrack(recordingKey) {
        return [...bookmarksMap.values()].filter((b) => b.recordingKey === recordingKey);
      },
      async all() {
        return [...bookmarksMap.values()];
      },
      async put(b: Bookmark) {
        bookmarksMap.set(b.id, { ...b });
      },
      async del(id) {
        bookmarksMap.delete(id);
      },
    };
    const sessionsStore: SessionSnapshotsStore = {
      async put(snapshot: SessionSnapshot) {
        sessionsMap.set(snapshot.id, { ...snapshot });
      },
      async all() {
        return [...sessionsMap.values()];
      },
      async del(id) {
        sessionsMap.delete(id);
      },
    };
    instance = Promise.resolve({
      stories: createSongStories(storiesStore),
      bookmarks: createBookmarks(bookmarksStore),
      sessions: createSessionSnapshots(sessionsStore),
    });
  }
  return instance;
}

/** recordingKey for a track — byte-identical twin of the native module's
 *  contentKeyOf (both delegate to the canonical recordingKey, so the
 *  web/native keys can never drift). */
export function contentKeyOf(track: { title: string; artist: string }): string {
  return recordingKey(track);
}
