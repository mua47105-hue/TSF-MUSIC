/**
 * TAG-OVERLAP SIMILARITY (Phase 6 — "sounds like").
 *
 * Every track gets a lazy tag vector of FIVE dimensions:
 *
 *     artist (normalized primary) · genre · language · era bucket ·
 *     mood label (from the proxy feature space)
 *
 * The inverted index (tag → tracks) is built ONLY over the candidate
 * pool the caller already assembled — 60–120 rows, never the world
 * (potato rule ⑧). Scoring: the weighted sum of SHARED dimensions,
 * where the artist dimension is DOWN-WEIGHTED (0.3×) — the point is
 * sound-ALIKE, not same-artist clones. A row must share ≥2 dimensions
 * to be eligible at all (the SOUND_ALIKE truth condition).
 *
 * Pure + deterministic: same pool, same seed → same list.
 */

import { SIMILARITY } from './constants';
import { estimateFeatures } from './features';
import { moodLabel } from './profile';
import { eraOf } from './time';
import type { Track } from '../../types';

export type TagDim = 'artist' | 'genre' | 'language' | 'era' | 'mood';

export interface TagVector {
  artist: string;
  genre?: string;
  language?: string;
  era?: string;
  mood: string;
}

/** The primary artist of a possibly comma-joined credit string. */
export function primaryArtistOf(artist: string): string {
  const first = String(artist ?? '').split(/,|&/)[0]?.trim() ?? '';
  return first.toLowerCase().replace(/\s+/g, ' ');
}

/** The lazy tag vector for one track (all lookups local + instant). */
export function tagVectorOf(track: Track): TagVector {
  const feats = estimateFeatures({ artist: track.artist, title: track.title, album: track.album });
  return {
    artist: primaryArtistOf(track.artist),
    genre: track.genre?.toLowerCase().trim() || undefined,
    language: track.language?.toLowerCase().trim() || undefined,
    era: track.year ? eraOf(track.year) : undefined,
    mood: moodLabel(feats.energy, feats.valence),
  };
}

/**
 * Shared tag weights (law ③ lives in constants — artistTagWeight is the
 * down-weight that stops same-artist clones from winning on artist alone).
 */
function dimWeight(dim: TagDim): number {
  if (dim === 'artist') return SIMILARITY.artistTagWeight;
  return 1;
}

/** Count + list the shared dimensions between two vectors. */
export function sharedDims(a: TagVector, b: TagVector): TagDim[] {
  const out: TagDim[] = [];
  if (a.artist && b.artist && a.artist === b.artist) out.push('artist');
  if (a.genre && b.genre && a.genre === b.genre) out.push('genre');
  if (a.language && b.language && a.language === b.language) out.push('language');
  if (a.era && b.era && a.era === b.era) out.push('era');
  if (a.mood && b.mood && a.mood === b.mood) out.push('mood');
  return out;
}

export interface SoundAlikePick {
  track: Track;
  score: number;
  dims: TagDim[];
}

/**
 * Rank a bounded candidate pool against the seed. Deterministic: score
 * desc, then per-artist rotation, then title (stable tiebreak).
 * Returns rows with sharedTagDims attached (the engine's SOUND_ALIKE
 * truth condition reads exactly this).
 */
export function rankSoundAlike(
  seedTags: TagVector,
  pool: Array<{ track: Track; tags: TagVector }>,
  count: number,
): SoundAlikePick[] {
  // Inverted index over THIS pool only — tag → candidate indices.
  const index = new Map<string, number[]>();
  const dimOf = (dim: TagDim, t: TagVector): string | undefined =>
    dim === 'artist' ? t.artist : dim === 'genre' ? t.genre : dim === 'language' ? t.language : dim === 'era' ? t.era : t.mood;
  const dims: TagDim[] = ['artist', 'genre', 'language', 'era', 'mood'];
  pool.forEach((c, i) => {
    for (const dim of dims) {
      const val = dimOf(dim, c.tags);
      if (!val) continue;
      const key = `${dim}=${val}`;
      const arr = index.get(key);
      if (arr) arr.push(i);
      else index.set(key, [i]);
    }
  });

  // Seed's posting lists → candidate → shared dims.
  const shared = new Map<number, TagDim[]>();
  for (const dim of dims) {
    const val = dimOf(dim, seedTags);
    if (!val) continue;
    for (const i of index.get(`${dim}=${val}`) ?? []) {
      const arr = shared.get(i);
      if (arr) arr.push(dim);
      else shared.set(i, [dim]);
    }
  }

  const scored: SoundAlikePick[] = [];
  for (const [i, dimsShared] of shared) {
    if (dimsShared.length < SIMILARITY.minSharedTags) continue; // the truth condition
    const score = dimsShared.reduce((s, d) => s + dimWeight(d), 0);
    scored.push({ track: pool[i].track, score, dims: dimsShared });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (a.track.id < b.track.id ? -1 : a.track.id > b.track.id ? 1 : 0),
  );

  // Per-artist cap — one artist can't own the list.
  const perArtist = new Map<string, number>();
  const out: SoundAlikePick[] = [];
  for (const pick of scored) {
    if (out.length >= count) break;
    const artist = primaryArtistOf(pick.track.artist);
    const n = perArtist.get(artist) ?? 0;
    if (n >= SIMILARITY.perArtistCap) continue;
    perArtist.set(artist, n + 1);
    out.push(pick);
  }
  return out;
}
