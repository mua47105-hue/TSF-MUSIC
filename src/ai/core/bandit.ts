/**
 * GENIUS P3 — THOMPSON SAMPLING BANDIT (§ per-item learn/try).
 *
 * One Beta arm per trackId. Positive grades feed alpha (the arm is good),
 * hard negatives feed beta (the arm is bad) — weights derived from the
 * EXISTING GRADE_WEIGHTS table (no new magic numbers: the magnitudes are
 * the engine's own evidence scale). Sampling uses the SEEDED mulberry32
 * PRNG with a Joehnk beta-variate sampler — determinism is a house
 * invariant, so no Math.random() anywhere.
 *
 * The engine's use is a bounded additive term: score += BANDIT.weight ·
 * (Beta(alpha,beta) − 0.5). A cold arm {1,1} samples ~U(0,1) → the term
 * centers on 0 (exploration budget stays the authority for novelty — the
 * bandit only REFINES: repeated skips quietly sink a track's score,
 * repeated completions quietly raise it).
 *
 * Potato-phone contract: ≤ BANDIT.maxArms arms persisted under kv
 * 'banditArms' (mb.-prefixed by the facade), evicting the lowest
 * alpha+beta (least-learned-about); compacting on the same first-open-
 * of-day schedule the ledger uses.
 */

import { BANDIT, GRADE_WEIGHTS } from './constants';
import { hash32, seededRandom } from './time';

export interface BanditArm {
  alpha: number;
  beta: number;
}

/** trackId → arm. The persisted shape IS a plain record (kv JSON). */
export type BanditArms = Record<string, BanditArm>;

/** Positive grades → alpha; weight = |GRADE_WEIGHTS| (existing evidence scale). */
const ALPHA_GRADES: Partial<Record<string, number>> = {
  COMPLETED: Math.abs(GRADE_WEIGHTS.COMPLETED), // 2.0
  REPLAY: Math.abs(GRADE_WEIGHTS.COMPLETED + GRADE_WEIGHTS.REPLAY_BONUS), // 3.0
  HEART: Math.abs(GRADE_WEIGHTS.HEART), // 4.0
  DOWNLOAD: Math.abs(GRADE_WEIGHTS.DOWNLOAD), // 2.5
};

/** Hard negatives → beta. Ambiguous skips (MID/LATE) count as NEITHER —
 *  a mid-skip is "not now", not "never" (the skip profiles own that). */
const BETA_GRADES: Partial<Record<string, number>> = {
  INSTANT_REJECT: Math.abs(GRADE_WEIGHTS.INSTANT_REJECT), // 3.0
  EARLY_SKIP: Math.abs(GRADE_WEIGHTS.EARLY_SKIP), // 1.5
  NOT_FOR_ME: Math.abs(GRADE_WEIGHTS.NOT_FOR_ME_TRACK), // 4.0
};

export function emptyArms(): BanditArms {
  return {};
}

/** Arm for a trackId — cold arms start {1,1} and are only PERSISTED once
 *  they learn something (keeps the table free of never-played entries). */
export function armFor(arms: BanditArms, trackId: string): BanditArm {
  return arms[trackId] ?? { alpha: 1, beta: 1 };
}

/**
 * Fold a graded listen into the arms. Returns the (possibly new) arms
 * record. Muted artists NEVER become arms (an explicit correction must
 * not be second-guessed by a counter). Cold/unknown grades are no-ops.
 */
export function updateArms(
  arms: BanditArms,
  trackId: string,
  grade: string,
  mutedArtists: ReadonlySet<string>,
  artistKey: string,
): BanditArms {
  if (!trackId || mutedArtists.has(artistKey)) return arms;
  const alphaW = ALPHA_GRADES[grade];
  const betaW = BETA_GRADES[grade];
  if (alphaW == null && betaW == null) return arms;
  const arm = arms[trackId] ?? { alpha: 1, beta: 1 };
  if (alphaW != null) arm.alpha += alphaW;
  if (betaW != null) arm.beta += betaW;
  arms[trackId] = arm;
  return capArms(arms);
}

/** Hard cap + eviction of the least-learned arms (house rule 8). */
export function capArms(arms: BanditArms): BanditArms {
  const ids = Object.keys(arms);
  if (ids.length <= BANDIT.maxArms) return arms;
  ids.sort((a, b) => {
    const wa = arms[a].alpha + arms[a].beta;
    const wb = arms[b].alpha + arms[b].beta;
    if (wa !== wb) return wa - wb;
    return a < b ? -1 : 1; // deterministic tiebreak
  });
  const evict = new Set(ids.slice(0, ids.length - BANDIT.maxArms));
  for (const id of evict) delete arms[id];
  return arms;
}

/**
 * One Thompson draw for an arm — Joehnk's method on the seeded PRNG.
 * alpha,beta ≥ 1 (arms start {1,1} and only grow), so no corner cases.
 * Same seed → same draw → same ordering (replay-test law).
 */
export function sampleBeta(seed: number, alpha: number, beta: number): number {
  const rng = seededRandom(seed);
  for (let attempt = 0; attempt < 64; attempt++) {
    const u = Math.max(rng(), 1e-12);
    const v = Math.max(rng(), 1e-12);
    const x = Math.pow(u, 1 / alpha);
    const y = Math.pow(v, 1 / beta);
    if (x + y <= 1) return x / (x + y);
  }
  // Theoretically unreachable for α,β ≥ 1 within 64 attempts; a stable
  // deterministic fallback keeps the contract unbreakable anyway.
  return alpha / (alpha + beta);
}

/** The engine's additive term for one candidate (0 for cold arms ≈ center). */
export function banditTerm(arms: BanditArms | null, trackId: string, seed: number): number {
  if (!arms || !trackId) return 0;
  const arm = arms[trackId];
  if (!arm) return 0; // never-touched tracks: no bandit opinion at all
  const draw = sampleBeta(seed, arm.alpha, arm.beta);
  return BANDIT.weight * (draw - 0.5);
}

/** Deterministic per-candidate seed derivation — the engine's own FNV-1a
 *  hash32 over surface|track|profile stamp (same primitive the engine's
 *  exploration PRNG uses; no second implementation). */
export function armSeed(surface: string, trackId: string, builtAt: number): number {
  return hash32(`${surface}|${trackId}|${builtAt}`);
}
