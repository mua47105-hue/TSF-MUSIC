/**
 * MAGNUM OPUS WAVE 4 · F14 — MOOD JOURNEY LOCKS.
 *
 * The bar: monotonic bounded drift over a fixture (every step ≤ ±0.15
 * per axis, LITERALS); the walk lands on its target and stays there;
 * slot assignment matches nearest candidates without reuse and SKIPS
 * slots the catalog cannot fill (honest absence); the kill switch is
 * checked in the facade (silent []); source law: candidates pass
 * reconcileRecordings + filterClean at the merge point.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { assignSlots, moodDistance, planMoodPath, type MoodPoint } from '../src/ai/moodJourney';
import { MOOD_JOURNEY } from '../src/ai/core/constants';

const ANXIOUS: MoodPoint = { energy: 0.85, valence: 0.25 };
const CALM: MoodPoint = { energy: 0.2, valence: 0.75 };

describe('F14 · planMoodPath — the bounded drift', () => {
  test('anxious→calm over 12 slots: every step ≤ 0.15 per axis (literals)', () => {
    const path = planMoodPath(ANXIOUS, CALM, 12);
    expect(path.length).toBe(12);
    // the walk crosses 0.65 of energy in 0.15 steps → 5 steps land, then stay
    expect(path[0].energy).toBeCloseTo(0.7, 10);
    expect(path[1].energy).toBeCloseTo(0.55, 10);
    expect(path[4].energy).toBeCloseTo(0.2, 10); // target reached
    for (let i = 5; i < 12; i++) expect(path[i].energy).toBeCloseTo(0.2, 10); // monotone, no zig-zag
    for (let i = 1; i < path.length; i++) {
      expect(Math.abs(path[i].energy - path[i - 1].energy)).toBeLessThanOrEqual(MOOD_JOURNEY.maxStep + 1e-9);
      expect(Math.abs(path[i].valence - path[i - 1].valence)).toBeLessThanOrEqual(MOOD_JOURNEY.maxStep + 1e-9);
    }
    // valence climbs 0.25 → 0.75 the same bounded way
    expect(path[0].valence).toBeCloseTo(0.4, 10);
    expect(path[3].valence).toBeCloseTo(0.75, 10);
  });

  test('short journeys and zero counts are honest', () => {
    expect(planMoodPath(ANXIOUS, CALM, 0)).toEqual([]);
    const one = planMoodPath(ANXIOUS, CALM, 1);
    expect(one.length).toBe(1);
    // one slot can move at most one bounded step per axis
    expect(one[0].energy).toBeCloseTo(0.7, 10);
  });

  test('the bound IS the documented constant (literal bridge)', () => {
    expect(MOOD_JOURNEY.maxStep).toBe(0.15);
    expect(MOOD_JOURNEY.defaultCount).toBe(12);
    // 12 × 0.15 ≥ the full axis — the journey can always reach its target
    expect(MOOD_JOURNEY.defaultCount * MOOD_JOURNEY.maxStep).toBeGreaterThanOrEqual(1);
  });

  test('moodDistance is exact euclidean in the proxy space', () => {
    expect(moodDistance({ energy: 0, valence: 0 }, { energy: 3, valence: 4 })).toBeCloseTo(5, 10);
  });
});

describe('F14 · assignSlots — the honest matcher', () => {
  const candidates = [
    { id: 'hot', energy: 0.9, valence: 0.2 },
    { id: 'mid', energy: 0.5, valence: 0.5 },
    { id: 'calm', energy: 0.22, valence: 0.7 },
    { id: 'warp', energy: 0.05, valence: 0.05 }, // far from slot 1
  ];
  const featureOf = (t: { energy: number; valence: number }) => ({ energy: t.energy, valence: t.valence });

  test('each slot takes its NEAREST unused candidate within reach; skips are honest', () => {
    // slot1 (.7,.4): mid is nearest (0.224) — hot is 0.283, still within 0.3
    // slot2 (.55,.55): nearest remaining is calm at 0.363 > 0.3 → SKIPPED
    // slot3 (.4,.7): calm at 0.18 → filled
    const path = planMoodPath(ANXIOUS, CALM, 3);
    const { picks, skippedSlots } = assignSlots(path, candidates as never, featureOf);
    expect(picks.map((p) => p.track.id)).toEqual(['mid', 'calm']);
    expect(skippedSlots).toEqual([2]); // the honest absence
    const ids = picks.map((p) => p.track.id);
    expect(new Set(ids).size).toBe(ids.length); // no reuse
  });

  test('an unfilled slot is SKIPPED, never fabricated (empty catalog → all skipped)', () => {
    const path = planMoodPath(ANXIOUS, CALM, 2);
    const { picks, skippedSlots } = assignSlots(path, [], featureOf);
    expect(picks).toEqual([]);
    expect(skippedSlots).toEqual([1, 2]);
  });
});

describe('F14 · source laws (facade contract)', () => {
  test('the kill switch gates the facade (silent [])', () => {
    const src = readFileSync('src/ai/mindbeat.ts', 'utf8');
    const m = src.match(/async moodJourney\([\s\S]*?\n  \}/);
    expect(m).toBeTruthy();
    expect(m![0]).toContain('if (this.disabled) return');
    expect(m![0]).toContain('reconcileRecordings(candidates)');
    expect(m![0]).toContain('filterClean(candidates)');
  });

  test('the walk constants carry the rationale (constants.ts is the home)', () => {
    const src = readFileSync('src/ai/moodJourney.ts', 'utf8');
    expect(src).not.toMatch(/Math\.random\s*\(/);
    expect(src).toContain('MOOD_JOURNEY.maxStep');
    expect(src).toContain('MOOD_JOURNEY.maxCandidateDistance');
  });
});
