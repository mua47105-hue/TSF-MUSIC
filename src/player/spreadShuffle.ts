/**
 * V5.3.0 BAR 2 — ARTIST-SPREAD SHUFFLE (the weighted-interleave order).
 *
 * Port of the validated clean-room reconstruction of Spotify's spreading
 * shuffle (investigation 05 §5.5 [T2/T3]; reconstruction stats: 10,000
 * runs — same-artist adjacency 0.00% vs 13.89% Fisher–Yates baseline,
 * mean artist gap 5.98 ≈ ideal 5.0). Spotify's own history: the original
 * Fisher–Yates shuffle drew artist-clustering complaints (the birthday
 * paradox is PERCEIVED as a bug), so the product moved to a spreading
 * model. This module is that model, distilled to a pure function.
 *
 * THE ALGORITHM (two stages):
 *   1. Group by primary artist; Fisher–Yates INSIDE each group (the
 *      intra-artist order is still random).
 *   2. Greedy weighted interleave ACROSS groups. Per-pick weight of a
 *      group:
 *          weight = turnsSinceLastPick × remainingInGroup × jitter
 *      where jitter ∈ [0.5, 1.5) — urgency grows with how long the
 *      artist has been silent AND how many of its tracks still must fit
 *      into the remaining slots (ideal spacing law: a group holding k of
 *      R remaining tracks should surface every ~R/k slots).
 *
 * DETERMINISM (house law ⑤): the ONLY randomness flows from the injected
 * rng — never Math.random(). The caller seeds mulberry32 (via the
 * mindbeat facade's re-export).
 *
 * PURITY: same multiset in, same multiset out (a strict permutation);
 * empty in ⇒ empty out; the caller owns pinning (e.g. the playing track
 * stays at index 0 and is NOT passed here).
 */

/** The slice of Track the spread math is allowed to read. */
export interface SpreadTrackInput {
  id: string;
  artist: string;
}

/** Normalized grouping key — the primary artist of a credit string. */
function artistGroupKey(artist: string): string {
  const first = String(artist ?? '').split(/,|&/)[0]?.trim() ?? '';
  return first.toLowerCase().replace(/\s+/g, ' ');
}

function fisherYatesInPlace<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/**
 * The spread shuffle. `rng` MUST be a seeded stream (mulberry32) — the
 * reconstruction's contract, and ours.
 */
export function spreadShuffle<T extends SpreadTrackInput>(
  tracks: T[],
  rng: () => number,
): T[] {
  if (tracks.length === 0) return [];

  // 1. group by primary artist + Fisher–Yates inside each group
  const groups = new Map<string, T[]>();
  for (const t of tracks) {
    const key = artistGroupKey(t.artist) || '\u0000unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }
  for (const g of groups.values()) fisherYatesInPlace(g, rng);

  const remaining = new Map(groups);
  const lastPickTurn = new Map<string, number>();
  const out: T[] = [];
  const total = tracks.length;

  // 2. weighted interleave with jitter (urgency = silence × demand)
  for (let turn = 0; turn < total; turn++) {
    let bestKey: string | null = null;
    let bestWeight = -1;
    for (const [artist, group] of remaining) {
      if (group.length === 0) continue;
      // never-picked groups count silence since playlist start (lastPick = -1)
      const since = turn - (lastPickTurn.get(artist) ?? -1);
      const jitter = 0.5 + rng(); // ×0.5..×1.5 multiplicative dither
      const weight = since * group.length * jitter;
      if (weight > bestWeight) {
        bestWeight = weight;
        bestKey = artist;
      }
    }
    const pickGroup = remaining.get(bestKey!)!;
    const track = pickGroup.shift()!;
    if (pickGroup.length === 0) remaining.delete(bestKey!);
    lastPickTurn.set(bestKey!, turn);
    out.push(track);
  }
  return out;
}

/**
 * The seeded rng the player layer uses for one shuffle invocation:
 * mulberry32(hash32(queue ids + a coarse time bucket)). Two taps inside
 * the same 1024 ms bucket produce the SAME order (deterministic within a
 * gesture), the next bucket reshuffles — the jitter stays dithered to
 * humans without ever touching Math.random().
 */
export function shuffleSeedFor(ids: string[], epochMs: number, hash32: (s: string) => number): number {
  return hash32(`${ids.join(',')}|${Math.floor(epochMs / 1024)}`);
}
