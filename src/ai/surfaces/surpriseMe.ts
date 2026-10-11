/**
 * SURPRISE ME (Wave C · C3) — the honest escape hatch from the filter
 * bubble. ONE pure function: given the profile, the live session and a
 * candidate pool, pick the ONE track that fits the vibe while coming
 * from somewhere the listener never goes.
 *
 * THE FOUR CONSTRAINTS (all mandatory, all locked):
 *   1. FITS THE VIBE   — energy within ±0.1 of the session's weighted
 *                        mean (sessionEnergyOf; tighter than Smart
 *                        Shuffle's ±0.2 vibe-lock — a surprise, not a
 *                        hijack);
 *   2. RARELY HEARD    — artistAffinity < 0.1 (never-played or
 *                        decayed-to-nothing artists only);
 *   3. BREAKS THE BUBBLE — the track's genre is NOT in the profile's
 *                        top-5 genres (a top-genre pick is not a
 *                        surprise, it's the algorithm again);
 *   4. CLEAN           — filterClean (house rule ⑤ — every algorithmic
 *                        surface gates through the safety filter).
 *
 * DETERMINISM (X5 / house rule ⑩): the pick is a SEEDED mulberry32 —
 * the seed is `${session.id}:${now}` — never Math.random. Same session
 * + same moment → the same pick; the randomness only ranges over the
 * pool of EQUALLY-qualifying candidates.
 *
 * Potato budget (X6): one pass over the pool (≤ ~60 rows), three O(1)
 * checks per row. No network, no recompute.
 */

import { mulberry32 } from '../genreExplorer';
import { artistAffinity, sessionEnergyOf } from '../core/decision';
import { estimateFeatures } from '../core/features';
import { filterClean } from '../../safety';
import type { Track } from '../../types';
import type { SessionState, TasteProfile } from '../core/types';

/** The vibe band: tighter than Smart Shuffle's ±0.2 (ENERGY_TOLERANCE). */
export const SURPRISE_ENERGY_BAND = 0.1;
/** The rarity floor: affinity below this = "rarely played" artist. */
export const SURPRISE_AFFINITY_FLOOR = 0.1;
/** The bubble breaker: the top-N profile genres a surprise must avoid. */
export const SURPRISE_TOP_GENRE_COUNT = 5;

/** Deterministic string hash (xmur3) → 32-bit seed for mulberry32. */
export function hashSeed(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/** The profile's top-N genre names (normalized lowercase). */
export function topGenres(profile: TasteProfile, n: number): string[] {
  return Object.entries(profile.genres)
    .sort((a, b) => b[1].w - a[1].w)
    .slice(0, n)
    .map(([g]) => g.trim().toLowerCase())
    .filter(Boolean);
}

export interface SurpriseOpts {
  /** Overrides Date.now() for the seed (tests inject this). */
  now?: number;
  /** Overrides the whole seed string (tests inject this). */
  seed?: string;
  /** Track ids never to serve (the live queue). */
  excludeIds?: string[];
}

/**
 * Pick ONE surprise track from the catalog pool. Returns null honestly
 * when nothing qualifies — a surprise that lies is worse than none.
 */
export function pickSurprise(
  profile: TasteProfile,
  session: SessionState,
  catalog: Track[],
  opts: SurpriseOpts = {},
): Track | null {
  const now = opts.now ?? Date.now();
  const exclude = new Set(opts.excludeIds ?? []);
  const sessionEnergy = sessionEnergyOf(session);
  const bubble = topGenres(profile, SURPRISE_TOP_GENRE_COUNT);
  const profileHasGenres = bubble.length > 0;

  const clean = filterClean(catalog);
  const qualifying: Track[] = [];
  for (const track of clean) {
    if (exclude.has(track.id)) continue;
    // 1. fits the vibe (estimated energy — the same proxy every surface reads)
    const energy = estimateFeatures({ artist: track.artist, title: track.title, album: track.album }).energy;
    if (Math.abs(energy - sessionEnergy) > SURPRISE_ENERGY_BAND) continue;
    // 2. rarely heard
    if (artistAffinity(profile, track.artist, now) >= SURPRISE_AFFINITY_FLOOR) continue;
    // 3. breaks the bubble (an unknown genre can't be verified to break
    //    it when the profile has genres — skipped honestly; a genre-less
    //    profile passes vacuously)
    const genre = (track.genre ?? '').trim().toLowerCase();
    if (profileHasGenres && (!genre || bubble.includes(genre))) continue;
    qualifying.push(track);
  }

  if (!qualifying.length) return null;
  const seed = opts.seed ?? `${session.id}:${now}`;
  const rand = mulberry32(hashSeed(seed));
  return qualifying[Math.floor(rand() * qualifying.length)] ?? null;
}
