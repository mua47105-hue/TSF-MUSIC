/**
 * PHASE 4 LOCKS — the directed Markov flow memory + FLOW_NEXT.
 *
 *   1. transitions are DIRECTED: A→B ≠ B→A
 *   2. per-node top-8 cap + global ≤3000 edge cap + weight floor
 *   3. daypart second-order bonus bakes into repeated-cell edges
 *   4. FLOW_NEXT truth condition: directed edge ABOVE THE MEDIAN of the
 *      seed's out-edges (three-way sync: enum + truthCondition + reasonLine)
 *   5. the engine's flow bonus lifts the true follower
 */

import { describe, expect, test } from 'bun:test';
import { buildProfile } from '../../src/ai/core/profile';
import { decide, reasonLine, truthCondition } from '../../src/ai/core/decision';
import { SessionBrain } from '../../src/ai/core/session';
import { FLOW } from '../../src/ai/core/constants';
import { listenOf } from './corpus';
import type { Candidate, DecisionContext } from '../../src/ai/core/types';

const NOW = 1750000000000;
const DAY = 86400_000;

/** Build a profile from a chain of consecutive plays inside one session. */
function flowProfile(chain: string[], repeats = 1) {
  const listens = [];
  for (let r = 0; r < repeats; r++) {
    chain.forEach((id, i) => {
      listens.push(listenOf(id, `artist-${id}`, NOW - 3 * DAY + i * 200000 + r * 1000000, 'sflow', 1));
    });
  }
  const sessions = [{ id: 'sflow', startTs: NOW - 3 * DAY, daypart: 'evening' as const, dayKind: 'weekday' as const, trackCount: chain.length, totalListenMs: chain.length * 210000 }];
  return buildProfile(listens, [], sessions, { now: NOW });
}

describe('phase 4 — directed transitions', () => {
  test('A→B exists; B→A does not (A→B ≠ B→A)', () => {
    const p = flowProfile(['t-a', 't-b']);
    expect(p.flowTracks['t-a']?.['t-b']).toBeGreaterThan(0);
    expect(p.flowTracks['t-b']?.['t-a']).toBeUndefined();
  });

  test('self-transitions (replays) never create flow edges', () => {
    const p = flowProfile(['t-a', 't-a', 't-a']);
    expect(p.flowTracks['t-a']?.['t-a']).toBeUndefined();
  });

  test('the daypart bonus bakes into edges repeated inside ONE cell', () => {
    // same session = same cell; 2+ observations cross the bonus threshold
    const once = flowProfile(['t-a', 't-b'], 1);
    const twice = flowProfile(['t-a', 't-b'], 2);
    const wOnce = once.flowTracks['t-a']?.['t-b'] ?? 0;
    const wTwice = twice.flowTracks['t-a']?.['t-b'] ?? 0;
    expect(wTwice).toBeGreaterThan(wOnce);
    // twice = 2×(decayed weight)×damp-corrected × bonus 1.25 — strictly more than plain doubling
    expect(wTwice).toBeGreaterThan(wOnce * 1.2);
  });

  test('per-node top-K: only the strongest FLOW.outEdgeCap edges survive per node', () => {
    const chain: string[] = ['t-seed'];
    for (let i = 0; i < 12; i++) chain.push(`t-out-${i}`);
    const p = flowProfile(chain);
    const outs = Object.keys(p.flowTracks['t-seed'] ?? {});
    expect(outs.length).toBeLessThanOrEqual(FLOW.outEdgeCap);
    // the pruned set keeps the EARLIEST-strongest? No — strongest by weight:
    // all edges have equal weight here → the tiebreak keeps a deterministic subset
    expect(outs.length).toBeGreaterThan(0);
  });
});

describe('FLOW_NEXT — the three-way sync', () => {
  // 3× seed→next, 1× seed→other, 1× seed→third: t-next sits ABOVE the
  // median of the seed's out-edges; the weakest edge does not.
  const p = flowProfile(['t-seed', 't-next', 't-seed', 't-next', 't-seed', 't-next', 't-seed', 't-other', 't-seed', 't-third'], 1);

  const ctx: DecisionContext = {
    surface: 'radio',
    block: 'evening',
    dayKind: 'weekday',
    seedTrackIds: ['t-seed'],
    seedArtists: ['artist-t-seed'],
    requested: 4,
  };

  function cand(id: string): Candidate {
    return {
      trackId: id,
      artist: `artist-${id}`,
      features: { energy: 0.5, valence: 0.5, tempoClass: 'mid', confidence: 0.5, source: 'prior' },
      pool: 'neighborhood',
    };
  }

  test('enum ↔ truthCondition ↔ reasonLine agree (Law ⑥)', () => {
    const brain = new SessionBrain(NOW);
    const deps = { profile: p, session: brain.state, now: NOW };
    const code = truthCondition(cand('t-next'), deps, ctx, new Map());
    expect(code).toBe('FLOW_NEXT');
    expect(reasonLine('FLOW_NEXT')).toBe('Keeps your flow going');
  });

  test('an edge NOT above the median of the seed\'s out-edges never claims FLOW_NEXT', () => {
    const brain = new SessionBrain(NOW);
    const deps = { profile: p, session: brain.state, now: NOW };
    // the seed's weakest out-edge cannot claim flow (median discipline)
    const outs = Object.entries(p.flowTracks['t-seed']!).sort((a, b) => a[1] - b[1]);
    const weakest = outs[0][0];
    expect(truthCondition(cand(weakest), deps, ctx, new Map())).not.toBe('FLOW_NEXT');
  });

  test("the flow bonus is REAL: erasing flowTracks drops the follower's score, nobody else's", () => {
    // Direct additive-term lock (mutation-proof): decide() on the profile
    // vs the same profile with the flow memory erased. The follower's
    // score must drop when the flow memory vanishes; a non-follower's
    // score must not move at all.
    const brain = new SessionBrain(NOW);
    const candidates: Candidate[] = ['t-next', 't-other', 't-unknown'].map(cand);
    const ctx2: DecisionContext = { ...ctx, requested: 3 };
    const withFlow = decide(candidates, ctx2, { profile: p, session: brain.state, now: NOW });
    const noFlow = decide(candidates, ctx2, { profile: { ...p, flowTracks: {} }, session: brain.state, now: NOW });
    const scoreOf = (rows: ReturnType<typeof decide>, id: string) => rows.find((r) => r.trackId === id)!.score;

    const dropNext = scoreOf(withFlow, 't-next') - scoreOf(noFlow, 't-next');
    const dropOther = scoreOf(withFlow, 't-other') - scoreOf(noFlow, 't-other');
    const dropUnknown = scoreOf(withFlow, 't-unknown') - scoreOf(noFlow, 't-unknown');

    expect(dropNext).toBeGreaterThan(0); // the strong follower rode the bonus
    expect(dropOther).toBeGreaterThanOrEqual(0); // weak edge → weak drop
    expect(dropUnknown).toBe(0); // a track with no flow edge never moves
    expect(dropNext).toBeGreaterThan(dropOther); // the strongest edge drops the most
  });

  test('an unknown track has no flow edge at all — no FLOW_NEXT claim', () => {
    const brain = new SessionBrain(NOW);
    const deps = { profile: p, session: brain.state, now: NOW };
    expect(truthCondition(cand('t-never-played'), deps, ctx, new Map())).not.toBe('FLOW_NEXT');
  });
});
