/**
 * GENIUS P6 — TAG-OVERLAP SIMILARITY ("close to this song").
 *
 * Real "songs like this one" WITHOUT audio analysis: songs sharing tags —
 * primary artist, genre (P1 capture), language, era bucket, mood label
 * (from the P2-baked feature space) — are cousins.
 *
 * Potato-phone contract:
 *   • the inverted index (tag → candidates) is built over THE CANDIDATE
 *     POOL ONLY (≤120 rows — the pools are already bounded; never the
 *     whole world) and lives only for the duration of one call
 *   • thin rows with < SIMILARITY.minSharedTags known tags are simply
 *     ineligible as matches — honest degradation for YouTube-only rows
 *   • the artist dimension is DOWN-WEIGHTED and every output artist is
 *     capped, so results are cousins, not same-artist clones
 *
 * Truth: a SOUND_ALIKE claim requires ≥ 2 shared tag dimensions — the
 * reason code carries the count; nothing is ever fabricated.
 */

import { SIMILARITY } from './constants';
import { eraOf } from './time';
import { normalizeArtist, moodLabel } from './profile';
import { primaryArtistOf } from '../../api/recording';
import type { Track } from '../../types';
import { estimateFeatures } from './features';

/** A track's tag vector — one entry per KNOWN dimension (sparse). */
export interface TagVector {
  artist?: string; // normalized primary artist
  genre?: string; // lowercase captured genre
  language?: string; // lowercase catalog language
  era?: string; // era bucket ('2010s', 'current', …)
  mood?: string; // mood label from the feature space ('euphoric', …)
}

export function tagCount(v: TagVector): number {
  return [v.artist, v.genre, v.language, v.era, v.mood].filter(Boolean).length;
}

/** Tag vector of a track from data we ALREADY have (P1 genre + P2 mood). */
export function tagVectorOf(track: Track): TagVector {
  const features = estimateFeatures({
    artist: track.artist,
    title: track.title,
    album: track.album,
    genres: track.genre ? [track.genre] : undefined,
  });
  return {
    artist: normalizeArtist(primaryArtistOf(track)) || undefined,
    genre: track.genre?.toLowerCase().trim() || undefined,
    language: track.language?.toLowerCase().trim() || undefined,
    era: eraOf(track.year),
    mood: moodLabel(features.energy, features.valence),
  };
}

/**
 * Weighted shared-dimension count of seed vs candidate. Returns null when
 * the pair does not qualify (fewer than minSharedTags shared dimensions —
 * a single shared tag is kinship we do not claim).
 */
export function sharedTags(seed: TagVector, cand: TagVector): { count: number; score: number } | null {
  let count = 0;
  let score = 0;
  const add = (a?: string, b?: string, w?: number) => {
    if (a && b && a === b) {
      count += 1;
      score += w!;
    }
  };
  add(seed.genre, cand.genre, SIMILARITY.tagWeights.genre);
  add(seed.mood, cand.mood, SIMILARITY.tagWeights.mood);
  add(seed.language, cand.language, SIMILARITY.tagWeights.language);
  add(seed.era, cand.era, SIMILARITY.tagWeights.era);
  // artist dim DOWN-WEIGHTED (rule: cousins, not clones) — and it counts
  // toward the ≥2 gate, but a pair sharing ONLY the artist never qualifies.
  add(seed.artist, cand.artist, SIMILARITY.tagWeights.artist);
  if (count < SIMILARITY.minSharedTags) return null;
  return { count, score };
}

/**
 * Rank a bounded candidate pool against a seed. The pool is ALWAYS
 * bounded (SIMILARITY.candidatePoolCap — the facade never fetches more),
 * so the overlap scan is linear over ≤120 rows: an inverted index would
 * buy nothing at this size and was removed (critic fix 7 — the shipped
 * mechanism is now exactly what runs). Deterministic: stable sort
 * (score desc, trackId asc), per-artist cap on the output.
 */
export function rankSoundAlike(
  seed: TagVector,
  seedTrackId: string,
  candidates: Track[],
): Array<{ track: Track; shared: number; score: number }> {
  const vectors = new Map<string, TagVector>();
  const eligible: Track[] = [];
  for (const t of candidates) {
    if (t.id === seedTrackId) continue; // the seed never matches itself
    const v = tagVectorOf(t);
    vectors.set(t.id, v);
    if (tagCount(v) < SIMILARITY.minSharedTags) continue; // thin row — honest skip
    eligible.push(t);
  }

  const scored = eligible
    .map((t) => {
      const s = sharedTags(seed, vectors.get(t.id)!);
      return s ? { track: t, shared: s.count, score: s.score } : null;
    })
    .filter((x): x is { track: Track; shared: number; score: number } => x !== null)
    .sort((a, b) => b.score - a.score || (a.track.id < b.track.id ? -1 : 1));

  // Per-artist cap — cousins across the catalog, not a wall of one artist.
  const artistCount = new Map<string, number>();
  const out: Array<{ track: Track; shared: number; score: number }> = [];
  for (const row of scored) {
    const artist = normalizeArtist(primaryArtistOf(row.track));
    const n = artistCount.get(artist) ?? 0;
    if (n >= SIMILARITY.perArtistCap) continue;
    artistCount.set(artist, n + 1);
    out.push(row);
    if (out.length >= SIMILARITY.poolCap) break;
  }
  return out;
}
