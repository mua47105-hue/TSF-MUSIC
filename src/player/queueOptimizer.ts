/**
 * SMART QUEUE REORDERING (MAGNUM OPUS · F13) — "Shuffle by Vibe".
 *
 * A greedy nearest-neighbor walk over the UPCOMING queue's energy: from
 * the seed (the playing track's energy), each free slot takes the track
 * whose energy is CLOSEST to the previous pick, ties broken by the
 * track's original index (law X4 determinism — no Math.random).
 *
 * LAWS:
 *  - USER-INITIATED ONLY: the only caller is the queue sheet's button.
 *    Nothing calls this on boot, on playback start, or anywhere the
 *    user did not explicitly press it (never silently overrides an
 *    explicit order).
 *  - PINNED tracks (explicitly queued next / user-arranged) NEVER move:
 *    they keep their exact slots; the free tracks flow around them.
 *  - The step bound is the EXISTING CADENCE.aiMaxEnergyStep (0.25) —
 *    the same energy-neighborhood the AI mix walks. A greedy walk
 *    cannot always satisfy it (the pool may simply be far away), so the
 *    result carries its largest realized step and the UI reports it
 *    honestly instead of pretending the bound held.
 *  - The output is a PERMUTATION: same tracks, same count, no loss
 *    (bar-locked).
 */

import { CADENCE, QUEUE_VIBE } from '../ai/core/constants';

export interface VibeTrack {
  id: string;
}

export interface OptimizeResult<T extends VibeTrack> {
  /** the reordered list (a permutation of the input, pinned in place) */
  order: T[];
  /** the largest consecutive energy step in the RESULT (documented:
   *  may exceed CADENCE.aiMaxEnergyStep when the pool or pinned rows
   *  force it — the UI states this, it does not hide it) */
  largestStep: number;
  /** how many pinned rows kept their slots (the UI can show it) */
  pinnedKept: number;
}

/** Energy lookup with the honest neutral mid for unknown rows. */
export function energyOf(trackId: string, features: Record<string, number>): number {
  const e = features[trackId];
  return typeof e === 'number' && Number.isFinite(e) ? Math.max(0, Math.min(1, e)) : QUEUE_VIBE.missingEnergy;
}

/**
 * optimizeQueueByVibe — THE walk (pure). Seed = seedEnergy (the playing
 * track's energy; callers without one pass the first slot's energy).
 * Pinned rows keep their indices; every free slot greedily takes the
 * nearest-energy remaining track (tie → original index).
 *
 * v5.0.1 FIX-B1 (the auditor's P2): the 0.25 cadence bound is now
 * ENFORCED DURING SELECTION, not merely reported afterwards. The walk
 * skips any candidate whose energy would step more than
 * CADENCE.aiMaxEnergyStep from the previous pick and tries the next in
 * the pool; only when NO remaining candidate fits does it take the
 * best-fit anyway and let `largestStep` report the honest failure (the
 * bound is a preference the pool can deny — a fabricated fit is worse
 * than an admitted miss).
 */
export function optimizeQueueByVibe<T extends { id: string }>(
  tracks: T[],
  features: Record<string, number>,
  pinned: string[],
  seedEnergy?: number,
): OptimizeResult<T> {
  const pinnedSet = new Set(pinned);
  const pinnedKept = tracks.filter((t) => pinnedSet.has(t.id)).length;

  const result: (T | null)[] = new Array(tracks.length).fill(null);
  const remaining: T[] = [];
  tracks.forEach((t, i) => {
    if (pinnedSet.has(t.id)) result[i] = t;
    else remaining.push(t);
  });

  // the walk starts from the seed; with no seed, the mean of the free
  // pool (never a fabricated 0 unless the pool is empty — it cannot be,
  // remaining.length > 0 whenever result has free slots)
  let current =
    typeof seedEnergy === 'number' && Number.isFinite(seedEnergy)
      ? Math.max(0, Math.min(1, seedEnergy))
      : remaining.length
        ? remaining.reduce((s, t) => s + energyOf(t.id, features), 0) / remaining.length
        : QUEUE_VIBE.missingEnergy;

  for (let i = 0; i < result.length; i++) {
    if (result[i]) continue; // a pinned row owns this slot
    if (!remaining.length) break;
    // greedy nearest neighbor, tie → original index (stable: `remaining`
    // is in original order and `<` keeps the first seen)
    let bestIdx = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    let bestWithinBoundIdx = -1;
    let bestWithinBoundDist = Number.POSITIVE_INFINITY;
    for (let j = 0; j < remaining.length; j++) {
      const d = Math.abs(energyOf(remaining[j].id, features) - current);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = j;
      }
      // FIX-B1: a candidate is only ELIGIBLE while the step stays
      // within the cadence bound; the best eligible one wins.
      if (d <= CADENCE.aiMaxEnergyStep + 1e-9 && d < bestWithinBoundDist) {
        bestWithinBoundDist = d;
        bestWithinBoundIdx = j;
      }
    }
    // no candidate fits the bound → take the best-fit anyway (the pool
    // is simply too far); `largestStep` reports the honest miss.
    const picked = remaining.splice(bestWithinBoundIdx >= 0 ? bestWithinBoundIdx : bestIdx, 1)[0];
    result[i] = picked;
    current = energyOf(picked.id, features);
  }

  const order = result.filter((t): t is T => t !== null);
  const walkMax = largestEnergyStep(order, features);
  // v5.0.1 critic P2a: the seed→first-row transition is a REAL step the
  // listener hears — the honest flag must see it. (Without a seed the
  // walk starts from the pool's mean, which is not a transition.) The
  // standalone largestEnergyStep stays order-internal (its own locks).
  const seedStep =
    typeof seedEnergy === 'number' && Number.isFinite(seedEnergy) && order.length
      ? Math.abs(energyOf(order[0].id, features) - Math.max(0, Math.min(1, seedEnergy)))
      : 0;
  return { order, largestStep: Math.round(Math.max(walkMax, seedStep) * 1000) / 1000, pinnedKept };
}

/** The largest consecutive |Δenergy| across an ordered list. */
export function largestEnergyStep<T extends { id: string }>(order: T[], features: Record<string, number>): number {
  let max = 0;
  for (let i = 1; i < order.length; i++) {
    const d = Math.abs(energyOf(order[i].id, features) - energyOf(order[i - 1].id, features));
    if (d > max) max = d;
  }
  return Math.round(max * 1000) / 1000;
}

/** Whether the realized step honors the AI-mix bound (the honest-toast helper). */
export function stepWithinBound(largestStep: number): boolean {
  return largestStep <= CADENCE.aiMaxEnergyStep + 1e-9;
}
