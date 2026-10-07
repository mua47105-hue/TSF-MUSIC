/**
 * MAGNUM OPUS WAVE 3 · F10 — HAPTIC CHOREOGRAPHY LOCKS.
 *
 * The bar: the pure decision table covers every event + the
 * reducedHaptics null path; the throttle is the BEAT-INDEX memory (not
 * wall-clock); battery cost is structural (500ms floor); haptics NEVER
 * touch the audio thread (the service must not import the module) and
 * expo-haptics loads lazily (never at cold start).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { hapticEvent, type HapticsSettings, type HapticTrackInput } from '../src/player/haptics';
import { HAPTICS } from '../src/ai/core/constants';

const FULL: HapticsSettings = { reducedHaptics: false, lastBeatIndex: 0 };
const REDUCED: HapticsSettings = { reducedHaptics: true, lastBeatIndex: 0 };

describe('F10 · hapticEvent — the decision table', () => {
  test('every non-beat event returns its spec (literal styles)', () => {
    expect(hapticEvent('heart-tap', {}, 0, FULL)).toEqual({ spec: { kind: 'impact', style: 'medium' } });
    expect(hapticEvent('crate-generate', {}, 0, FULL)).toEqual({
      spec: { kind: 'notification', style: 'success' },
    });
    expect(hapticEvent('bookmark-save', {}, 0, FULL)).toEqual({
      spec: { kind: 'notification', style: 'success' },
    });
  });

  test('THE SWITCH IS LAW: reducedHaptics nulls EVERY event', () => {
    for (const action of ['beat-tick', 'heart-tap', 'crate-generate', 'bookmark-save'] as const) {
      expect(hapticEvent(action, { tempoClass: 'fast' }, 99999, REDUCED)).toBeNull();
    }
  });

  test('beat tick: tempoClass-derived intervals (667ms mid, literal)', () => {
    const mid: HapticTrackInput = { tempoClass: 'mid' };
    expect(hapticEvent('beat-tick', mid, 0, FULL)).toBeNull(); // nothing before the first beat
    expect(hapticEvent('beat-tick', mid, 666, FULL)).toBeNull(); // 1ms short
    const first = hapticEvent('beat-tick', mid, 667, FULL);
    expect(first).toEqual({ spec: { kind: 'impact', style: 'light' }, beatIndex: 1 });
    expect(hapticEvent('beat-tick', mid, 1334, { ...FULL, lastBeatIndex: 1 })).toEqual({
      spec: { kind: 'impact', style: 'light' },
      beatIndex: 2,
    });
  });

  test('beat tick throttle: one fire per beat, ever (the caller-owned memory)', () => {
    const fast: HapticTrackInput = { tempoClass: 'fast' };
    // 500ms floor — same beat index as before → the wrist stays still
    expect(hapticEvent('beat-tick', fast, 520, { ...FULL, lastBeatIndex: 1 })).toBeNull();
    expect(hapticEvent('beat-tick', fast, 999, { ...FULL, lastBeatIndex: 1 })).toBeNull(); // still beat 1
    expect(hapticEvent('beat-tick', fast, 1000, { ...FULL, lastBeatIndex: 1 })?.beatIndex).toBe(2);
  });

  test('slow songs feel softer; the intervals are the documented beats', () => {
    const slow = hapticEvent('beat-tick', { tempoClass: 'slow' }, 857, FULL);
    expect(slow?.spec).toEqual({ kind: 'impact', style: 'soft' });
    // literal bridge to constants.ts (rationale lives there)
    expect(HAPTICS.beatIntervalMs.slow).toBe(857); // ≈70 BPM
    expect(HAPTICS.beatIntervalMs.mid).toBe(667); // ≈90 BPM
    expect(HAPTICS.beatIntervalMs.fast).toBe(500); // ≈120 BPM — the ≤2Hz battery floor
    expect(HAPTICS.floorIntervalMs).toBe(500);
  });

  test('unknown tempoClass degrades to mid (never crashes)', () => {
    expect(hapticEvent('beat-tick', {}, 700, FULL)?.beatIndex).toBe(1);
  });
});

describe('F10 · source laws (thread + laziness)', () => {
  test('the AUDIO SERVICE never imports haptics (JS thread only, X8)', () => {
    const service = readFileSync('src/player/service.ts', 'utf8');
    expect(service).not.toMatch(/haptics/i);
    const provider = readFileSync('src/player/PlayerProvider.tsx', 'utf8');
    expect(provider).not.toMatch(/from '\.\.\/player\/haptics'|from '\.\/haptics'/);
  });

  test('expo-haptics is required LAZILY inside fireHaptic (never at module load)', () => {
    const src = readFileSync('src/player/haptics.ts', 'utf8');
    expect(src).not.toMatch(/import \* as Haptics/); // no top-level import
    expect(src).toMatch(/require\('expo-haptics'\)/); // lazy require inside the fire helper
  });

  test('every haptic call site routes through hapticEvent (the reduced switch cannot be bypassed)', () => {
    // the wiring evidence: the player + home screens decide via the pure fn
    const player = readFileSync('src/screens/PlayerScreen.tsx', 'utf8');
    expect(player).toContain("hapticEvent('beat-tick'");
    expect(player).toContain("hapticEvent('heart-tap'");
    expect(player).toContain("hapticEvent('bookmark-save'");
    const home = readFileSync('src/screens/HomeScreen.tsx', 'utf8');
    expect(home).toContain("hapticEvent('crate-generate'");
    expect(home).toContain('getReducedHaptics()'); // the persisted switch gates the crate buzz
  });
});
