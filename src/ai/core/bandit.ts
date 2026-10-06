/**
 * THE THOMPSON-SAMPLING BANDIT (Phase 3 — "learn what wins, per track").
 *
 * A contextless Beta-Bernoulli bandit layered UNDER the decision engine:
 * every finalized listen is one arm pull. Positive evidence (completed/
 * hearted/replayed) feeds a Beta-alpha, negative evidence (skips, not-
 * for-me) feeds Beta-beta. The engine draws one θ ~ Beta(α, β) per
 * candidate and adds SCORE_WEIGHTS.bandit × θ — refinement, never
 * ownership (the exploration budget and ε floor are untouched).
 *
 * Determinism (house law ⑤): sampling rides the app's seeded mulberry32
 * PRNG — never Math.random(). Beta variates come from Marsaglia-Tsang
 * gamma pairs with a Box-Muller normal, all off the same seeded stream.
 *
 * Arms (hierarchical, one evidence event feeds both levels of ITS OWN
 * hierarchy — no cross-track contamination):
 *   t:<trackId>    the track's own arm (powers the BAR 2.1 hard veto)
 *   a:<artistKey>  the artist arm (powers ranking + BAR 3.3 seeding)
 *
 * Storage (potato rule ⑧): kv 'banditArms', hard-capped at
 * BANDIT.armCap — the lowest (α+β) arms are evicted first. Hydration is
 * lazy (post-first-frame, never on the cold-start path); updates queue
 * until hydration lands, then flush on a debounce.
 */

import { BANDIT, GRADE_WEIGHTS } from './constants';
import type { ListenRecord } from './types';
import { clamp } from './time';

export interface Arm {
  alpha: number;
  beta: number;
}

export function freshArm(): Arm {
  return { alpha: BANDIT.priorStrength, beta: BANDIT.priorStrength };
}

export function artistArmKey(artist: string): string {
  return `a:${artist.trim().toLowerCase()}`;
}

export function trackArmKey(trackId: string): string {
  return `t:${trackId}`;
}

/**
 * Grade → (positive?, weight) — every weight is DERIVED from
 * GRADE_WEIGHTS (house law ③: no new magic numbers here).
 * HEART_CONTRADICT claws back the heart's alpha as negative evidence.
 */
export function gradeEvidence(grade: ListenRecord['grade']): { positive: boolean; w: number } {
  switch (grade) {
    case 'COMPLETED': return { positive: true, w: GRADE_WEIGHTS.COMPLETED };
    case 'REPLAY': return { positive: true, w: GRADE_WEIGHTS.COMPLETED + GRADE_WEIGHTS.REPLAY_BONUS };
    case 'HEART': return { positive: true, w: GRADE_WEIGHTS.HEART };
    case 'DOWNLOAD': return { positive: true, w: GRADE_WEIGHTS.DOWNLOAD };
    case 'LATE_SKIP': return { positive: true, w: GRADE_WEIGHTS.LATE_SKIP };
    case 'HEART_CONTRADICT': return { positive: false, w: GRADE_WEIGHTS.HEART - GRADE_WEIGHTS.HEART_CONTRADICT };
    case 'MID_SKIP': return { positive: false, w: -GRADE_WEIGHTS.MID_SKIP };
    case 'EARLY_SKIP': return { positive: false, w: -GRADE_WEIGHTS.EARLY_SKIP };
    case 'INSTANT_REJECT': return { positive: false, w: -GRADE_WEIGHTS.INSTANT_REJECT };
    case 'NOT_FOR_ME': return { positive: false, w: -GRADE_WEIGHTS.NOT_FOR_ME_TRACK };
    default: return { positive: false, w: 0 };
  }
}

/** Deterministic Box-Muller normal from a uniform stream. */
function normalFrom(rng: () => number): number {
  const u = Math.max(1e-12, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Deterministic gamma variate (Marsaglia-Tsang), shape > 0. */
function gammaFrom(rng: () => number, shape: number): number {
  if (shape < 1) {
    // Boost: G(shape) = G(shape+1) · U^(1/shape)
    const u = Math.max(1e-12, rng());
    return gammaFrom(rng, shape + 1) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 128; i++) {
    const x = normalFrom(rng);
    const v = Math.pow(1 + c * x, 3);
    if (v <= 0) continue;
    const u = Math.max(1e-12, rng());
    if (Math.log(u) < 0.5 * x * x + d - d * Math.log(v)) return d * v;
  }
  return d; // unreachable in practice; deterministic fallback = mean
}

/**
 * One θ ~ Beta(α, β) draw, fully deterministic given the rng stream.
 * (The Cheng/Joehnk-class direct construction via gamma pairs.)
 */
export function sampleBetaTheta(rng: () => number, arm: Arm): number {
  const { alpha, beta } = arm;
  if (!(alpha > 0) || !(beta > 0)) return 0.5;
  if (alpha === 1 && beta === 1) return rng(); // the uniform prior
  const g1 = gammaFrom(rng, alpha);
  const g2 = gammaFrom(rng, beta);
  const sum = g1 + g2;
  if (sum <= 0) return alpha / (alpha + beta);
  const theta = g1 / sum;
  return clamp(theta, 0, 1);
}

/** BAR 2.1 — reject-rate math for the hard veto. */
export function rejectRate(arm: Arm): number {
  const total = arm.alpha + arm.beta;
  if (total <= 0) return 0;
  return arm.beta / total;
}

/** Net evidence above the prior (α+β−2): how much this arm has LEARNED. */
export function armEvidence(arm: Arm): number {
  return arm.alpha + arm.beta - 2 * BANDIT.priorStrength;
}

/** BAR 2.1 — the hard-veto predicate. */
export function isArmVetoed(arm: Arm): boolean {
  return armEvidence(arm) >= BANDIT.vetoMinEvidence && rejectRate(arm) > BANDIT.vetoRejectRate;
}

export interface BanditKV {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
}

const KV_KEY = 'banditArms';

export class Bandit {
  private arms = new Map<string, Arm>();
  private hydrated = false;
  private pending: ListenRecord[] = [];
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private seedQueue: string[] = [];

  constructor(private kv: BanditKV) {}

  /** Lazy hydration — called AFTER first frame (never in mindbeat.init). */
  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    try {
      const stored = await this.kv.get<Record<string, Arm>>(KV_KEY);
      if (stored) {
        for (const [key, arm] of Object.entries(stored)) {
          if (arm && typeof arm.alpha === 'number' && typeof arm.beta === 'number') {
            this.arms.set(key, { alpha: arm.alpha, beta: arm.beta });
          }
        }
      }
      // BAR 3.3 — onboarding seeds queued before hydration land now.
      for (const artist of this.seedQueue) this.seedArtistNow(artist);
      this.seedQueue = [];
    } catch {
      /* cold kv — fresh arms */
    }
    // Drain the updates that arrived pre-hydration (bounded queue).
    for (const record of this.pending) this.observeNow(record);
    this.pending = [];
    if (this.dirty) void this.scheduleFlush();
  }

  /** BAR 3.3 — pre-seed an onboarding artist's arm: α=3, β=1. */
  seedArtist(artist: string): void {
    if (!artist?.trim()) return;
    if (!this.hydrated) {
      if (this.seedQueue.length < BANDIT.seedQueueCap) this.seedQueue.push(artist);
      return;
    }
    this.seedArtistNow(artist);
  }

  private seedArtistNow(artist: string): void {
    const key = artistArmKey(artist);
    const cur = this.arms.get(key) ?? freshArm();
    // Seeds ADD trust; re-seeding never stacks a farm of alpha.
    if (armEvidence(cur) <= 0) {
      this.arms.set(key, { alpha: BANDIT.seedAlpha, beta: BANDIT.seedBeta });
      this.dirty = true;
    }
  }

  /** Feed one finalized listen (called from ledger finalization). */
  observe(record: ListenRecord): void {
    if (!this.hydrated) {
      if (this.pending.length < BANDIT.pendingCap) this.pending.push(record);
      return;
    }
    this.observeNow(record);
  }

  private observeNow(record: ListenRecord): void {
    const ev = gradeEvidence(record.grade);
    if (!ev.w || !record.trackId || !record.artist) return;
    // Positive evidence feeds α; negative evidence feeds β (same weight
    // magnitude, derived from GRADE_WEIGHTS).
    const alpha = ev.positive ? ev.w : 0;
    const beta = ev.positive ? 0 : ev.w;
    this.bump(trackArmKey(record.trackId), alpha, beta);
    this.bump(artistArmKey(record.artist), alpha, beta);
    this.dirty = true;
  }

  private bump(key: string, dAlpha: number, dBeta: number): void {
    const cur = this.arms.get(key) ?? freshArm();
    cur.alpha += dAlpha;
    cur.beta += dBeta;
    this.arms.set(key, cur);
  }

  arm(key: string): Arm | undefined {
    return this.arms.get(key);
  }

  artistArm(artist: string): Arm | undefined {
    return this.arms.get(artistArmKey(artist));
  }

  trackArm(trackId: string): Arm | undefined {
    return this.arms.get(trackArmKey(trackId));
  }

  /** BAR 2.1 — veto check for a candidate track. */
  isTrackVetoed(trackId: string): boolean {
    const arm = this.arms.get(trackArmKey(trackId));
    return !!arm && isArmVetoed(arm);
  }

  /** The read-only arm map the decision engine scores with. */
  snapshot(): Map<string, Arm> {
    return this.arms;
  }

  get size(): number {
    return this.arms.size;
  }

  /** Debounced kv flush (amortized write rule ⑦). */
  scheduleFlush(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    return new Promise((resolve) => {
      this.flushTimer = setTimeout(async () => {
        this.flushTimer = null;
        await this.flushNow();
        resolve();
      }, BANDIT.flushDebounceMs);
    });
  }

  /** Immediate flush (also the test hook — idempotent). */
  async flushNow(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    this.evictIfNeeded();
    try {
      const out: Record<string, Arm> = {};
      for (const [key, arm] of this.arms) out[key] = { alpha: Math.round(arm.alpha * 100) / 100, beta: Math.round(arm.beta * 100) / 100 };
      await this.kv.set(KV_KEY, out);
    } catch {
      this.dirty = true; // retry on the next flush
    }
  }

  /** Potato rule ⑧ — hard cap with lowest-evidence-first eviction. */
  private evictIfNeeded(): void {
    if (this.arms.size <= BANDIT.armCap) return;
    const entries = [...this.arms.entries()].sort(
      (a, b) => a[1].alpha + a[1].beta - (b[1].alpha + b[1].beta),
    );
    const excess = this.arms.size - BANDIT.armCap;
    for (let i = 0; i < excess; i++) this.arms.delete(entries[i][0]);
  }

  /** Kill switch support: drop pending pre-hydration work + the debounce
   *  timer so a disabled intelligence layer never writes arms after death
   *  (ported from the parallel gauntlet line — writes must respect death). */
  cancelPendingWrites(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pending = [];
    this.seedQueue = [];
    this.dirty = false;
  }

  /** Test/lab hook — drop all state. */
  resetForTests(): void {
    this.arms.clear();
    this.pending = [];
    this.seedQueue = [];
    this.hydrated = false;
    this.dirty = false;
  }
}
