/**
 * THE AURA (THE TEN · FEATURE 9) — the pure motion spec behind the
 * visualizer. The component paints; this module decides: the track's
 * BAKED energy maps to a pulse period + glow range, and the motion mode
 * respects the listener's intents (OS reduce-motion freezes; data saver
 * calms). Pure + clamped — same energy ⇒ same aura, always.
 */

import { AURA } from '../ai/core/constants';

export interface AuraMotion {
  /** Full pulse period in ms (calm songs breathe slowly). */
  pulseMs: number;
  /** Glow opacity the layers breathe between (clamped to [min, max]). */
  minGlow: number;
  maxGlow: number;
}

/**
 * THE MAPPING — pure, clamped, monotonic-ish (higher energy ⇒ faster
 * pulse + brighter glow). energy null/undefined/garbage ⇒ the calmest
 * motion (a track with no baked features gets the deep slow wash, never
 * a random guess).
 */
export function auraMotion(energy: number | null | undefined): AuraMotion {
  const e =
    typeof energy === 'number' && Number.isFinite(energy)
      ? Math.max(0, Math.min(1, energy))
      : 0;
  const span = AURA.slowPulseMs - AURA.fastPulseMs;
  return {
    pulseMs: Math.round(AURA.slowPulseMs - e * span),
    minGlow: AURA.minGlow,
    maxGlow: AURA.minGlow + (AURA.maxGlow - AURA.minGlow) * (0.4 + 0.6 * e),
  };
}

export type AuraMode = 'full' | 'calm' | 'frozen';

/**
 * THE INTENT RESOLVER — OS reduce-motion freezes the aura entirely (a
 * static wash, no loops); data saver calms it (half speed, single
 * pulse — battery first). Both intents can coexist; reduce-motion wins.
 */
export function auraMode(reduceMotion: boolean, dataSaver: boolean): AuraMode {
  if (reduceMotion) return 'frozen';
  if (dataSaver && AURA.dataSaverCalms) return 'calm';
  return 'full';
}
