/**
 * PREWARM (MAGNUM OPUS F1) — predictive stream-URL resolution.
 *
 * WHEN track N starts, the upcoming N+1/N+2 rows are pushed through the
 * SAME resolution ladder buildPlayable uses (the YouTube client ladder,
 * the saavn rescue for URL-less rows) and the result is parked in a
 * single-use store. Consumers (queue rebuilds, shuffle reorders, smart
 * shuffle heals, the just-in-time recommendation inserts, playNext) get
 * the parked URL instead of paying a fresh resolve.
 *
 * WHY A STORE OF PROMISES (mission spec): a parked Promise dedupes
 * naturally — two primes of the same row share one flight, and a
 * consumer that arrives mid-flight awaits the same work.
 *
 * DISCIPLINE (house rules):
 *  - offline / dataSaver+cellular NEVER prewarms (battery + data first;
 *    the pure contract locks it, the runtime feeds networkType from the
 *    conservative 'unknown' — see NETWORK below).
 *  - parked URLs expire after PREWARM.ttlMs (CDN links carry signed
 *    params that rot) and are SINGLE-USE (take deletes).
 *  - the store is capped (PREWARM.cap, LRU) and reset on queue change.
 *  - a manual seek does not re-prime: priming is keyed on the ACTIVE
 *    track id changing, and seeks don't change it.
 *  - determinism: zero Math.random (nothing here is scored).
 *
 * NETWORK — an honest limitation: this repo has NO NetInfo dependency
 * (adding one for prefetch gating violates potato rule ⑯), so the
 * runtime reports 'unknown'. 'unknown' behaves as NOT-WiFi: with the
 * data saver ON nothing is prewarmed (conservative — a missed
 * optimization, never wasted data); with the saver OFF prewarming rides
 * the same network the audio stream itself uses. The pure contract
 * still locks every bar case (wifi/cellular/none are caller-supplied).
 */

import type { Track } from '../types';
import { PREWARM } from '../ai/core/constants';
import { dataSaverActive } from './audioQuality';
import { resolveStreamUrl, getSongById } from '../api/saavn';
import { ytStreamUrlForTrack } from '../api/youtube';
import { resolveSaavnRow } from './saavnRescue';

export type NetworkKind = 'wifi' | 'cellular' | 'none' | 'unknown';

/** What a resolver parks: a usable URL plus (for rescued saavn rows) the
 *  fresh row itself — buildPlayable needs the row to keep artwork/has320
 *  provenance, not just the URL. */
export interface PrewarmResult {
  url: string;
  row?: Track;
}
export type PrewarmResolver = (track: Track) => Promise<PrewarmResult | null>;

// ── PURE CONTRACT ───────────────────────────────────────────────────────

/**
 * Which queue tracks (by id) should be prewarmed. THE BAR:
 *   offline (networkType 'none')              → []
 *   dataSaver && networkType !== 'wifi'       → []
 *   otherwise                                  → next PREWARM.ahead ids
 */
export function prewarmStrategy(
  queue: Track[],
  currentIndex: number,
  dataSaver: boolean,
  networkType: NetworkKind,
): string[] {
  if (networkType === 'none') return [];
  if (dataSaver && networkType !== 'wifi') return [];
  if (currentIndex < 0 || currentIndex >= queue.length) return [];
  const out: string[] = [];
  for (let i = currentIndex + 1; i < queue.length && out.length < PREWARM.ahead; i++) {
    const t = queue[i];
    if (t && !out.includes(t.id)) out.push(t.id);
  }
  return out;
}

/** True when a row gains value from being parked. YouTube rows ALWAYS
 *  qualify: their googlevideo URLs rot within hours, so a fresh resolve
 *  at track-N start is the point (the YT module's own LRU makes a
 *  just-resolved repeat free — parking never double-spends the network).
 *  Saavn rows qualify only when they cannot resolve synchronously (the
 *  rescue path — ledger/crate rows); an encryptedUrl row decrypts for
 *  free at play time, nothing to park. iTunes previews resolve from the
 *  row itself — nothing to park. */
export function needsPrewarm(t: Track): boolean {
  if (t.localUri) return false; // downloaded — the file is the URL
  if (t.source === 'youtube') return true; // fresh beats stale, every time
  if (t.source === 'saavn') return !resolveStreamUrl(t); // encrypted/preview absent → rescue path
  return false;
}

// ── RUNTIME STORE ───────────────────────────────────────────────────────

interface PrewarmEntry {
  at: number;
  p: Promise<PrewarmResult | null>;
}

const store = new Map<string, PrewarmEntry>(); // insertion-ordered LRU
let primedForId = ''; // the active track the last prime ran for
let injectedResolver: PrewarmResolver | null = null; // tests only

/** The production ladder — the exact pair buildPlayable runs. */
function defaultResolver(t: Track): Promise<PrewarmResult | null> {
  if (t.source === 'youtube') {
    return ytStreamUrlForTrack(t)
      .then((url) => (url ? { url } : null))
      .catch(() => null);
  }
  return resolveSaavnRow(t, getSongById)
    .then((fresh) => {
      const url = fresh ? resolveStreamUrl(fresh) : null;
      return fresh && url ? { url, row: fresh } : null;
    })
    .catch(() => null);
}

/** The runtime's honest network answer — see the header NETWORK note. */
function runtimeNetworkKind(): NetworkKind {
  return 'unknown';
}

function evictIfNeeded(): void {
  while (store.size >= PREWARM.cap) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/**
 * Prime the upcoming tracks. Fire-and-forget safe: the sync part is
 * O(ahead); the resolution itself is async network work that never
 * holds the JS thread. Idempotent per active track — a seek (or any
 * re-render without a track change) is a no-op.
 */
export function primePrewarm(queue: Track[], activeIndex: number): void {
  const active = queue[activeIndex];
  if (!active || active.id === primedForId) return;
  primedForId = active.id;
  const resolver = injectedResolver ?? defaultResolver;
  const ids = prewarmStrategy(queue, activeIndex, dataSaverActive(), runtimeNetworkKind());
  for (const id of ids) {
    if (store.has(id)) continue; // already parked / in flight
    const t = queue.find((q) => q.id === id);
    if (!t || !needsPrewarm(t)) continue;
    evictIfNeeded();
    store.set(id, { at: Date.now(), p: resolver(t) });
  }
}

/**
 * Single-use consume. Returns null when nothing is parked (the caller
 * falls through to its fresh resolve) or when the parked entry has
 * expired (a rotting URL is never handed to the player).
 */
export function takePrewarmed(id: string, now: number = Date.now()): Promise<PrewarmResult | null> | null {
  const e = store.get(id);
  if (!e) return null;
  store.delete(id); // single use, hit or miss
  if (now - e.at > PREWARM.ttlMs) return null;
  return e.p;
}

/** Convenience for buildPlayable: await a parked result (null when absent). */
export async function consumePrewarm(t: Track): Promise<PrewarmResult | null> {
  const p = takePrewarmed(t.id);
  if (!p) return null;
  return p;
}

/** Queue changed → parked URLs and the prime key are obsolete. */
export function resetPrewarm(): void {
  store.clear();
  primedForId = '';
}

/** Test hooks. */
export function prewarmSize(): number {
  return store.size;
}
export function setPrewarmResolverForTests(fn: PrewarmResolver | null): void {
  injectedResolver = fn;
}
export function resetPrewarmForTests(): void {
  resetPrewarm();
  injectedResolver = null;
}
