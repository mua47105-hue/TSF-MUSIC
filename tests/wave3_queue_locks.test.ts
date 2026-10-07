/**
 * MAGNUM OPUS WAVE 3 · F13 — SMART QUEUE REORDERING LOCKS.
 *
 * The bar: the greedy nearest-neighbor walk produces the EXACT expected
 * order on fixtures (tie → original index); the output is a PERMUTATION
 * (no track lost, none invented); pinned tracks never move; missing
 * features take the honest neutral mid; the largest-step report is
 * exact and the bound check is honest; the walk is USER-INITIATED ONLY
 * (source-locked: the sole call site is the queue sheet's button).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import {
  energyOf,
  largestEnergyStep,
  optimizeQueueByVibe,
  stepWithinBound,
} from '../src/player/queueOptimizer';
import { CADENCE, QUEUE_VIBE } from '../src/ai/core/constants';

const FEATURES: Record<string, number> = {
  a: 0.9,
  b: 0.5,
  c: 0.1,
  d: 0.3,
  e: 0.7,
};
const track = (id: string) => ({ id, title: `T-${id}` });

describe('F13 · optimizeQueueByVibe — the greedy walk', () => {
  test('fixture: nearest-neighbor from seed 0.9 → the exact expected order', () => {
    // pool: a(.9) b(.5) c(.1) d(.3) e(.7); seed = 0.9
    // 0.9 → a(.9, Δ0) → e(.7, Δ.2) → b(.5, Δ.2) → d(.3, Δ.2) → c(.1, Δ.2)
    const { order } = optimizeQueueByVibe([track('b'), track('a'), track('c'), track('d'), track('e')], FEATURES, [], 0.9);
    expect(order.map((t) => t.id)).toEqual(['a', 'e', 'b', 'd', 'c']);
  });

  test('ties break by ORIGINAL index (determinism law X4)', () => {
    // from seed 0.9: x(.9) is Δ0; then f(.5) and b(.5) are BOTH Δ0.4 from x —
    // the tie goes to the FIRST in the original order (f, index 1), then b.
    const feats = { b: 0.5, f: 0.5, x: 0.9 };
    const { order } = optimizeQueueByVibe([track('x'), track('f'), track('b')], feats, [], 0.9);
    expect(order.map((t) => t.id)).toEqual(['x', 'f', 'b']);
  });

  test('output is a PERMUTATION: same ids, same count, none lost or invented', () => {
    const input = [track('a'), track('b'), track('c'), track('d'), track('e')];
    const { order } = optimizeQueueByVibe(input, FEATURES, [], 0.5);
    expect([...order].sort((x, y) => x.id.localeCompare(y.id)).map((t) => t.id)).toEqual(
      [...input].sort((x, y) => x.id.localeCompare(y.id)).map((t) => t.id),
    );
    expect(order.length).toBe(input.length);
  });

  test('PINNED tracks never move: they keep their exact slots', () => {
    // a is pinned at index 1 — WITHOUT the pin the walk would put a first
    // (seed 0.9 → a,e,b,d,c), so this fixture genuinely discriminates
    const input = [track('b'), track('a'), track('c'), track('d'), track('e')];
    const { order, pinnedKept } = optimizeQueueByVibe(input, FEATURES, ['a'], 0.9);
    expect(order[1].id).toBe('a'); // the pinned slot, byte-identical position
    expect(pinnedKept).toBe(1);
    // the free slots walk around it: 0.9 → e(.7) → b(.5) → d(.3) → c(.1)
    expect(order.map((t) => t.id)).toEqual(['e', 'a', 'b', 'd', 'c']);
    // still a permutation
    expect([...order].sort((x, y) => x.id.localeCompare(y.id)).map((t) => t.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
  });

  test('missing features take the neutral mid (never a guessed energy)', () => {
    expect(energyOf('unknown', FEATURES)).toBe(0.5);
    expect(energyOf('nan', { bad: Number.NaN })).toBe(0.5);
    // literal bridge to constants.ts
    expect(QUEUE_VIBE.missingEnergy).toBe(0.5);
    expect(QUEUE_VIBE.minTracks).toBe(4);
  });

  test('largestStep is exact; the bound check is the EXISTING aiMaxEnergyStep', () => {
    // the fixture walk above: consecutive steps .0/.2/.2/.2/.2 → largest 0.2
    const order = optimizeQueueByVibe([track('b'), track('a'), track('c'), track('d'), track('e')], FEATURES, [], 0.9).order;
    expect(largestEnergyStep(order, FEATURES)).toBeCloseTo(0.2, 3);
    expect(stepWithinBound(0.2)).toBeTrue();
    expect(stepWithinBound(0.25)).toBeTrue(); // the bound itself holds
    expect(stepWithinBound(0.26)).toBeFalse(); // the honest toast case
    // bridge: the bound IS the AI-mix constant (one energy neighborhood)
    expect(CADENCE.aiMaxEnergyStep).toBe(0.25);
  });

  test('USER-INITIATED ONLY: the sole call site is the queue sheet button', () => {
    // grep every TS/TSX file: the name may appear as the provider's own
    // definition and as ONE invocation from PlayerScreen's button — nothing else.
    const hits = execSync(`grep -rn "optimizeQueueByVibe()" src/ --include='*.ts' --include='*.tsx'`, {
      encoding: 'utf8',
    })
      .trim()
      .split('\n');
    expect(hits.length).toBe(2);
    expect(hits.some((h) => h.includes('src/player/PlayerProvider.tsx'))).toBeTrue(); // the definition
    const invocation = hits.find((h) => h.includes('src/screens/PlayerScreen.tsx'));
    expect(invocation).toBeDefined(); // the ONE user-facing call site
    // and the handler hangs off the locked testID
    const sheet = readFileSync('src/screens/PlayerScreen.tsx', 'utf8');
    expect(sheet).toContain('testID="vibe-sort-btn"');
    expect(sheet.indexOf('vibe-sort-btn')).toBeLessThan(sheet.indexOf('optimizeQueueByVibe()'));
  });
});
