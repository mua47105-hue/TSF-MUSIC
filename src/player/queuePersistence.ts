/**
 * QUEUE PERSISTENCE (WAVE A · A4) — the playback queue survives an app
 * kill. The queue + the active row ride AsyncStorage under
 * `tsf.queue.v1`; the next cold boot restores them BEFORE the first
 * paint (async, off the critical path), so the queue sheet shows the
 * same room the listener left — and play resumes at the SAME SONG, not
 * at a random one.
 *
 * LAWS:
 *  - House rule 14: streamUrl/url/localUri/encryptedUrl are stripped
 *    BEFORE persisting (defense-in-depth: stripped AGAIN on load).
 *    A persisted URL is an IP-bound, time-limited lie — tap-time
 *    resolution re-answers through the existing ladders.
 *  - Caps (QUEUE_PERSIST): 50 tracks stored as a window around the
 *    active row (order preserved), 24h freshness TTL, 500ms debounced
 *    writes (a burst of mutations costs one write).
 *  - An EMPTY queue is never persisted: a queue dies with honor or not
    at all — a cold boot must never read emptiness over a good queue.
 *  - The engine stays quiet on restore: the React queue mirrors the
 *    saved rows (the sheet is honest), playback starts only when the
 *    listener presses play — via the provider's restored-active-index
 *    handoff, never by faking a playing state.
 *  - Pure core over injected deps (getRaw/setRaw/now + timers): the
 *    round-trip is lockable without a device, production injects
 *    AsyncStorage (lazy-required — never on the boot import graph).
 */

import { QUEUE_PERSIST } from '../ai/core/constants';
import type { Track } from '../types';

export const QUEUE_KEY = 'tsf.queue.v1';

export interface QueuePersistenceDeps {
  getRaw(key: string): Promise<string | null>;
  setRaw(key: string, value: string): Promise<void>;
  now(): number;
}

/** What one persisted queue looks like on disk. */
export interface PersistedQueue {
  savedAt: number;
  /** The id of the row that was ACTIVE when the app died (restore target). */
  activeId: string | null;
  tracks: Track[];
}

export interface LoadedQueue {
  tracks: Track[];
  activeId: string | null;
  savedAt: number;
}

/** The transient stream fields a queue row must never carry to disk. */
const STREAM_FIELDS = ['streamUrl', 'url', 'localUri', 'encryptedUrl'] as const;

/** Strip every transient stream field from one row (house rule 14). */
export function stripForPersistence(t: Track): Track {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(t as unknown as Record<string, unknown>)) {
    if ((STREAM_FIELDS as readonly string[]).includes(k)) continue;
    out[k] = v;
  }
  return out as unknown as Track;
}

/**
 * The cap law: at most QUEUE_PERSIST.maxTracks rows, stored as a window
 * AROUND the active row (order preserved) — QUEUE_PERSIST.activeBackfill
 * rows of rewind context, then the active row and as much UPCOMING as
 * the cap allows (the cap is a MAXIMUM: at a queue's tail the window is
 * honestly shorter). If the active row cannot be found, the window
 * starts at 0 — the first cap rows, honestly.
 */
export function sanitizeQueue(
  queue: Track[],
  activeId: string | null,
): PersistedQueue['tracks'] {
  const cap = QUEUE_PERSIST.maxTracks;
  if (queue.length <= cap) return queue.map(stripForPersistence);
  const activeIdx = activeId ? queue.findIndex((t) => t.id === activeId) : -1;
  const start = Math.max(0, activeIdx - QUEUE_PERSIST.activeBackfill);
  return queue.slice(start, start + cap).map(stripForPersistence);
}

/** Save (sanitize + persist). An empty queue is an honest no-op. */
export async function saveQueue(
  deps: QueuePersistenceDeps,
  queue: Track[],
  activeId: string | null,
): Promise<void> {
  if (!queue.length) return;
  const payload: PersistedQueue = {
    savedAt: deps.now(),
    activeId: activeId ?? null,
    tracks: sanitizeQueue(queue, activeId),
  };
  await deps.setRaw(QUEUE_KEY, JSON.stringify(payload));
}

/**
 * Load the persisted queue — null on miss, a row that is not shaped
 * like a queue, staleness (> QUEUE_PERSIST.ttlMs), or storage failure.
 * Stream fields are stripped AGAIN here: whatever wrote this payload,
 * the restore never sees a transient URL (defense in depth).
 */
export async function loadQueue(deps: QueuePersistenceDeps): Promise<LoadedQueue | null> {
  let raw: string | null = null;
  try {
    raw = await deps.getRaw(QUEUE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: PersistedQueue | null = null;
  try {
    parsed = JSON.parse(raw) as PersistedQueue;
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.tracks)) return null;
  if (typeof parsed.savedAt !== 'number') return null;
  if (deps.now() - parsed.savedAt > QUEUE_PERSIST.ttlMs) return null; // yesterday's queue is not a promise
  const tracks = parsed.tracks
    .filter((t) => t && typeof t.id === 'string' && typeof t.title === 'string' && typeof t.artist === 'string')
    .map(stripForPersistence);
  if (!tracks.length) return null;
  const activeId =
    parsed.activeId && tracks.some((t) => t.id === parsed!.activeId) ? parsed.activeId : null;
  return { tracks, activeId, savedAt: parsed.savedAt };
}

export interface QueueSaver {
  /** Debounced save — a mutation burst coalesces into one write. */
  save(queue: Track[], activeId: string | null): void;
  /** Write NOW (the pending burst, if any) — the shutdown/b latch. */
  flush(): Promise<void>;
  cancel(): void;
}

/**
 * The 500ms debounce. Timers are injected so the coalescing law is
 * testable without a real clock: the tests drive the tick by hand.
 */
export function createQueueSaver(
  deps: QueuePersistenceDeps,
  options?: {
    debounceMs?: number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
  },
): QueueSaver {
  const debounceMs = options?.debounceMs ?? QUEUE_PERSIST.debounceMs;
  const setTimer = options?.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options?.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let handle: unknown = null;
  let pending: { queue: Track[]; activeId: string | null } | null = null;
  return {
    save(queue, activeId) {
      pending = { queue, activeId };
      if (handle != null) return; // a burst only re-arms nothing — the pending row IS the latest truth
      handle = setTimer(() => {
        handle = null;
        const p = pending;
        pending = null;
        if (p) void saveQueue(deps, p.queue, p.activeId).catch(() => undefined);
      }, debounceMs);
    },
    async flush() {
      if (handle != null) {
        clearTimer(handle);
        handle = null;
      }
      const p = pending;
      pending = null;
      if (p) await saveQueue(deps, p.queue, p.activeId).catch(() => undefined);
    },
    cancel() {
      if (handle != null) {
        clearTimer(handle);
        handle = null;
      }
      pending = null;
    },
  };
}

/** Production deps — AsyncStorage, required LAZILY (never on the boot
 *  import graph; the player imports this module at boot, the PACKAGE
 *  only loads at first save/load). */
export function makeAsyncStorageDeps(): QueuePersistenceDeps {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AsyncStorage = require('@react-native-async-storage/async-storage').default;
  return {
    getRaw: (key) => AsyncStorage.getItem(key),
    setRaw: (key, value) => AsyncStorage.setItem(key, value),
    now: () => Date.now(),
  };
}
