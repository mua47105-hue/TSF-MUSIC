/**
 * v5.0.1 FIX-C1 + FIX-C3 — DOCS THAT MATCH REALITY, HAPTICS THAT WAIT
 * FOR EVIDENCE.
 *
 * FIX-C1 (F17): the changelog/bulletin claimed "albums on a year axis";
 * the shipped screen groups the artist's TOP TRACKS by DECADE (the
 * provider's album rows arrive undated). Docs-only fix — the behavior
 * was already useful and shipped.
 *
 * FIX-C3 (F10): a startup race let haptics fire on the stale default
 * before the persisted reducedHaptics setting loaded. The module now
 * has a hydration gate: hapticEvent is silent until markHapticsHydrated
 * is called (the boot read's settle hook).
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  hapticEvent,
  isHapticsHydrated,
  markHapticsHydrated,
  resetHapticsHydrationForTests,
  type HapticsSettings,
} from '../src/player/haptics';

const FULL: HapticsSettings = { reducedHaptics: false, lastBeatIndex: 0 };
const REDUCED: HapticsSettings = { reducedHaptics: true, lastBeatIndex: 999 };

describe('FIX-C1 · the F17 docs describe the shipped decade timeline', () => {
  test('the changelog F17 entry names TOP TRACKS BY DECADE, not a year axis', () => {
    const src = readFileSync('docs/CHANGELOG.md', 'utf8');
    const f17 = (src.split('**F17 Artist Timeline**')[1] ?? '').split('### Wave 5')[0];
    expect(f17).toContain('TOP TRACKS grouped by');
    expect(f17).toContain('DECADE');
    expect(f17).not.toContain('horizontal year axis'); // the CLAIM is gone (a quoted mention in the relabel note is honest history)
  });

  test('the docs carry no stale claim (no "year axis"; the README counts say 885, not 807)', () => {
    expect(readFileSync('src/components/WhatsNewDialog.tsx', 'utf8')).not.toContain('year axis');
    const readme = readFileSync('README.md', 'utf8');
    expect(readme).not.toContain('year axis');
    // v5.0.2 FIX 3 — the test-count badge tells the truth. The 807 badge
    // survived TWO releases stale (the suite hit 885 at v5.0.1); these
    // pins bite the moment the README and the shipped suite diverge.
    expect(readme).toContain('replay_tests-885_passing'); // the badge
    expect(readme).toContain('# 885 replay tests incl. latency budgets'); // the quick-start comment
    expect(readme).not.toContain('807'); // the stale count is gone everywhere
  });

  test('the v5.0.2 bulletin carries the patch headline (and still no year-axis claim)', () => {
    const src = readFileSync('src/components/WhatsNewDialog.tsx', 'utf8');
    expect(src).toContain('THE STABILITY PATCH');
    expect(src).toContain('tsf.whatsNew.v5_0_2');
    expect(src).not.toContain('year axis');
    // v5.0.2 FIX 4 — the changelog entry exists and names the real root cause.
    const changelog = readFileSync('docs/CHANGELOG.md', 'utf8');
    expect(changelog).toContain('## v5.0.2');
    expect(changelog).toContain('test-isolation');
  });
});

describe('FIX-C3 · the hydration gate', () => {
  beforeEach(() => {
    resetHapticsHydrationForTests();
  });

  test('before hydration: EVERY event is silently null (the stale default cannot fire)', () => {
    expect(isHapticsHydrated()).toBeFalse();
    expect(hapticEvent('beat-tick', { tempoClass: 'fast' }, 99999, FULL)).toBeNull();
    expect(hapticEvent('heart-tap', {}, 0, FULL)).toBeNull();
    expect(hapticEvent('crate-generate', {}, 0, FULL)).toBeNull();
    expect(hapticEvent('bookmark-save', {}, 0, FULL)).toBeNull();
  });

  test('after hydration: the decision table returns per the setting (reduced still nulls)', () => {
    markHapticsHydrated();
    expect(isHapticsHydrated()).toBeTrue();
    expect(hapticEvent('heart-tap', {}, 0, FULL)).toEqual({ spec: { kind: 'impact', style: 'medium' } });
    expect(hapticEvent('beat-tick', { tempoClass: 'fast' }, 99999, FULL)?.spec).toEqual({ kind: 'impact', style: 'light' });
    expect(hapticEvent('heart-tap', {}, 0, REDUCED)).toBeNull(); // the persisted switch is law
  });

  test('the gate is STICKY: markHapticsHydrated twice never re-closes it', () => {
    markHapticsHydrated();
    markHapticsHydrated();
    expect(isHapticsHydrated()).toBeTrue();
    expect(hapticEvent('heart-tap', {}, 0, FULL)).not.toBeNull();
  });

  test('WIRING: the gate opens in the boot read\u2019s settle hook — not before', () => {
    const src = readFileSync('src/screens/PlayerScreen.tsx', 'utf8');
    const markAt = src.indexOf('markHapticsHydrated();');
    const finallyAt = src.indexOf('.finally(() => {', 0);
    expect(markAt).toBeGreaterThan(-1);
    expect(finallyAt).toBeGreaterThan(-1);
    // the mark lives INSIDE the settle callback of the getReducedHaptics chain
    const chainAt = src.indexOf('getReducedHaptics()');
    expect(markAt).toBeGreaterThan(chainAt);
    expect(src).toContain('.catch(() => undefined)\n      .finally(() => {');
  });

  test('WIRING (critic P1): the crate-generate surface opens the gate at ITS OWN fresh read — the haptic is not hostage to the player route', () => {
    const src = readFileSync('src/screens/HomeScreen.tsx', 'utf8');
    const crateAt = src.indexOf("hapticEvent('crate-generate'");
    const markAt = src.indexOf('markHapticsHydrated();');
    expect(crateAt).toBeGreaterThan(-1);
    expect(markAt).toBeGreaterThan(-1);
    // the mark happens BEFORE the crate decision in the same read chain
    expect(markAt).toBeLessThan(crateAt);
    // and it rides the fresh getReducedHaptics read (the race-free path)
    const readAt = src.indexOf('getReducedHaptics()');
    expect(markAt).toBeGreaterThan(readAt);
  });
});
