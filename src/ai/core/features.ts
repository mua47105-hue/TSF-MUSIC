/**
 * The Proxy Feature Space (§6.4) — "Sonic Signal Synthesis".
 *
 * RN cannot tap the audio buffer, so each track gets an estimated
 * (energy, valence, tempoClass) from a three-source blend, stored with a
 * confidence score:
 *
 *   1. Cultural priors (artist → genre → defaults)   — bulk, instant
 *   2. Metadata heuristics (title rules)             — instant
 *   3. Behavioral calibration                        — observed outcomes
 *      pull the estimate toward what actually happens
 *
 * Behavioral calibration is the secret weapon: if a track with LOW prior
 * energy keeps getting completed at 2am, the night block learns it belongs
 * there. Estimates converge toward the listener's own truth.
 */

import { ARTIST_PRIORS, GENRE_PRIORS, TITLE_RULES } from './priors';
import { FEATURE_TABLE, LYRIC_MOOD } from './constants';
import type { TempoClass, TrackFeatures } from './types';
import { clamp } from './time';
import { lookupBakedFeatures } from './featureTable';
import { lyricDeltaFor } from './lyricMood';

const DEFAULT_PRIOR = { energy: 0.5, valence: 0.5, tempo: 'mid' as TempoClass };

/** Normalize an artist string for prior lookup ("Arijit Singh" / "arijit"). */
function normArtist(artist: string | undefined): string {
  return (artist ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Prior-tier estimate (artist → every genre word → default). */
export function priorEstimate(artist?: string, genres?: string[]): TrackFeatures {
  const a = normArtist(artist);
  let prior = ARTIST_PRIORS[a];
  if (prior) return { energy: prior.energy, valence: prior.valence, tempoClass: prior.tempo, confidence: 0.7, source: 'prior' };

  if (genres?.length) {
    for (const g of genres) {
      const hit = GENRE_PRIORS[g.toLowerCase().trim()];
      if (hit) return { energy: hit.energy, valence: hit.valence, tempoClass: hit.tempo, confidence: 0.5, source: 'prior' };
    }
  }
  return { energy: DEFAULT_PRIOR.energy, valence: DEFAULT_PRIOR.valence, tempoClass: DEFAULT_PRIOR.tempo, confidence: 0.25, source: 'prior' };
}

/** Tier 1+2: prior + title-keyword heuristics. Pure, instant. */
export function estimateFeatures(input: {
  artist?: string;
  title?: string;
  album?: string;
  genres?: string[];
}): TrackFeatures {
  // GENIUS P2 — tier 0: REAL baked audio features. When the recording is in
  // the shipped table, its measured (energy, valence) beats every guess:
  // no title-rule adjustment (the number is not a guess), tempoClass from
  // the real energy, confidence FEATURE_TABLE.confidence, source
  // 'dataset'. Table not loaded / recording absent → null → the legacy
  // path below runs byte-identically to the pre-change engine.
  const baked = lookupBakedFeatures(input.title, input.artist);
  if (baked) {
    return blendLyricValence(
      {
        energy: baked.energy,
        valence: baked.valence,
        tempoClass: tempoFromClass(baked.energy),
        confidence: FEATURE_TABLE.confidence,
        source: 'dataset',
      },
      input,
    );
  }
  const prior = priorEstimate(input.artist, input.genres);
  let energy = prior.energy;
  let valence = prior.valence;
  const text = `${input.title ?? ''} ${input.album ?? ''}`;
  let adjusted = false;
  for (const rule of TITLE_RULES) {
    if (rule.re.test(text)) {
      energy += rule.dEnergy;
      valence += rule.dValence;
      adjusted = true;
    }
  }
  return blendLyricValence(
    {
      energy: clamp(energy, 0, 1),
      valence: clamp(valence, 0, 1),
      tempoClass: tempoFromClass(energy),
      confidence: clamp(prior.confidence + (adjusted ? 0.1 : 0), 0, 0.95),
      source: adjusted ? 'metadata' : prior.source,
    },
    input,
  );
}

/**
 * GENIUS P5 — the lyric-mood blend: VALENCE ONLY, bounded, and only when
 * the recording actually has a stored lyric score. Net shift ≤ ±0.15
 * (0.6 × ±0.25); energy NEVER moves. No stored score → the estimate is
 * returned untouched (byte-identical). Calibration still applies on top
 * afterward and wins over time — lyrics sit BELOW it, as ordered.
 */
function blendLyricValence(f: TrackFeatures, input: { title?: string; artist?: string }): TrackFeatures {
  const delta = lyricDeltaFor(input.title, input.artist);
  if (delta == null || delta === 0) return f;
  return { ...f, valence: clamp(f.valence + LYRIC_MOOD.blendWeight * delta, 0, 1) };
}

export function tempoFromClass(energy: number): TempoClass {
  if (energy < 0.35) return 'slow';
  if (energy < 0.65) return 'mid';
  return 'fast';
}

/**
 * Tier 3: behavioral calibration. Pull the estimate toward the observed
 * completion-weighted energy of the contexts where the track actually
 * worked. Weight grows with evidence (never fully trusts the prior after
 * ~6 graded listens).
 */
export function calibrate(
  base: TrackFeatures,
  observations: Array<{ energy: number; completion: number }>,
): TrackFeatures {
  if (!observations.length) return base;
  const totalW = observations.reduce((s, o) => s + o.completion, 0);
  if (totalW <= 0.001) return base;
  const obsEnergy = observations.reduce((s, o) => s + o.energy * o.completion, 0) / totalW;
  const obsValence = observations.reduce((s, o) => s + (o.completion >= 0.75 ? 1 : 0), 0) / observations.length;
  const evidence = clamp(observations.length / 6, 0, 1);
  const trust = clamp(base.confidence * (1 - evidence) + 0.85 * evidence, 0, 1);
  const energy = clamp(base.energy * (1 - evidence) + obsEnergy * evidence, 0, 1);
  // Valence calibration is gentler — completion says "it worked", not "it's happy".
  const valence = clamp(base.valence * (1 - evidence * 0.4) + (base.valence * 0.6 + obsValence * 0.4) * evidence * 0.4, 0, 1);
  return {
    energy,
    valence,
    tempoClass: tempoFromClass(energy),
    confidence: trust,
    source: evidence > 0.3 ? 'calibrated' : base.source,
  };
}
