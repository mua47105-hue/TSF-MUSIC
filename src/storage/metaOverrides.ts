/**
 * LOCAL METADATA OVERRIDES (THE TEN · FEATURE 5) — the user corrects
 * JioSaavn's wrong titles / artists / albums / artwork LOCALLY, without
 * touching provider data.
 *
 * Keyed by the track's RECORDING KEY (src/api/recording.ts) so
 * re-credited re-listings of the same performance share ONE override —
 * fix "Various Artists" once and every re-listing renders correctly.
 * Overrides live OUTSIDE provider responses, so they survive re-fetches.
 *
 * ARCHITECTURE (deliberate):
 *  - applyMetaOverride(track, overrides) is PURE and is consulted at
 *    RENDER boundaries only (TrackRow, the player header/artwork/share
 *    card, and the TrackMenu header). The queue sheet + MiniPlayer stay
 *    provider-native v1 — the lockscreen and the graded stream must
 *    always agree with what the engine grades. With
 *    no override it returns the SAME object (identity passthrough); with
 *    one it returns a NEW object — the source row is never mutated.
 *  - Playback metadata + the intelligence ledger stay PROVIDER-NATIVE:
 *    the baked feature table and the recording identity are keyed by the
 *    provider's credits, and rewriting the played row would silently
 *    miss those lookups. The correction is a display lens, not a data
 *    rewrite (stated in the editor UI too).
 *  - streamUrl is NEVER persisted here (YouTube URLs are IP-bound and
 *    expire ~6h — house rule ⑩); the value shape has no such field and
 *    saveMetaOverride whitelists exactly the four display fields.
 *  - A module-level sync cache (loaded once at player boot, updated on
 *    every write) powers synchronous render reads — the audioQuality.ts
 *    pattern for hot-path reads. Cap: META_OVERRIDES.cap, LRU by
 *    updatedAt (potato rule ⑧).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { META_OVERRIDES } from '../ai/core/constants';
import { recordingKey } from '../api/recording';
import type { Track } from '../types';

const KEY = 'tsf.metaOverrides.v1';

/** The whitelist — exactly the four display fields + bookkeeping. */
export interface MetaOverride {
  title?: string;
  artist?: string;
  album?: string;
  artwork?: string;
  updatedAt: number;
}

export type MetaOverrideMap = Record<string, MetaOverride>;

let cache: MetaOverrideMap = {};
let loaded = false;
/** Write/book-keeping sequence: a boot read that started BEFORE a write
 *  must never clobber that write when it finally resolves (the save was
 *  newer than the read). */
let writeSeq = 0;
type Listener = () => void;
const listeners = new Set<Listener>();

async function readAll(): Promise<MetaOverrideMap> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as MetaOverrideMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // corrupt payload → honest empty, never a crash
  }
}

async function writeAll(map: MetaOverrideMap): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* storage full — non-fatal */
  }
}

/** One-shot boot read; fire-and-forget safe. A write that lands while
 *  the read is in flight wins (the read is stale by definition). */
export function initMetaOverrides(): void {
  const writesBefore = writeSeq;
  void readAll()
    .then((map) => {
      if (writeSeq !== writesBefore) return; // a write superseded this read
      cache = map;
      loaded = true;
      listeners.forEach((fn) => fn());
    })
    .catch(() => undefined);
}

/** Synchronous render-path read (the cache; empty until boot lands). */
export function getMetaOverridesSync(): MetaOverrideMap {
  return cache;
}

export function subscribeMetaOverrides(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The recording key a track (or its provider row) is addressed by. */
export function metaOverrideKeyFor(track: { title?: string; artist?: string; artistsFull?: string[] }): string {
  return recordingKey(track);
}

/** Whitelist helper — strips everything except the four display fields. */
function sanitizeFields(fields: Partial<MetaOverride>): Partial<MetaOverride> {
  const out: Partial<MetaOverride> = {};
  if (typeof fields.title === 'string' && fields.title.trim()) out.title = fields.title.trim();
  if (typeof fields.artist === 'string' && fields.artist.trim()) out.artist = fields.artist.trim();
  if (typeof fields.album === 'string' && fields.album.trim()) out.album = fields.album.trim();
  if (typeof fields.artwork === 'string' && fields.artwork.trim()) out.artwork = fields.artwork.trim();
  return out;
}

/** Upsert one correction; evicts the LRU tail beyond META_OVERRIDES.cap. */
export async function saveMetaOverride(
  key: string,
  fields: Partial<MetaOverride>,
): Promise<MetaOverrideMap> {
  const clean = sanitizeFields(fields);
  const next: MetaOverrideMap = { ...cache };
  if (Object.keys(clean).length === 0) return next; // nothing whitelisted — no-op
  next[key] = { ...clean, updatedAt: Date.now() } as MetaOverride;
  // LRU eviction (rule ⑧): drop the oldest-updated entries beyond the cap.
  const ids = Object.keys(next);
  if (ids.length > META_OVERRIDES.cap) {
    ids
      .sort((a, b) => (next[a]?.updatedAt ?? 0) - (next[b]?.updatedAt ?? 0))
      .slice(0, ids.length - META_OVERRIDES.cap)
      .forEach((id) => delete next[id]);
  }
  cache = next;
  loaded = true; // a write makes the cache authoritative immediately
  writeSeq += 1;
  listeners.forEach((fn) => fn());
  await writeAll(next);
  return next;
}

/** Remove one correction (the editor's "Reset info"). */
export async function removeMetaOverride(key: string): Promise<void> {
  if (!cache[key]) return;
  const next = { ...cache };
  delete next[key];
  cache = next;
  loaded = true;
  writeSeq += 1;
  listeners.forEach((fn) => fn());
  await writeAll(next);
}

/** Test/lab reset — drops the cache (no storage access). */
export function resetMetaOverridesForTests(): void {
  cache = {};
  loaded = false;
  writeSeq = 0;
  listeners.clear();
}

/** Test helper — force-load the cache from storage (locks use this to
 *  prove the persisted round-trip without a device). */
export async function reloadMetaOverridesForTests(): Promise<void> {
  cache = await readAll();
  loaded = true;
}

/**
 * THE RESOLVER — pure. No override (or no map) ⇒ the SAME track object
 * (identity passthrough — render trees can rely on reference equality).
 * An override ⇒ a NEW object with exactly the corrected fields; the
 * input row is never mutated, and fields the correction doesn't touch
 * pass through untouched.
 */
export function applyMetaOverride<T extends Track>(track: T, overrides: MetaOverrideMap | null | undefined): T {
  // No map ⇒ identity. An UNLOADED cache also passes through — the boot
  // read lands within the first paint; never render a guess.
  if (!overrides || !loaded) return track;
  const o = overrides[metaOverrideKeyFor(track)];
  if (!o) return track;
  return {
    ...track,
    ...(o.title !== undefined ? { title: o.title } : {}),
    ...(o.artist !== undefined ? { artist: o.artist } : {}),
    ...(o.album !== undefined ? { album: o.album } : {}),
    ...(o.artwork !== undefined ? { artwork: o.artwork } : {}),
  };
}
