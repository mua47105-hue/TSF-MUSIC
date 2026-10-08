/**
 * MEMORY TAGS (MAGNUM OPUS · F20 — LITE EDITION) — "tag this moment":
 * a timestamp + note pinned to a recording.
 *
 * THE DEPENDENCY DECISION, HONESTLY: the mission offered (A) full
 * location+photo via expo-location/expo-camera or (B) the LITE version.
 * This is (B), for a verifiable reason: both packages change the
 * NATIVE build (new modules + permission screens), and this mission's
 * environment cannot rebuild/verify an Android APK — shipping
 * unverified native deps would break the verification gates harder
 * than a lite feature. The appcontent schema already carries nullable
 * lat/lng/photoUri columns, so a future full-fat upgrade needs ZERO
 * migration and ZERO data loss. Nothing here pretends: no location is
 * captured, so no location is displayed.
 *
 * LAWS:
 *  - Rows are keyed by recordingKey (portable across providers) with a
 *    deterministic per-second id — re-tagging the same second UPDATES.
 *  - LRU cap 500 by `at` (MEMORY_TAGS.cap — potato rule ⑯).
 *  - Kill switch irrelevant: a memory tag is factual user data (same
 *    posture as stories/bookmarks).
 *  - The schema has no field a stream handle could occupy.
 */

import { MEMORY_TAGS } from '../ai/core/constants';

export interface MemoryTag {
  id: string;
  recordingKey: string;
  /** LITE: always null today — the schema keeps the columns for the
   *  future full-fat version (zero migration when it lands). */
  lat: number | null;
  lng: number | null;
  /** The tagged moment (epoch ms). */
  at: number;
  photoUri: string | null;
  note: string;
}

/** The minimal persistence contract the SQLite adapter fulfills. */
export interface MemoryTagsStore {
  get(id: string): Promise<MemoryTag | null>;
  all(): Promise<MemoryTag[]>;
  put(tag: MemoryTag): Promise<void>;
  del(id: string): Promise<void>;
}

/** Deterministic per-second id: one tag per second per recording. */
export function memoryTagId(recordingKey: string, at: number): string {
  return `${recordingKey}:${Math.max(0, Math.floor(at / 1000))}`;
}

/** Notes: control chars stripped, 3+ newlines collapsed, 240-char cap. */
export function sanitizeMemoryNote(raw: string): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MEMORY_TAGS.maxNoteChars);
}

/** THE PURE ATTACHER: build the row (no store touched — the caller
 *  persists it). Blank notes are an honest no-op (null). */
export function attachMemory(
  recordingKey: string,
  at: number,
  note: string,
): MemoryTag | null {
  const clean = sanitizeMemoryNote(note);
  if (!recordingKey || !clean) return null;
  return {
    id: memoryTagId(recordingKey, at),
    recordingKey,
    lat: null, // LITE — no location is captured, so none is stored
    lng: null,
    at: Math.max(0, Math.floor(at)),
    photoUri: null,
    note: clean,
  };
}

export interface MemoryTagsService {
  /** Attach (or update, same second) a tag; returns the stored row. */
  attach(recordingKey: string, at: number, note: string): Promise<MemoryTag | null>;
  /** Newest-moment first. */
  list(recordingKey?: string): Promise<MemoryTag[]>;
  remove(id: string): Promise<boolean>;
  count(): Promise<number>;
}

export function createMemoryTags(store: MemoryTagsStore): MemoryTagsService {
  let chain: Promise<unknown> = Promise.resolve();
  const serialized = <T>(job: () => Promise<T>): Promise<T> => {
    const run = chain.then(job, job);
    chain = run.catch(() => undefined);
    return run;
  };

  return {
    async attach(recordingKey, at, note) {
      const tag = attachMemory(recordingKey, at, note);
      if (!tag) return null;
      return serialized(async () => {
        const existing = await store.get(tag.id);
        await store.put({
          ...tag,
          at: existing?.at ?? tag.at, // an update keeps the original moment
        });
        // LRU cap by `at`: the oldest-moment tags make room (never the
        // row just saved). Deletions are COUNTED — if the fresh row sat
        // among the excess oldest (a service-level re-tag), the skip
        // must not consume an eviction slot (blind-critic P2: cap+1 rest).
        const all = (await store.all()).sort((a, b) => a.at - b.at);
        let excess = all.length - MEMORY_TAGS.cap;
        for (let i = 0; excess > 0 && i < all.length; i++) {
          if (all[i].id !== tag.id) {
            await store.del(all[i].id);
            excess -= 1;
          }
        }
        // v5.0.1 FIX-D4: return the STORED row — the persisted `at` (an
        // update keeps the ORIGINAL moment) is what the caller must see,
        // never the freshly-built row whose `at` differs on a re-tag.
        return (await store.get(tag.id)) ?? tag;
      });
    },

    async list(recordingKey) {
      try {
        const all = await store.all();
        const mine = recordingKey ? all.filter((t) => t.recordingKey === recordingKey) : all;
        return mine.sort((a, b) => b.at - a.at);
      } catch {
        return [];
      }
    },

    async remove(id) {
      if (!id) return false;
      return serialized(async () => {
        const had = !!(await store.get(id));
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
