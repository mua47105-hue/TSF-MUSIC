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

// ── V5.3.0 BAR 5 — THE QUANTIZED (E4M3) FEATURE SPACE ───────────────────
// Voyager [T2] quantizes embeddings to 8-bit float E4M3 (4× memory
// reduction at equal recall) — the retrieval layer under Spotify's
// ranking. Our analog: the six baked audio features (energy, valence,
// danceability, acousticness, speechiness, instrumentalness) encoded to
// ONE byte each, cosine over the dequantized grid — pure integer/bit
// math, deterministic, zero allocations on the compare path.

/** float8-E4M3 encode (1 sign · 4 exp bits, bias 7 · 3 mantissa bits).
 *  THIS VARIANT: no NaN reservation — the full grid is numeric, max
 *  normal 0x7f = 2⁸·1.875 = 480 (the [0,1] feature domain never
 *  approaches it; the ±480 entry clamp is defensive). Values on the
 *  grid round-trip losslessly (THE GRID LAW, locked). */
export function quantizeE4M3(v: number): number {
  const x = Math.min(480, Math.max(-480, v));
  // Object.is: −0 must keep its sign bit (code 0x80 round-trips)
  const sign = x < 0 || Object.is(x, -0) ? 0x80 : 0;
  const a = Math.abs(x);
  if (a < 2 ** -9) return sign; // rounds to signed zero
  if (a < 2 ** -6) {
    // subnormal binade: value = (m/8)·2⁻⁶
    const m = Math.round(a / 2 ** -9);
    if (m > 7) return sign | (1 << 3); // rounded up into the normal range
    return sign | m;
  }
  let e = Math.floor(Math.log2(a)) + 7;
  if (e > 15) return sign | 0x7f; // clamp at the max normal (480)
  let m = Math.round((a / 2 ** (e - 7) - 1) * 8);
  if (m > 7) {
    e += 1;
    m = 0;
    if (e > 15) return sign | 0x7f;
  }
  return sign | (e << 3) | m;
}

/** float8-E4M3 decode — exact: every grid value is a dyadic rational. */
export function dequantizeE4M3(code: number): number {
  const sign = code & 0x80 ? -1 : 1;
  const e = (code >> 3) & 0x0f;
  const m = code & 0x07;
  if (e === 0) return sign * (m / 8) * 2 ** -6; // subnormal (0 when m=0)
  return sign * 2 ** (e - 7) * (1 + m / 8);
}

/** The quantized six-feature vector [e, v, d, a, s, i], one E4M3 byte
 *  per dim. null when ANY column is absent — the caller's no-op
 *  contract (the v5.2.1 tag-only ordering, byte-identical). */
export function quantizedFeatureVector(
  baked: { e?: number; v?: number; d?: number; a?: number; s?: number; i?: number },
): number[] | null {
  const { e, v, d, a, s, i } = baked;
  if (
    typeof a !== 'number' || typeof s !== 'number' || typeof i !== 'number' ||
    typeof e !== 'number' || typeof v !== 'number' || typeof d !== 'number' ||
    !Number.isFinite(e) || !Number.isFinite(v) || !Number.isFinite(d) ||
    !Number.isFinite(a) || !Number.isFinite(s) || !Number.isFinite(i)
  ) {
    return null;
  }
  return [
    quantizeE4M3(e),
    quantizeE4M3(v),
    quantizeE4M3(d),
    quantizeE4M3(a),
    quantizeE4M3(s),
    quantizeE4M3(i),
  ];
}

/** Cosine similarity over two quantized vectors (dequantize-then-dot —
 *  deterministic; 0 when either norm is 0). */
export function quantizedCosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = dequantizeE4M3(a[i]);
    const y = dequantizeE4M3(b[i]);
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / Math.sqrt(na * nb);
}

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

/** A candidate row for ranking: the track, its tag vector, and (BAR 5,
 *  optional) its quantized feature vector — present ONLY when the
 *  baked row carries all six columns. */
export interface SoundAlikeCandidate {
  track: Track;
  tags: TagVector;
  qvec?: number[];
}

/**
 * Rank a bounded candidate pool against the seed. Deterministic: score
 * desc, then (BAR 5) the quantized-cosine tie-break when BOTH the seed
 * and the candidate carry a qvec — the retrieval-stage geometry breaks
 * tag-score ties toward the seed's feature space — then title (stable
 * tiebreak, the v5.2.1 order when qvecs are absent).
 * Returns rows with sharedTagDims attached (the engine's SOUND_ALIKE
 * truth condition reads exactly this).
 */
export function rankSoundAlike(
  seedTags: TagVector,
  pool: Array<SoundAlikeCandidate | { track: Track; tags: TagVector }>,
  count: number,
  seedQvec?: number[],
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

  // BAR 5 — the quantized-cosine tie-break map (candidate index →
  // cosine to the seed; only when both sides carry a qvec).
  const cos = new Map<number, number>();
  if (seedQvec) {
    pool.forEach((c, i) => {
      const q = (c as SoundAlikeCandidate).qvec;
      if (Array.isArray(q) && q.length === seedQvec.length) {
        cos.set(i, quantizedCosine(seedQvec, q));
      }
    });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (() => {
        // tag-score tie: the quantized feature space breaks it (both
        // rows must have a cosine; otherwise fall through to id).
        const ia = pool.findIndex((p) => p.track.id === a.track.id);
        const ib = pool.findIndex((p) => p.track.id === b.track.id);
        const ca = cos.get(ia);
        const cb = cos.get(ib);
        if (ca !== undefined && cb !== undefined && ca !== cb) return cb - ca;
        return 0;
      })() ||
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
