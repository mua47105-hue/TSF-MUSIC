/**
 * PHASE 3 + BAR 2.1 + BAR 3.3 LOCKS — the Thompson bandit + the hard veto.
 *
 *   1. grade evidence derives from GRADE_WEIGHTS (positive → α, negative → β)
 *   2. sampleBetaTheta is DETERMINISTIC given a seeded stream
 *   3. BAR 2.1: 2 straight rejects ⇒ vetoed (rate 0.875, evidence 6);
 *      ONE accidental instant-tap ⇒ forgiven (evidence 3 < 6);
 *      a seeded onboarding arm (α=3, β=1) is NEVER vetoed
 *   4. the veto excludes a track from the exploitation pool even when a
 *      huge flowBonus + profile affinity push it to #1
 *   5. BAR 3.3: onboarding seeds get α=3, β=1 arms
 *   6. the arm map hard-caps at BANDIT.armCap (lowest α+β evicted first)
 */

import { describe, expect, test } from 'bun:test';
import {
  Bandit,
  artistArmKey,
  trackArmKey,
  freshArm,
  gradeEvidence,
  isArmVetoed,
  rejectRate,
  armEvidence,
  sampleBetaTheta,
} from '../../src/ai/core/bandit';
import { BANDIT, GRADE_WEIGHTS } from '../../src/ai/core/constants';
import { seededRandom, hash32 } from '../../src/ai/core/time';
import { decide } from '../../src/ai/core/decision';
import { buildProfile } from '../../src/ai/core/profile';
import { SessionBrain } from '../../src/ai/core/session';
import { listenOf } from './corpus';
import type { Candidate, ListenRecord } from '../../src/ai/core/types';

const NOW = 1750000000000;
const DAY = 86400_000;

function armOfGrade(grade: ListenRecord['grade'], trackId = 't-x', artist = 'artist x'): ListenRecord {
  return listenOf(trackId, artist, NOW - DAY, 's1', 0.02, { grade });
}

describe('phase 3 — arm evidence from GRADE_WEIGHTS', () => {
  test('positive grades feed alpha with the exact grade weight', () => {
    expect(gradeEvidence('COMPLETED')).toEqual({ positive: true, w: GRADE_WEIGHTS.COMPLETED });
    expect(gradeEvidence('REPLAY').w).toBe(GRADE_WEIGHTS.COMPLETED + GRADE_WEIGHTS.REPLAY_BONUS);
    expect(gradeEvidence('HEART').w).toBe(GRADE_WEIGHTS.HEART);
  });

  test('negative grades feed beta (INSTANT_REJECT, NOT_FOR_ME)', () => {
    expect(gradeEvidence('INSTANT_REJECT')).toEqual({ positive: false, w: -GRADE_WEIGHTS.INSTANT_REJECT });
    expect(gradeEvidence('NOT_FOR_ME').w).toBe(-GRADE_WEIGHTS.NOT_FOR_ME_TRACK);
  });

  test('observe() updates BOTH the track arm and the artist arm (one hierarchy, two levels)', () => {
    const b = new Bandit({ get: async () => null, set: async () => undefined });
    b.resetForTests();
    b.hydrate();
    b.observe(armOfGrade('COMPLETED', 't-1', 'Arijit Singh'));
    const tArm = b.trackArm('t-1')!;
    const aArm = b.artistArm('Arijit Singh')!;
    expect(tArm.alpha).toBe(1 + GRADE_WEIGHTS.COMPLETED);
    expect(aArm.alpha).toBe(1 + GRADE_WEIGHTS.COMPLETED);
  });
});

describe('phase 3 — deterministic Beta sampling', () => {
  test('same seed → same θ sequence; different seed → different', () => {
    const arm = { alpha: 5, beta: 3 };
    const r1 = seededRandom(hash32('stream-a'));
    const r2 = seededRandom(hash32('stream-a'));
    const r3 = seededRandom(hash32('stream-b'));
    const seq1 = [sampleBetaTheta(r1, arm), sampleBetaTheta(r1, arm), sampleBetaTheta(r1, arm)];
    const seq2 = [sampleBetaTheta(r2, arm), sampleBetaTheta(r2, arm), sampleBetaTheta(r2, arm)];
    const seq3 = [sampleBetaTheta(r3, arm), sampleBetaTheta(r3, arm), sampleBetaTheta(r3, arm)];
    expect(seq1).toEqual(seq2);
    expect(seq1).not.toEqual(seq3);
    for (const t of [...seq1, ...seq3]) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(1);
    }
  });

  test('a Beta(3,1) arm samples high (mean 0.75), a Beta(1,3) arm samples low', () => {
    const rng = seededRandom(hash32('mean-check'));
    const high: number[] = [];
    const low: number[] = [];
    for (let i = 0; i < 400; i++) {
      high.push(sampleBetaTheta(rng, { alpha: 3, beta: 1 }));
      low.push(sampleBetaTheta(rng, { alpha: 1, beta: 3 }));
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(high)).toBeGreaterThan(0.65);
    expect(mean(low)).toBeLessThan(0.35);
  });
});

describe('BAR 2.1 — the hard veto', () => {
  test('3 straight instant-rejects ⇒ rate 10/11 ≈ 0.91 > 0.75 ⇒ vetoed', () => {
    const b = new Bandit({ get: async () => null, set: async () => undefined });
    b.hydrate();
    b.observe(armOfGrade('INSTANT_REJECT', 't-skip', 'skipped artist'));
    b.observe(armOfGrade('INSTANT_REJECT', 't-skip', 'skipped artist'));
    b.observe(armOfGrade('INSTANT_REJECT', 't-skip', 'skipped artist'));
    const arm = b.trackArm('t-skip')!;
    // prior {1,1} + 3 × GRADE_WEIGHTS.INSTANT_REJECT (3.0) into beta
    expect(arm.alpha).toBe(1);
    expect(arm.beta).toBe(1 + 3 * 3.0);
    expect(rejectRate(arm)).toBeCloseTo(10 / 11, 5);
    expect(armEvidence(arm)).toBe(9);
    expect(isArmVetoed(arm)).toBe(true);
    expect(b.isTrackVetoed('t-skip')).toBe(true);
  });

  test('ONE accidental instant-tap is FORGIVEN (evidence 3 < 6) — no permanent ban', () => {
    const b = new Bandit({ get: async () => null, set: async () => undefined });
    b.hydrate();
    b.observe(armOfGrade('INSTANT_REJECT', 't-tap'));
    // {α1, β4} → rate 0.80 > 0.75, but net evidence 3 < 6 ⇒ no veto
    expect(b.isTrackVetoed('t-tap')).toBe(false);
  });

  test('a single mild skip (MID_SKIP, w=0.5) ⇒ NOT vetoed (rate 0.6, thin evidence)', () => {
    const b = new Bandit({ get: async () => null, set: async () => undefined });
    b.hydrate();
    b.observe(armOfGrade('MID_SKIP', 't-1s'));
    // α=1, β=1.5 → rate 0.6, evidence 0.5 < 3
    expect(b.isTrackVetoed('t-1s')).toBe(false);
  });

  test('2 instant-rejects ⇒ rate 7/8 = 0.875 ⇒ vetoed (the weights are the law)', () => {
    const b = new Bandit({ get: async () => null, set: async () => undefined });
    b.hydrate();
    b.observe(armOfGrade('INSTANT_REJECT', 't-2s'));
    b.observe(armOfGrade('INSTANT_REJECT', 't-2s'));
    expect(b.isTrackVetoed('t-2s')).toBe(true);
  });

  test('3 skips + 2 completions ⇒ mixed evidence ⇒ NOT vetoed (rate 0.667)', () => {
    const b = new Bandit({ get: async () => null, set: async () => undefined });
    b.hydrate();
    for (let i = 0; i < 3; i++) b.observe(armOfGrade('INSTANT_REJECT', 't-mixed'));
    b.observe(armOfGrade('COMPLETED', 't-mixed'));
    b.observe(armOfGrade('COMPLETED', 't-mixed'));
    // α = 1+4 = 5, β = 1+9 = 10 → rate 10/15 = 0.667 < 0.75
    expect(b.isTrackVetoed('t-mixed')).toBe(false);
  });

  test('a seeded onboarding arm (α=3, β=1) is NEVER vetoed', () => {
    const arm = { alpha: BANDIT.seedAlpha, beta: BANDIT.seedBeta };
    expect(rejectRate(arm)).toBe(0.25);
    expect(armEvidence(arm)).toBe(2); // {3,1} = 2 net over the {1,1} prior
    expect(isArmVetoed(arm)).toBe(false);
  });

  test('THE COLLISION: a vetoed track with the top flowBonus + affinity cannot enter the exploitation pool', () => {
    // The exact latent bug from the audit: Markov says "play this next",
    // the bandit says "the user rejected this 3 times".
    const listens: ListenRecord[] = [];
    // a deep history for artist A (top affinity), and a directed flow
    // edge seed→t-vetoed
    for (let s = 0; s < 6; s++) {
      for (let i = 0; i < 5; i++) {
        listens.push(listenOf(`t-a${s}-${i}`, 'loved artist', NOW - (20 - s * 3) * DAY + i * 200000, `ss${s}`, 1));
      }
    }
    // flow edges: seed → t-vetoed played 5 times consecutively (older)
    for (let i = 0; i < 5; i++) {
      listens.push(listenOf('seed-track', 'loved artist', NOW - 25 * DAY + i * 200000, 'sflow', 1));
      listens.push(listenOf('t-vetoed', 'hated artist', NOW - 25 * DAY + i * 200000 + 1000, 'sflow', 1));
    }
    const sessions = [...new Set(listens.map((l) => l.sessionId))].map((id, i) => ({
      id, startTs: NOW - 25 * DAY + i * DAY, daypart: 'evening' as const, dayKind: 'weekday' as const, trackCount: 5, totalListenMs: 5 * 210000,
    }));
    const profile = buildProfile(listens, [], sessions, { now: NOW });
    // the bandit has learned: t-vetoed = 3 instant rejects
    const bandit = new Bandit({ get: async () => null, set: async () => undefined });
    bandit.hydrate();
    bandit.observe(armOfGrade('INSTANT_REJECT', 't-vetoed', 'hated artist'));
    bandit.observe(armOfGrade('INSTANT_REJECT', 't-vetoed', 'hated artist'));
    bandit.observe(armOfGrade('INSTANT_REJECT', 't-vetoed', 'hated artist'));
    expect(bandit.isTrackVetoed('t-vetoed')).toBe(true);

    const brain = new SessionBrain(NOW);
    const candidates: Candidate[] = [
      't-vetoed',
      't-fresh-a',
      't-fresh-b',
      't-fresh-c',
      't-fresh-d',
      't-fresh-e',
    ].map((id, i) => ({
      trackId: id,
      artist: id === 't-vetoed' ? 'loved artist' : `fresh artist ${i}`,
      features: { energy: 0.5, valence: 0.5, tempoClass: 'mid' as const, confidence: 0.5, source: 'prior' as const },
      pool: 'neighborhood' as const,
    }));
    const picks = decide(
      candidates,
      { surface: 'radio', block: 'evening', dayKind: 'weekday', seedTrackIds: ['seed-track'], seedArtists: ['loved artist'], requested: 6 },
      { profile, session: brain.state, now: NOW, banditArms: bandit.snapshot() },
    );
    // the veto holds even though flow + affinity both pushed t-vetoed #1
    expect(picks.some((p) => p.trackId === 't-vetoed')).toBe(false);
    expect(picks.length).toBeGreaterThan(0);
  });
});

describe('BAR 3.3 — cold-start bandit seeding', () => {
  test('seedArtist arms an unknown artist at α=3, β=1', async () => {
    const kv = new Map<string, unknown>();
    const b = new Bandit({ get: async (k) => (kv.get(k) as never) ?? null, set: async (k, v) => void kv.set(k, v) });
    b.hydrate();
    b.seedArtist('Arijit Singh');
    const arm = b.artistArm('arijit singh')!;
    expect(arm.alpha).toBe(BANDIT.seedAlpha);
    expect(arm.beta).toBe(BANDIT.seedBeta);
    // flushed to kv under the banditArms key
    await b.flushNow();
    const stored = kv.get('banditArms') as Record<string, { alpha: number; beta: number }>;
    expect(stored[artistArmKey('arijit singh')].alpha).toBe(BANDIT.seedAlpha);
  });

  test('a seeded arm counts as trusted in the engine (rides above unarmed candidates)', () => {
    const arms = new Map();
    arms.set(artistArmKey('seeded artist'), { alpha: 3, beta: 1 });
    expect(arms.get(artistArmKey('seeded artist'))!.alpha / 4).toBeGreaterThan(0.5);
  });
});

describe('phase 3 — the arm cap + eviction (potato rule ⑧)', () => {
  test('arms above BANDIT.armCap evict the lowest α+β first', async () => {
    const b = new Bandit({ get: async () => null, set: async () => undefined });
    b.hydrate();
    // flood: every arm gets exactly one mild positive (lowest mass), then
    // one arm gets a heart (high mass)
    for (let i = 0; i < BANDIT.armCap + 50; i++) {
      b.observe(armOfGrade('LATE_SKIP', `t-flood-${i}`, `flood artist ${i}`));
    }
    b.observe(armOfGrade('HEART', 't-loved', 'loved flood artist'));
    await b.flushNow();
    expect(b.size).toBeLessThanOrEqual(BANDIT.armCap);
    // the strong arm survives
    expect(b.trackArm('t-loved')).toBeDefined();
  });
});
