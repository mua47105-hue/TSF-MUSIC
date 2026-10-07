/**
 * IMAGE PREWARM (MAGNUM OPUS F3) — warm the next queue rows' album art
 * through RN's Image.prefetch so the next transition paints art, not
 * placeholders.
 *
 * Same gate family as F1 prewarm: offline never; data saver ⇒ WiFi
 * only; otherwise the next IMAGE_PREWARM.ahead rows. The PURE function
 * returns the exact URI list; the runtime side only adds the LRU
 * already-done set and the native call.
 *
 * Honest limitations (stated, not hidden):
 *  - RN Image.prefetch cannot be cancelled — "cancel on queue change"
 *    is implemented as: stale URIs are simply never RE-warmed, and the
 *    native fetch is bounded by the image cache itself. No JS work
 *    survives a queue change.
 *  - the runtime network answer is 'unknown' (no NetInfo dep — potato
 *    rule ⑯); with the data saver ON nothing prefetches. See the
 *    NETWORK note in src/player/prewarm.ts (same rationale).
 *  - never blocks anything: the prefetch is fired void, off the hot
 *    path, and the LRU is O(ahead).
 */

import type { Track } from '../types';
import { IMAGE_PREWARM } from '../ai/core/constants';
import { dataSaverActive } from './audioQuality';
import type { NetworkKind } from './prewarm';

// ── PURE CONTRACT ───────────────────────────────────────────────────────

/**
 * The URIs to prefetch: the next IMAGE_PREWARM.ahead queue rows' unique,
 * non-empty artwork URIs. THE BAR: queue of 10 → exactly the next 5;
 * offline → none; dataSaver+cellular → none; dataSaver+WiFi → 5.
 */
export function imagePrefetchUris(
  queue: Track[],
  currentIndex: number,
  dataSaver: boolean,
  networkType: NetworkKind,
): string[] {
  if (networkType === 'none') return [];
  if (dataSaver && networkType !== 'wifi') return [];
  if (currentIndex < 0 || currentIndex >= queue.length) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = currentIndex + 1; i < queue.length && out.length < IMAGE_PREWARM.ahead; i++) {
    const uri = queue[i]?.artwork;
    if (!uri || seen.has(uri)) continue; // no art → nothing to warm; dupes once
    seen.add(uri);
    out.push(uri);
  }
  return out;
}

// ── RUNTIME ─────────────────────────────────────────────────────────────

interface DoneEntry {
  at: number;
}
const done = new Map<string, DoneEntry>(); // URI → warmed-at (insertion-ordered LRU)

function evictIfNeeded(): void {
  while (done.size >= IMAGE_PREWARM.cap) {
    const oldest = done.keys().next().value;
    if (oldest === undefined) break;
    done.delete(oldest);
  }
}

type Prefetcher = (uri: string) => Promise<boolean>;
let injectedPrefetcher: Prefetcher | null = null; // tests only

function nativePrefetch(uri: string): Promise<boolean> {
  // LAZY require (not a static import): the headless service and bun
  // tests can load this module without instantiating RN's Image; the
  // first real call resolves it. react-native-web implements
  // Image.prefetch; a missing implementation degrades to a no-op, never
  // a crash.
  try {
    const { Image } = require('react-native');
    const fn = (Image as unknown as { prefetch?: Prefetcher } | undefined)?.prefetch;
    if (typeof fn !== 'function') return Promise.resolve(false);
    return fn.call(Image, uri).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

/**
 * Warm the upcoming rows' art. Fire-and-forget; idempotent per URI
 * inside IMAGE_PREWARM.ttlMs. The prime key mirrors F1: only an active
 * track CHANGE re-issues work (a seek never re-warms). `now` is
 * injectable so the TTL re-issue contract is lockable (blind-critic
 * M9: without this lock the freshness check was theatre).
 */
let primedForId = '';
export function primeImagePrewarm(queue: Track[], activeIndex: number, now: number = Date.now()): void {
  const active = queue[activeIndex];
  if (!active || active.id === primedForId) return;
  primedForId = active.id;
  const uris = imagePrefetchUris(queue, activeIndex, dataSaverActive(), 'unknown');
  const prefetch = injectedPrefetcher ?? nativePrefetch;
  for (const uri of uris) {
    const hit = done.get(uri);
    if (hit) {
      if (now - hit.at <= IMAGE_PREWARM.ttlMs) continue; // still warm
      done.delete(uri);
    }
    evictIfNeeded();
    done.set(uri, { at: now });
    void prefetch(uri); // never awaited — never blocks the JS thread
  }
}

export function imagePrewarmSize(): number {
  return done.size;
}

/** Test hooks. */
export function setImagePrefetcherForTests(fn: Prefetcher | null): void {
  injectedPrefetcher = fn;
}
export function resetImagePrewarmForTests(): void {
  done.clear();
  primedForId = '';
  injectedPrefetcher = null;
}
