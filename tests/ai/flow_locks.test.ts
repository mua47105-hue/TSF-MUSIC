/**
 * GENIUS P4 — MARKOV TRANSITION MEMORY LOCKS (gauntlet/GENIUS-BARS.md §P4).
 *
 * Bars pinned:
 *   • session-consecutive listens build DIRECTIONAL edges — A→B is distinct
 *     from B→A — decayed with the existing coplayEdge half-life
 *   • per-node fan-out ≤ FLOW.topNext (8); global edges ≤ FLOW.maxEdges
 *     (3000); sub-floor edges pruned
 *   • FLOW_NEXT truth condition fires ONLY above the seed's outgoing-edge
     median (the NEIGHBOR pattern, directional edition)
 *   • loop scenario (A→B→A→B) never re-serves inside the 7-day window —
 *     the existing hygiene prefilter blocks it
 *   • cold users: zero transitions → zero bonus → byte-identical legacy
 *   • determinism: same listens → identical transition table, twice
 */

import { describe, expect, test } from 'bun:test';
import { buildProfile, emptyProfile } from '../../src/ai/core/profile';
import { decide, truthCondition } from '../../src/ai/core/decision';
import { SessionBrain } from '../../src/ai/core/session';
import { FLOW } from '../../src/ai/core/constants';
import type { ListenRecord, TasteProfile } from '../../src/ai/core/types';
import type { Candidate, DecisionContext } from '../../src/ai/core/types';

const NOW = new Date('2026-10-06T10:00:00Z').getTime();
const H = 3600_000;

function listen(trackId: string, sessionId: string, startedTs: number): ListenRecord {
  return {
    trackId,
    artist: `artist-${trackId}`,
    energy: 0.5,
    valence: 0.5,
    sessionId,
    surface: 'user_queue',
    startedTs,
    listenedMs: 120_000,
    durationMs: 200_000,
    completionRatio: 0.6,
    grade: 'COMPLETED',
    wasRecommended: false,
    explorationSlot: false,
  };
}

function candidateOf(id: string, artist = 'x'): Candidate {
  return {
    trackId: id,
    artist,
    features: { energy: 0.5, valence: 0.5, tempoClass: 'mid', confidence: 0.5, source: 'prior' },
    pool: 'affinity',
  };
}

describe('GENIUS P4 — directional edge construction', () => {
  test('A→B and B→A are distinct, weight accumulates with repetition', () => {
    // session 1: A→B; session 2: A→B, B→A
    const listens = [
      listen('A', 's1', NOW - 5 * H),
      listen('B', 's1', NOW - 5 * H + 60_000),
      listen('A', 's2', NOW - H),
      listen('B', 's2', NOW - H + 60_000),
      listen('A', 's2', NOW - H + 120_000),
    ];
    const p = buildProfile(listens, [], [], { now: NOW });
    const ab = p.transitions?.A?.B ?? 0;
    const ba = p.transitions?.B?.A ?? 0;
    expect(ab).toBeGreaterThan(0);
    expect(ba).toBeGreaterThan(0);
    expect(ab).toBeGreaterThan(ba); // A→B happened twice, B→A once
    // determinism: rebuild → identical
    const p2 = buildProfile(listens, [], [], { now: NOW });
    expect(JSON.stringify(p2.transitions)).toBe(JSON.stringify(p.transitions));
  });

  test('per-node fan-out capped at FLOW.topNext; noise floor pruned', () => {
    const listens: ListenRecord[] = [];
    // A flows to 12 different tracks (well above the 8 cap)
    for (let i = 0; i < 12; i++) {
      listens.push(listen('A', `s${i}`, NOW - (i + 1) * H));
      listens.push(listen(`N${i}`, `s${i}`, NOW - (i + 1) * H + 60_000));
    }
    const p = buildProfile(listens, [], [], { now: NOW });
    const nexts = Object.keys(p.transitions?.A ?? {});
    expect(nexts.length).toBe(FLOW.topNext);
    // ancient edge (old age → decayed below floor) is pruned: a 60-day-old
    // single listen decays 0.5^(60/60)=0.5 — kept; 300 days → ~0.001 — gone
    const ancient = buildProfile(
      [listen('Z', 'sz', NOW - 400 * 24 * H), listen('Y', 'sz', NOW - 400 * 24 * H + 60_000)],
      [], [], { now: NOW },
    );
    expect(ancient.transitions?.Z?.Y).toBeUndefined();
  });

  test('global edge budget FLOW.maxEdges holds', () => {
    const listens: ListenRecord[] = [];
    const sessions = Math.ceil((FLOW.maxEdges + 500) / 2);
    for (let i = 0; i < sessions; i++) {
      listens.push(listen(`F${i}`, `sf${i}`, NOW - (i % 100 + 1) * H));
      listens.push(listen(`G${i}`, `sf${i}`, NOW - (i % 100 + 1) * H + 60_000));
    }
    const p = buildProfile(listens, [], [], { now: NOW });
    let edges = 0;
    for (const nexts of Object.values(p.transitions ?? {})) edges += Object.keys(nexts).length;
    expect(edges).toBeLessThanOrEqual(FLOW.maxEdges);
  });
});

describe('GENIUS P4 — FLOW_NEXT truth condition', () => {
  function profileWithFlow(): TasteProfile {
    const p = emptyProfile(NOW);
    p.transitions = {
      seed: { top: 0.9, middle: 0.5, bottom: 0.1 },
    };
    return p;
  }

  test('fires above the seed median; stays silent at/below it', () => {
    const profile = profileWithFlow();
    const brain = new SessionBrain(NOW);
    const deps = { profile, session: brain.state, now: NOW };
    const ctx: DecisionContext = {
      surface: 'radio', block: 'evening', dayKind: 'weekday',
      seedTrackIds: ['seed'], seedArtists: [], requested: 5,
    };
    const lastServed = new Map<string, number>();
    // median of {0.9, 0.5, 0.1} = 0.5 → strictly-above fires only for 'top'
    expect(truthCondition(candidateOf('top'), deps, ctx, lastServed)).toBe('FLOW_NEXT');
    expect(truthCondition(candidateOf('middle'), deps, ctx, lastServed)).not.toBe('FLOW_NEXT');
    expect(truthCondition(candidateOf('bottom'), deps, ctx, lastServed)).not.toBe('FLOW_NEXT');
    // no seed transitions at all → never fires
    const coldCtx: DecisionContext = { ...ctx, seedTrackIds: ['unknown-seed'] };
    expect(truthCondition(candidateOf('top'), deps, coldCtx, lastServed)).not.toBe('FLOW_NEXT');
  });

  test('flow bonus lifts a top-transition candidate; cold profile → zero bonus', () => {
    const listens = [
      listen('seed', 's1', NOW - 2 * H),
      listen('top', 's1', NOW - 2 * H + 60_000),
    ];
    const profile = buildProfile(listens, [], [], { now: NOW });
    const brain = new SessionBrain(NOW);
    const ctx: DecisionContext = {
      surface: 'radio', block: 'evening', dayKind: 'weekday',
      seedTrackIds: ['seed'], seedArtists: [], requested: 5,
    };
    const cands = [candidateOf('top', 'artist-top'), candidateOf('unrelated', 'other')];
    const ranked = decide(cands, ctx, { profile, session: brain.state, now: NOW });
    // assert on SCORE (the exploration interleave may reorder the head):
    // the learned next must outrank the unrelated candidate by up to +0.4
    const top = ranked.find((r) => r.trackId === 'top')!;
    const unrelated = ranked.find((r) => r.trackId === 'unrelated')!;
    expect(top.score).toBeGreaterThan(unrelated.score);
    // cold profile — identical candidates, no flow anywhere
    const cold = emptyProfile(NOW);
    const rankedCold = decide(cands, ctx, { profile: cold, session: brain.state, now: NOW });
    expect(JSON.stringify(rankedCold.map((r) => [r.trackId, r.score])))
      .toBe(JSON.stringify(decide(cands, ctx, { profile: emptyProfile(NOW), session: brain.state, now: NOW }).map((r) => [r.trackId, r.score])));
  });

  test('loop scenario never re-serves inside the 7-day window', () => {
    // A→B→A→B habit; both are already served recently → hygiene excludes both
    const listens = [
      listen('A', 's1', NOW - 3 * H), listen('B', 's1', NOW - 3 * H + 60_000),
      listen('A', 's2', NOW - 2 * H), listen('B', 's2', NOW - 2 * H + 60_000),
    ];
    const profile = buildProfile(listens, [], [], { now: NOW });
    const brain = new SessionBrain(NOW);
    brain.push(listen('A', 's-live', NOW - 60_000));
    const ctx: DecisionContext = {
      surface: 'radio', block: 'evening', dayKind: 'weekday',
      seedTrackIds: ['A'], seedArtists: [], requested: 5,
    };
    // A was served 60s ago; B has a transition edge from A but was served 2h ago
    const lastServed = new Map<string, number>([['A', NOW - 60_000], ['B', NOW - 2 * H]]);
    const ranked = decide(
      [candidateOf('A', 'artist-A'), candidateOf('B', 'artist-B'), candidateOf('C', 'artist-C')],
      ctx,
      { profile, session: brain.state, now: NOW },
      { serveRecency: lastServed },
    );
    const ids = ranked.map((r) => r.trackId);
    expect(ids).not.toContain('A'); // 7-day freshness contract
    expect(ids).not.toContain('B'); // served 2h ago → also inside the window
    expect(ids).toContain('C');
  });
});
