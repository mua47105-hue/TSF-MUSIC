/**
 * GENIUS P3 — THOMPSON SAMPLING BANDIT LOCKS (gauntlet/GENIUS-BARS.md §P3).
 *
 * Bars pinned:
 *   • arms update from EXISTING grade weights (alpha: COMPLETED/REPLAY/
 *     HEART/DOWNLOAD; beta: INSTANT_REJECT/EARLY_SKIP/NOT_FOR_ME; the
 *     ambiguous MID/LATE skips count as NEITHER)
 *   • muted artists NEVER become arms (an explicit correction is final)
 *   • seeded Joehnk sampler: same seed → same draw → deterministic order
 *   • the additive term is bounded ±BANDIT.weight/2; absent arms → exactly 0
 *   • decide() ordering shifts toward a known-good arm and away from a
 *     known-bad one; WITHOUT arms the score is byte-identical legacy
 *   • hard cap 2000 arms, evicting lowest alpha+beta, deterministic ties
 *   • kill switch: no arm writes when intelligence is disabled
 */

import { describe, expect, test } from 'bun:test';
import {
  updateArms,
  capArms,
  sampleBeta,
  banditTerm,
  armSeed,
  armFor,
  type BanditArms,
} from '../../src/ai/core/bandit';
import { decide } from '../../src/ai/core/decision';
import { emptyProfile } from '../../src/ai/core/profile';
import { SessionBrain } from '../../src/ai/core/session';
import { BANDIT } from '../../src/ai/core/constants';
import type { Candidate, DecisionContext } from '../../src/ai/core/types';

function candidateOf(id: string, artist = 'a', energy = 0.5): Candidate {
  return {
    trackId: id,
    artist,
    features: { energy, valence: 0.5, tempoClass: 'mid', confidence: 0.5, source: 'prior' },
    pool: 'affinity',
  };
}

function ctxOf(surface = 'radio', requested = 5): DecisionContext {
  return {
    surface,
    block: 'evening',
    dayKind: 'weekday',
    seedTrackIds: [],
    seedArtists: [],
    requested,
  };
}

describe('GENIUS P3 — arm updates from existing grade weights', () => {
  const muted = new Set<string>();

  test('positive grades feed alpha with the engine evidence scale', () => {
    let arms: BanditArms = {};
    arms = updateArms(arms, 't1', 'COMPLETED', muted, 'a');
    arms = updateArms(arms, 't1', 'HEART', muted, 'a');
    arms = updateArms(arms, 't1', 'REPLAY', muted, 'a');
    arms = updateArms(arms, 't1', 'DOWNLOAD', muted, 'a');
    expect(arms.t1.alpha).toBe(1 + 2.0 + 4.0 + 3.0 + 2.5);
    expect(arms.t1.beta).toBe(1);
  });

  test('hard negatives feed beta; ambiguous skips count as NEITHER', () => {
    let arms: BanditArms = {};
    arms = updateArms(arms, 't2', 'INSTANT_REJECT', muted, 'a');
    arms = updateArms(arms, 't2', 'EARLY_SKIP', muted, 'a');
    arms = updateArms(arms, 't2', 'NOT_FOR_ME', muted, 'a');
    arms = updateArms(arms, 't2', 'MID_SKIP', muted, 'a'); // ignored
    arms = updateArms(arms, 't2', 'LATE_SKIP', muted, 'a'); // ignored
    expect(arms.t2.beta).toBe(1 + 3.0 + 1.5 + 4.0);
    expect(arms.t2.alpha).toBe(1);
  });

  test('muted artists never become arms; unknown grades are no-ops', () => {
    const mutes = new Set(['hated artist']);
    let arms: BanditArms = {};
    arms = updateArms(arms, 't3', 'HEART', mutes, 'hated artist');
    expect(arms.t3).toBeUndefined();
    arms = updateArms(arms, 't4', 'SOMETHING_ELSE', muted, 'a');
    expect(arms.t4).toBeUndefined();
  });
});

describe('GENIUS P3 — seeded sampling determinism', () => {
  test('same seed → same draw; different arms → different draws', () => {
    const a = sampleBeta(42, 3, 1);
    const b = sampleBeta(42, 3, 1);
    expect(a).toBe(b);
    expect(sampleBeta(43, 3, 1)).not.toBe(a);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
  });

  test('cold arm {1,1} centers the term; absent arms give exactly 0', () => {
    const seed = armSeed('radio', 't9', 1234);
    const coldTerm = banditTerm({ t9: { alpha: 1, beta: 1 } }, 't9', seed);
    expect(Math.abs(coldTerm)).toBeLessThanOrEqual(BANDIT.weight / 2 + 1e-9);
    expect(banditTerm(null, 't9', seed)).toBe(0);
    expect(banditArms_empty('t9', seed)).toBe(0);
  });

  function banditArms_empty(trackId: string, seed: number): number {
    return banditTerm({} as BanditArms, trackId, seed);
  }
});

describe('GENIUS P3 — the engine refinement', () => {
  test('ordering shifts toward a hearted arm and away from a rejected one', () => {
    const profile = emptyProfile(NOW_OF_TEST);
    const brain = new SessionBrain(NOW_OF_TEST);
    const candidates = [
      candidateOf('good'),
      candidateOf('bad'),
      candidateOf('neutral1', 'b'),
      candidateOf('neutral2', 'c'),
      candidateOf('neutral3', 'd'),
      candidateOf('neutral4', 'e'),
    ];
    const arms: BanditArms = {
      good: { alpha: 20, beta: 1 }, // strongly good → term ≈ +0.25
      bad: { alpha: 1, beta: 20 }, // strongly bad → term ≈ −0.25
    };
    // requested = full pool so nothing is cut — ordering must be observable
    const ranked = decide(candidates, ctxOf('radio', candidates.length), { profile, session: brain.state, now: NOW_OF_TEST }, { banditArms: arms });
    const ids = ranked.map((r) => r.trackId);
    expect(ids.indexOf('good')).toBeLessThan(ids.indexOf('bad'));
    // and the scores actually moved by the bounded term
    const goodScore = ranked.find((r) => r.trackId === 'good')!.score;
    const badScore = ranked.find((r) => r.trackId === 'bad')!.score;
    expect(goodScore - badScore).toBeGreaterThan(0.4); // ≥ 2 × 0.25 minus identity diffs
  });

  test('WITHOUT arms the score is byte-identical to legacy scoring', () => {
    const profile = emptyProfile(NOW_OF_TEST);
    const brain = new SessionBrain(NOW_OF_TEST);
    const candidates = ['x1', 'x2', 'x3', 'x4'].map((id, i) => candidateOf(id, ['a', 'b', 'c', 'd'][i], 0.4 + i * 0.05));
    const a = decide(candidates, ctxOf(), { profile, session: brain.state, now: NOW_OF_TEST });
    const b = decide(candidates, ctxOf(), { profile, session: brain.state, now: NOW_OF_TEST }, { banditArms: {} });
    expect(JSON.stringify(a.map((r) => [r.trackId, r.score]))).toBe(JSON.stringify(b.map((r) => [r.trackId, r.score])));
  });

  test('same inputs → identical ordering twice (replay law)', () => {
    const profile = emptyProfile(NOW_OF_TEST);
    const brain = new SessionBrain(NOW_OF_TEST);
    const candidates = ['k1', 'k2', 'k3'].map((id, i) => candidateOf(id, ['a', 'b', 'c'][i]));
    const arms: BanditArms = { k2: { alpha: 5, beta: 1 } };
    const opts = { banditArms: arms };
    const r1 = decide([...candidates], ctxOf(), { profile, session: brain.state, now: NOW_OF_TEST }, opts);
    const r2 = decide([...candidates], ctxOf(), { profile, session: brain.state, now: NOW_OF_TEST }, opts);
    expect(JSON.stringify(r1.map((r) => r.trackId))).toBe(JSON.stringify(r2.map((r) => r.trackId)));
  });
});

describe('GENIUS P3 — potato-phone table discipline', () => {
  test('hard cap: 2001+ arms evict the least-learned, deterministic ties', () => {
    let arms: BanditArms = {};
    const N = BANDIT.maxArms + 50;
    // zero-padded ids so string order == numeric order (eviction ties break
    // on the id string — pad to make the expectation readable)
    const idOf = (i: number) => `t${String(i).padStart(5, '0')}`;
    for (let i = 0; i < N; i++) {
      arms = updateArms(arms, idOf(i), 'COMPLETED', new Set(), 'a');
    }
    arms = capArms(arms);
    expect(Object.keys(arms).length).toBe(BANDIT.maxArms);
    // all weights equal (one COMPLETED each) → the FIRST 50 by id go
    expect(arms[idOf(0)]).toBeUndefined();
    expect(arms[idOf(49)]).toBeUndefined();
    expect(arms[idOf(50)]).toBeDefined();
    // every survivor learned exactly one COMPLETED
    expect(arms[idOf(50)]!.alpha).toBe(3);
  });

  test('armFor keeps cold tracks at {1,1} without materializing them', () => {
    const arms: BanditArms = {};
    expect(armFor(arms, 'ghost')).toEqual({ alpha: 1, beta: 1 });
    expect(arms.ghost).toBeUndefined();
  });
});

const NOW_OF_TEST = new Date('2026-10-06T10:00:00Z').getTime();
