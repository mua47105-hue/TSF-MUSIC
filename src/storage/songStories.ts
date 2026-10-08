/**
 * SONG STORIES (MAGNUM OPUS · F6) — personal notes attached to
 * recordings. "This was playing when we met."
 *
 * Pure CRUD over an INJECTED store interface — the tests run on a
 * fixture store, the app injects the SQLite adapter
 * (src/storage/appTables.ts, table `song_stories`). No React, no RN,
 * no network.
 *
 * LAWS:
 *  - Rows are keyed by recordingKey (title+primary-artist identity from
 *    src/api/recording.ts), NEVER trackId — a story survives a source
 *    switch or a provider-id change for the same recording.
 *  - A transient playback handle can never enter the schema: the store
 *    contract accepts only {recordingKey, text, createdAt, updatedAt}. The
 *    type system makes the leak unrepresentable (bar-locked).
 *  - Kill switch IRRELEVANT by design: a memory note is factual user
 *    data, not a recommendation — disabling intelligence must never
 *    delete or hide the user's own words.
 *  - LRU cap (STORIES.cap, by updatedAt) — potato rule ⑯.
 */

import { STORIES } from '../ai/core/constants';

export interface SongStory {
  /** The recording identity (norm title + primary artist), not a track id. */
  recordingKey: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

/** The minimal persistence contract the SQLite adapter fulfills. */
export interface SongStoriesStore {
  getStory(key: string): Promise<SongStory | null>;
  upsertStory(story: SongStory): Promise<void>;
  deleteStory(key: string): Promise<void>;
  /** All stories (any order — the service sorts). */
  allStories(): Promise<SongStory[]>;
}

/**
 * Sanitize a story before it may touch storage: trim, collapse
 * newlines beyond the cap, strip control characters, enforce
 * STORIES.maxChars. Deterministic; the locks pin the literals.
 */
export function sanitizeStoryText(raw: string): string {
  // strip control chars except \n and tab, collapse 3+ newlines to two
  const cleaned = String(raw ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned.slice(0, STORIES.maxChars);
}

export interface SongStoriesService {
  /** Create or update the story for a recording (returns the stored row). */
  setStory(recordingKey: string, text: string, now: number): Promise<SongStory | null>;
  getStory(recordingKey: string): Promise<SongStory | null>;
  removeStory(recordingKey: string): Promise<boolean>;
  /** Newest-updated first (the UI shows the freshest memory on top). */
  listStories(): Promise<SongStory[]>;
  count(): Promise<number>;
}

/** Empty/blank text is NOT a story — saving one is an honest no-op. */
export function isBlankStory(text: string): boolean {
  return sanitizeStoryText(text).length === 0;
}

/**
 * Build the service over any store. All mutations are serialized on a
 * promise chain so rapid taps can never interleave (the storage/store.ts
 * write-protocol pattern).
 */
export function createSongStories(store: SongStoriesStore): SongStoriesService {
  let chain: Promise<unknown> = Promise.resolve();
  const serialized = <T>(job: () => Promise<T>): Promise<T> => {
    const run = chain.then(job, job);
    chain = run.catch(() => undefined);
    return run;
  };

  return {
    async setStory(recordingKey, text, now) {
      const clean = sanitizeStoryText(text);
      if (!recordingKey || !clean) return null;
      return serialized(async () => {
        const existing = await store.getStory(recordingKey);
        const story: SongStory = {
          recordingKey,
          text: clean,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        await store.upsertStory(story);
        // LRU (by updatedAt): evict the oldest-touched rows beyond cap.
        // v5.0.1 FIX-B5: the eviction loop now CONSUMES a deletion per
        // non-inserted victim (the memoryTags counted-deletion pattern).
        // The old loop iterated `excess` times and merely SKIPPED the
        // just-saved row — under a backwards wall clock the fresh row
        // sorts among the oldest, the skip consumed an iteration without
        // a deletion, and the cap could rest at cap+1.
        const all = await store.allStories();
        if (all.length > STORIES.cap) {
          const ordered = [...all].sort((a, b) => a.updatedAt - b.updatedAt);
          let excess = all.length - STORIES.cap;
          for (let i = 0; excess > 0 && i < ordered.length; i++) {
            const victim = ordered[i];
            if (!victim || victim.recordingKey === recordingKey) continue; // never the row just written
            await store.deleteStory(victim.recordingKey);
            excess -= 1; // a skip is not a deletion — only a real one counts
          }
        }
        return story;
      });
    },

    async getStory(recordingKey) {
      if (!recordingKey) return null;
      try {
        return await store.getStory(recordingKey);
      } catch {
        return null;
      }
    },

    async removeStory(recordingKey) {
      if (!recordingKey) return false;
      return serialized(async () => {
        const existing = await store.getStory(recordingKey);
        await store.deleteStory(recordingKey);
        return !!existing;
      });
    },

    async listStories() {
      try {
        const all = await store.allStories();
        return all.sort((a, b) => b.updatedAt - a.updatedAt);
      } catch {
        return [];
      }
    },

    async count() {
      try {
        return (await store.allStories()).length;
      } catch {
        return 0;
      }
    },
  };
}
