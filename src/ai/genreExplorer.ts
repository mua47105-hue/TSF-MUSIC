/**
 * GENRE EXPLORER CORE (MAGNUM OPUS · F19) — the seeded bubble map.
 *
 * genreMapLayout(genres, seed) is DETERMINISTIC: same genres + same
 * seed → the same map on every device, every run (law X4). The PRNG is
 * a mulberry32 (32-bit state, no Math.random anywhere); placement is
 * rejection-free stratified scatter + a fixed number of relaxation
 * passes that push overlapping bubbles apart (deterministic — the pass
 * order and the push math are pure arithmetic).
 *
 * Data: the genre taxonomy comes from GENRE_PRIORS (the same 26-genre
 * taxonomy the feature estimator uses — HONEST NOTE: the repo's baked
 * feature table carries no genre column, so there is no second data
 * source to blend; the priors ARE the app's genre truth). Bubble size
 * scales with the prior's energy; nothing here reads the network.
 */

import { GENRE_EXPLORER } from './core/constants';
import { GENRE_PRIORS } from './core/priors';

export interface GenreBubble {
  genre: string;
  x: number; // map units (0..GENRE_EXPLORER.space)
  y: number;
  radius: number;
  energy: number;
  valence: number;
}

/** mulberry32 — a tiny, fully deterministic seeded PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

/**
 * THE MAP (pure). `genres` = the genre keys to place (defaults to the
 * GENRE_PRIORS taxonomy); the same set + seed always yields the same
 * bubbles. radius scales with the prior's energy; positions scatter by
 * the seed and relax apart for GENRE_EXPLORER.relaxPasses passes.
 */
export function genreMapLayout(
  genres: string[] | null,
  seed: number,
): Map<string, GenreBubble> {
  const keys = (genres && genres.length ? genres : Object.keys(GENRE_PRIORS)).filter(Boolean);
  const rand = mulberry32(seed);
  const space = GENRE_EXPLORER.space;

  // stratified scatter: each bubble gets its own grid cell (jittered),
  // so the map starts readable even before relaxation
  const cols = Math.ceil(Math.sqrt(keys.length));
  const cell = space / cols;
  const bubbles: GenreBubble[] = keys.map((g, i) => {
    const prior = GENRE_PRIORS[g] ?? { energy: 0.5, valence: 0.5, tempo: 'mid' as const };
    const cx = (i % cols) * cell + cell / 2;
    const cy = Math.floor(i / cols) * cell + cell / 2;
    const radius =
      GENRE_EXPLORER.minRadius +
      (GENRE_EXPLORER.maxRadius - GENRE_EXPLORER.minRadius) * clamp01(prior.energy);
    return {
      genre: g,
      x: Math.min(space - radius, Math.max(radius, cx + (rand() - 0.5) * cell * 0.6)),
      y: Math.min(space - radius, Math.max(radius, cy + (rand() - 0.5) * cell * 0.6)),
      radius,
      energy: prior.energy,
      valence: prior.valence,
    };
  });

  // deterministic relaxation: pairs pushed apart along their center line
  for (let pass = 0; pass < GENRE_EXPLORER.relaxPasses; pass++) {
    for (let i = 0; i < bubbles.length; i++) {
      for (let j = i + 1; j < bubbles.length; j++) {
        const a = bubbles[i];
        const b = bubbles[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.001; // never divide by zero
        const overlap = a.radius + b.radius + GENRE_EXPLORER.relaxGap - dist;
        if (overlap > 0) {
          const push = overlap / 2;
          const ux = dx / dist;
          const uy = dy / dist;
          a.x = Math.max(a.radius, Math.min(space - a.radius, a.x - ux * push));
          a.y = Math.max(a.radius, Math.min(space - a.radius, a.y - uy * push));
          b.x = Math.max(b.radius, Math.min(space - b.radius, b.x + ux * push));
          b.y = Math.max(b.radius, Math.min(space - b.radius, b.y + uy * push));
        }
      }
    }
  }

  return new Map(bubbles.map((b) => [b.genre, b]));
}

/** The pan/zoom view transform (pure): a tap point back onto the map. */
export function mapToScreen(
  bubble: { x: number; y: number; radius: number },
  zoom: number,
  panX: number,
  panY: number,
  viewport: number,
): { left: number; top: number; size: number } {
  const size = (bubble.radius * 2 * zoom * viewport) / GENRE_EXPLORER.space;
  const left = (bubble.x - bubble.radius) * zoom * (viewport / GENRE_EXPLORER.space) + panX;
  const top = (bubble.y - bubble.radius) * zoom * (viewport / GENRE_EXPLORER.space) + panY;
  return { left, top, size };
}

/**
 * FIX-D3 — THE ART PROBE CACHE CONTRACT (pure). The screen resolves each
 * genre's artwork once per app run; the auditor caught the NEGATIVE
 * case: a failed / no-art probe was never recorded, so every revisit
 * re-probed the network. A miss is now cached for the same lifetime as
 * a hit — `''` IS the honest "known no art" result, rendered as the ink
 * label the screen already carries.
 */
export function cachedGenreArt(cache: Map<string, string>, genre: string): { uri: string; needsProbe: boolean } {
  if (!cache.has(genre)) return { uri: '', needsProbe: true };
  return { uri: cache.get(genre) ?? '', needsProbe: false };
}

/** Record a probe outcome: the URI on success, '' on a miss (the cached
 * negative). Both live for the module's lifetime — no re-probe. */
export function storeGenreArt(cache: Map<string, string>, genre: string, probe: string | null): void {
  cache.set(genre, probe ?? '');
}
