/**
 * AUDIO BOOKMARKS (MAGNUM OPUS · F7) — long-press the progress bar to
 * save a position (+ optional note); dots render on the bar; tapping a
 * dot jumps via the EXISTING PlayerProvider.seek path (no second seek
 * implementation — bar-locked in the wiring evidence).
 *
 * Pure core over an INJECTED store; the app injects the SQLite adapter
 * (src/storage/appTables.ts, table `bookmarks`). The gesture classifier
 * (classifyPress) is pure so the long-press/scrub distinction is
 * lockable without a device.
 *
 * LAWS:
 *  - Keyed by recordingKey (portable across providers).
 *  - Caps: BOOKMARKS.perTrackCap per recording, BOOKMARKS.totalCap
 *    total — enforced FIFO by createdAt (oldest evicted first).
 *  - Deterministic ids: `${recordingKey}:${positionSec}` — one bookmark
 *    per second per recording; re-saving the same second UPDATES it.
 *  - Kill switch irrelevant: factual user data, not a recommendation.
 */

import { BOOKMARKS } from '../ai/core/constants';

export interface Bookmark {
  id: string;
  recordingKey: string;
  positionMs: number;
  note: string;
  createdAt: number;
}

export interface BookmarksStore {
  /** All bookmarks for one recording (any order — the service sorts). */
  forTrack(recordingKey: string): Promise<Bookmark[]>;
  all(): Promise<Bookmark[]>;
  put(b: Bookmark): Promise<void>;
  del(id: string): Promise<void>;
}

/** Deterministic bookmark id (one per second per recording). */
export function bookmarkIdOf(recordingKey: string, positionMs: number): string {
  return `${recordingKey}:${Math.max(0, Math.round(positionMs / BOOKMARKS.snapMs))}`;
}

/** Snap to whole seconds (BOOKMARKS.snapMs) and clamp at 0. */
export function snapBookmarkPosition(positionMs: number): number {
  const s = Math.round(positionMs / BOOKMARKS.snapMs) * BOOKMARKS.snapMs;
  return Math.max(0, s);
}

export function sanitizeBookmarkNote(raw: string): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, BOOKMARKS.maxNoteChars);
}

/**
 * THE GESTURE CONTRACT (pure): decide what a press on the progress bar
 * means. A hold of ≥ longPressMs with travel ≤ moveTolerancePx is a
 * BOOKMARK save; everything else is the existing scrub (fast taps and
 * drags behave byte-identically to the pre-F7 bar).
 */
export type PressVerdict = 'scrub' | 'bookmark';

export function classifyPress(heldMs: number, travelPx: number): PressVerdict {
  if (heldMs >= BOOKMARKS.longPressMs && travelPx <= BOOKMARKS.moveTolerancePx) return 'bookmark';
  return 'scrub';
}

export interface BookmarksService {
  /** Save (or update) a bookmark; returns the stored row. */
  add(recordingKey: string, positionMs: number, note: string, now: number): Promise<Bookmark | null>;
  /** For one recording, ordered by position (the dots' order). */
  list(recordingKey: string): Promise<Bookmark[]>;
  remove(id: string): Promise<boolean>;
  count(): Promise<number>;
}

export function createBookmarks(store: BookmarksStore): BookmarksService {
  let chain: Promise<unknown> = Promise.resolve();
  const serialized = <T>(job: () => Promise<T>): Promise<T> => {
    const run = chain.then(job, job);
    chain = run.catch(() => undefined);
    return run;
  };

  return {
    async add(recordingKey, positionMs, note, now) {
      if (!recordingKey || !(positionMs >= 0)) return null;
      return serialized(async () => {
        const id = bookmarkIdOf(recordingKey, positionMs);
        const existingAll = await store.all();
        const existing = existingAll.find((b) => b.id === id);
        const bm: Bookmark = {
          id,
          recordingKey,
          positionMs: snapBookmarkPosition(positionMs),
          note: sanitizeBookmarkNote(note),
          createdAt: existing?.createdAt ?? now,
        };
        await store.put(bm);

        // Per-track cap: oldest-created first (FIFO), the row just saved
        // is never its own victim.
        const mine = (await store.forTrack(recordingKey)).sort((a, b) => a.createdAt - b.createdAt);
        if (mine.length > BOOKMARKS.perTrackCap) {
          const excess = mine.length - BOOKMARKS.perTrackCap;
          for (let i = 0; i < excess; i++) {
            if (mine[i].id !== id) await store.del(mine[i].id);
          }
        }
        // Global cap: oldest-created first across all recordings.
        const all = (await store.all()).sort((a, b) => a.createdAt - b.createdAt);
        if (all.length > BOOKMARKS.totalCap) {
          const excess = all.length - BOOKMARKS.totalCap;
          for (let i = 0; i < excess; i++) {
            if (all[i].id !== id) await store.del(all[i].id);
          }
        }
        return bm;
      });
    },

    async list(recordingKey) {
      try {
        return (await store.forTrack(recordingKey)).sort((a, b) => a.positionMs - b.positionMs);
      } catch {
        return [];
      }
    },

    async remove(id) {
      if (!id) return false;
      return serialized(async () => {
        const all = await store.all();
        const had = all.some((b) => b.id === id);
        await store.del(id);
        return had;
      });
    },

    async count() {
      try {
        return (await store.all()).length;
      } catch {
        return 0;
      }
    },
  };
}
