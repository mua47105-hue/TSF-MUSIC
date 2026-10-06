/**
 * The Proxy Feature Space (§6.4) — "Sonic Signal Synthesis".
 *
 * RN cannot tap the audio buffer, so each track gets an estimated
 * (energy, valence, tempoClass) from a priority chain, stored with a
 * confidence score:
 *
 *   0. THE BAKED TABLE (Phase 2) — real Spotify audio features for the
 *      world's hottest tracks; confidence 0.8, source 'dataset'. Loaded
 *      lazily after first frame; a miss falls through silently.
 *   1. Cultural priors (artist → genre → defaults)   — bulk, instant
 *   2. Metadata heuristics (title rules)             — instant
 *   3. Behavioral calibration                        — observed outcomes
 *      pull the estimate toward what actually happens. Against cultural
 *      priors it converges over time; against the baked table it is
 *      CAPPED at ±0.05 (BAR 2.2 — ground truth must not be overridden
 *      by a night-listening loop).
 */

import { ARTIST_PRIORS, GENRE_PRIORS, TITLE_RULES } from './priors';
import { CALIBRATION } from './constants';
import { lookupBakedFeatures, bakedToTrackFeatures } from './featureTable';
import { recordingKeyOf } from './bakedKeys';
import { blendLyricValence } from './lyricMood';
import type { TempoClass, TrackFeatures } from './types';
import { clamp } from './time';

const DEFAULT_PRIOR = { energy: 0.5, valence: 0.5, tempo: 'mid' as TempoClass };

/** Phase 5 — the in-memory lyric-delta provider (recordingKey → ±0.25).
 *  mindbeat injects it after the lazy lyric cache hydrates; null before
 *  that (and on any environment without the cache) = zero behavior change. */
type LyricDeltaProvider = (recordingKey: string) => number | null | undefined;
let lyricDeltaProvider: LyricDeltaProvider | null = null;
export function setLyricDeltaProvider(fn: LyricDeltaProvider | null): void {
  lyricDeltaProvider = fn;
}

/** Sources whose estimates are ground-truth-ish (BAR 2.2 calibration cap). */
export function isGroundTruthSource(source: TrackFeatures['source']): boolean {
  return source === 'dataset' || source === 'lyric';
}

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

/**
 * Tier 0+1+2: baked table (when loaded) → prior → title-keyword
 * heuristics. Pure, instant, synchronous. A track the table knows gets
 * dataset confidence 0.8 and NO title-rule nudges (measured truth beats
 * a keyword heuristic); everything else behaves exactly as before.
 */
export function estimateFeatures(input: {
  artist?: string;
  title?: string;
  album?: string;
  genres?: string[];
}): TrackFeatures {
  // Phase 2 rung 0 — the baked knowledge table (null before lazy load).
  const baked = lookupBakedFeatures({ title: input.title, artist: input.artist });
  let out: TrackFeatures;
  if (baked) {
    out = bakedToTrackFeatures(baked);
  } else {
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
    out = {
      energy: clamp(energy, 0, 1),
      valence: clamp(valence, 0, 1),
      tempoClass: tempoFromClass(energy),
      confidence: clamp(prior.confidence + (adjusted ? 0.1 : 0), 0, 0.95),
      source: adjusted ? 'metadata' : prior.source,
    };
  }
  // Phase 5 rung — the lyric-mood nudge (bounded ±0.25, valence only).
  if (lyricDeltaProvider && input.title && input.artist) {
    const key = recordingKeyOf(input.title, input.artist);
    if (key) {
      const delta = lyricDeltaProvider(key);
      if (typeof delta === 'number' && delta !== 0) out = blendLyricValence(out, delta);
    }
  }
  return out;
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
 *
 * BAR 2.2: against ground-truth-ish sources ('dataset' | 'lyric') the
 * drift is CAPPED at ±0.05 per channel — a track the Spotify table calls
 * valence-0.2 cannot be re-estimated to 0.8 just because the user kept
 * finishing it at night. The feedback loop dies here.
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
  let energy = clamp(base.energy * (1 - evidence) + obsEnergy * evidence, 0, 1);
  // Valence calibration is gentler — completion says "it worked", not "it's happy".
  let valence = clamp(base.valence * (1 - evidence * 0.4) + (base.valence * 0.6 + obsValence * 0.4) * evidence * 0.4, 0, 1);

  const groundTruth = isGroundTruthSource(base.source);
  if (groundTruth) {
    const cap = CALIBRATION.groundTruthCap;
    energy = clamp(energy, base.energy - cap, base.energy + cap);
    valence = clamp(valence, base.valence - cap, base.valence + cap);
  }

  return {
    energy,
    valence,
    tempoClass: tempoFromClass(energy),
    confidence: trust,
    source: !groundTruth && evidence > 0.3 ? 'calibrated' : base.source,
  };
}
