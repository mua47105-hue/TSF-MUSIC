/**
 * MOOD JOURNEY (MAGNUM OPUS · F14) — "take me from anxious to calm".
 *
 * planMoodPath is the PURE heart: count slots stepping from `from` to
 * `to`, each step bounded to MOOD_JOURNEY.maxStep (±0.15) per axis.
 * The walk is LINEAR with the bound applied per slot — monotonic drift,
 * never a zig-zag, never a jump the wrist cannot feel as gradual.
 *
 * The facade (mindbeat.moodJourney) sources candidates through the
 * injected CatalogApi (the same CATALOG door every surface uses),
 * scores them through the existing proxy feature space
 * (estimateFeatures), applies reconcileRecordings at the merge point,
 * respects the kill switch (silent []), and SKIPS slots the catalog
 * cannot fill — honest absence, never fabricated nostalgia (law ⑰).
 */

import { MOOD_JOURNEY } from './core/constants';

export interface MoodPoint {
  energy: number; // 0..1
  valence: number; // 0..1
}

export interface MoodSlot {
  energy: number;
  valence: number;
  /** 1-based slot index (for the honest UI when a slot is skipped) */
  slot: number;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
const stepToward = (from: number, to: number): number => {
  const d = to - from;
  if (Math.abs(d) <= MOOD_JOURNEY.maxStep) return clamp01(to);
  return clamp01(from + Math.sign(d) * MOOD_JOURNEY.maxStep);
};

/**
 * THE WALK (pure): `count` slots from `from` toward `to`, each slot at
 * most maxStep away from the previous position per axis. count 0 → [];
 * count 1 → a single slot already bounded from `from`.
 */
export function planMoodPath(from: MoodPoint, to: MoodPoint, count: number): MoodSlot[] {
  const n = Math.max(0, Math.floor(count));
  if (!n) return [];
  const out: MoodSlot[] = [];
  let energy = clamp01(from.energy);
  let valence = clamp01(from.valence);
  for (let i = 1; i <= n; i++) {
    // each slot moves one bounded step toward the target — when the
    // target is closer than the bound, the slot LANDS on it
    energy = stepToward(energy, to.energy);
    valence = stepToward(valence, to.valence);
    out.push({ energy, valence, slot: i });
  }
  return out;
}

/** Distance in the (energy, valence) proxy space (both axes weighted). */
export function moodDistance(a: MoodPoint, b: MoodPoint): number {
  const de = a.energy - b.energy;
  const dv = a.valence - b.valence;
  return Math.sqrt(de * de + dv * dv);
}

/**
 * THE MATCHER (pure): assign candidates to slots greedily — each slot
 * (in order) takes its nearest unused candidate. A slot with no
 * candidate left within MOOD_JOURNEY.maxCandidateDistance is SKIPPED
 * (the facade renders honest absence for it). Returns one track per
 * filled slot, in slot order.
 */
export function assignSlots<T extends { id: string }>(
  slots: MoodSlot[],
  candidates: T[],
  featureOf: (t: T) => MoodPoint,
): { picks: Array<{ slot: MoodSlot; track: T }>; skippedSlots: number[] } {
  const used = new Set<string>();
  const picks: Array<{ slot: MoodSlot; track: T }> = [];
  const skippedSlots: number[] = [];
  for (const slot of slots) {
    let best: T | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const c of candidates) {
      if (used.has(c.id)) continue;
      const d = moodDistance(slot, featureOf(c));
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    if (best && bestDist <= MOOD_JOURNEY.maxCandidateDistance) {
      used.add(best.id);
      picks.push({ slot, track: best });
    } else {
      skippedSlots.push(slot.slot);
    }
  }
  return { picks, skippedSlots };
}
