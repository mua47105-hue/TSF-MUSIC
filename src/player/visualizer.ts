/**
 * PSEUDO-VISUALIZER CORE (MAGNUM OPUS · F11) — the PURE mapping from
 * baked features to motion values.
 *
 * The component (PseudoVisualizer.tsx) starts ONE native-driver Animated
 * loop per bar and never touches JS again; this module computes every
 * number those loops are built from — amplitude, speed, bar scale
 * interpolation — deterministically. NO audio-buffer DSP exists anywhere
 * in this feature: the "energy" is the baked Spotify feature row (or the
 * honest calmest wash when the row is missing) — the app never pretends
 * to hear audio it is not decoding (X8: visualizer × aura — the aura
 * reads the palette, this reads the feature table; they share zero
 * decode work because there IS none).
 *
 * Determinism: Math.sin of elapsedMs is a deterministic wave — no
 * Math.random anywhere (law X4).
 */

import { VISUALIZER } from '../ai/core/constants';
import type { TempoClass } from './haptics';

export interface VisualizerFeatures {
  energy: number;
  valence: number;
  tempoClass: TempoClass;
}

export interface VisualizerSettings {
  /** the OS reduce-motion intent — freezes the frame entirely */
  reducedMotion: boolean;
  /** false = no baked row for this track → the calmest wash */
  hasBakedFeatures: boolean;
}

export interface VisualizerState {
  /** px of vertical travel for every bar */
  amplitude: number;
  /** durations divide by this (>1 = faster) */
  speed: number;
  /** reduced-motion → the component renders ONE frozen frame */
  frozen: boolean;
  /** per-bar phase offsets (deterministic — a fixed even stagger; the
   *  wave field is derived, not randomized) */
  phases: number[];
  /** the valence bias the palette glow leans toward (0..1) */
  valenceBias: number;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * THE MAPPING (pure): features + elapsedMs + settings → motion values.
 *  energy  0 → minAmplitude/minSpeed … 1 → maxAmplitude/maxSpeed
 *  tempo   fast adds VISUALIZER.tempoFastBonus to the speed
 *  valence → the palette bias (the component tints the glow with it)
 *  no features → washAmplitude/washSpeed (the calmest honest fallback)
 *  reduced motion → frozen (amplitude 0, one static frame)
 */
export function visualizerState(
  features: VisualizerFeatures | null,
  elapsedMs: number,
  settings: VisualizerSettings,
): VisualizerState {
  const phases = Array.from({ length: VISUALIZER.barCount }, (_, i) => i / VISUALIZER.barCount);
  // the deterministic breathing wave — one period per bar stagger, so a
  // re-configured loop (track change) re-lands on a different-looking
  // but still deterministic frame
  const wave = 0.5 + 0.5 * Math.sin(elapsedMs / VISUALIZER.wavePeriodMs);

  if (settings.reducedMotion) {
    return { amplitude: 0, speed: 0, frozen: true, phases, valenceBias: features ? clamp01(features.valence) : 0.5 };
  }
  if (!settings.hasBakedFeatures || !features) {
    return { amplitude: VISUALIZER.washAmplitude, speed: VISUALIZER.washSpeed, frozen: false, phases, valenceBias: 0.5 };
  }
  const energy = clamp01(features.energy);
  const amplitude = lerp(
    VISUALIZER.minAmplitude +
      (VISUALIZER.maxAmplitude - VISUALIZER.minAmplitude) * VISUALIZER.breathDepth * wave,
    VISUALIZER.maxAmplitude,
    energy,
  );
  let speed = lerp(VISUALIZER.minSpeed, VISUALIZER.maxSpeed, energy);
  if (features.tempoClass === 'fast') speed += VISUALIZER.tempoFastBonus;
  return { amplitude, speed, frozen: false, phases, valenceBias: clamp01(features.valence) };
}

/**
 * THE BAR TRANSFORM (pure): an Animated.Value 0..1 → the scaleY +
 * bottom-compensating translateY pair. The bar's height is `amplitude`
 * px, anchored to the BOTTOM of its slot; scaleY shrinks it around the
 * center, which lifts the bottom edge by (1 - scale) × amplitude / 2 —
 * translateY pushes it back down EXACTLY that much, so the base never
 * leaves the floor while the motion still rides the native driver.
 */
export function barTransform(
  value: number,
  amplitude: number,
): { scaleY: number; translateY: number } {
  const scale = Math.max(VISUALIZER.minBarScale, Math.min(1, value));
  return { scaleY: scale, translateY: ((1 - scale) * amplitude) / 2 };
}

/** The per-bar loop durations (ms) — up/down strokes of one beat. */
export function barDurations(state: VisualizerState): { upMs: number; downMs: number } {
  const base = VISUALIZER.loopBaseMs / Math.max(VISUALIZER.speedFloor, state.speed);
  return {
    upMs: Math.round(base * VISUALIZER.upStrokeShare),
    downMs: Math.round(base * (1 - VISUALIZER.upStrokeShare)),
  };
}
