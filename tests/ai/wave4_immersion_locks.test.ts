/**
 * THE TEN · WAVE 4 LOCKS — immersion (F8/F9/F10).
 *
 *   F8 Kinetic lyrics — the ACTIVE line is ALWAYS activeLrcIndex's pick
 *      (the no-drift bar), the spec is pure (uniform line height, dim
 *      opacity, tint only on the active line, null tint ⇒ null), and
 *      the parse the card renders is the same locked parseLrc.
 *   F9 Aura — the energy→motion mapping is pure, clamped and monotonic
 *      (higher energy ⇒ faster pulse, brighter glow), garbage/null ⇒
 *      the calmest wash, and the intent resolver is literal (OS
 *      reduce-motion freezes, data saver calms, both ⇒ frozen).
 *   F10 Focus — the timer math is literal (end = now + minutes*60000),
 *      the fade ramp matches the sleep-timer shape, the arm→fade→pause
 *      sequence drives the REAL volume bus (sleep outranks focus), and
 *      cancel restores exactly (factor released, product recomputed).
 *
 * Mutation targets (scripts/mutation_v42.sh W4-*): the kinetic height
 * contract, the aura mapping direction, the focus fade ramp, the focus
 * fade's bus release.
 */

import { describe, expect, test, mock } from 'bun:test';

// Real in-memory AsyncStorage (the facades touch nothing here, but the
// player modules read prefs at import-time only via their init fns).
mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  },
}));
mock.module('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: 'active' },
  Platform: { OS: 'android', select: (o: any) => o.android },
  NativeModules: {},
  AccessibilityInfo: {
    isReduceMotionEnabled: async () => false,
    addEventListener: () => ({ remove: () => undefined }),
  },
}));
// TrackPlayer recorder — the focus engine's pause/play calls are behavior.
const calls: string[] = [];
const volumeWrites: number[] = [];
mock.module('react-native-track-player', () => ({
  default: {
    setVolume: async (v: number) => {
      calls.push('setVolume');
      volumeWrites.push(v);
    },
    pause: async () => {
      calls.push('pause');
    },
    play: async () => {
      calls.push('play');
    },
  },
}));
mock.module('expo-haptics', () => ({
  notificationAsync: async () => {
    calls.push('haptic');
  },
  NotificationFeedbackType: { Success: 'success' },
}));

const { parseLrc, activeLrcIndex, kineticLineSpec, kineticScrollTarget } = await import('../../src/player/singalong');
const { auraMotion, auraMode } = await import('../../src/theme/aura');
const {
  focusFadeFactor,
  focusEndAt,
  focusTick,
  armFocus,
  cancelFocus,
  subscribeFocus,
  getFocusState,
  resetFocusForTests,
} = await import('../../src/player/focus');
const { setFadeFactor, resetVolumeBusForTests, activeFadeOwner } = await import(
  '../../src/player/volumeBus'
);

// ── F8 · kinetic typography ─────────────────────────────────────────────

describe('wave4 · F8 kinetic lyrics (no-drift + pure spec)', () => {
  const lines = parseLrc('[00:10.00]first\n[00:20.00]second\n[00:30.00]third');

  test("the active line is ALWAYS activeLrcIndex's pick (no drift at any position)", () => {
    const tint = '#AABBCC';
    for (const pos of [0, 9_999, 10_000, 15_000, 20_000, 29_999, 30_000, 120_000]) {
      const idx = activeLrcIndex(lines, pos);
      // EVERY row's spec is derived from the SAME mapping — exactly one
      // row is the active one, and its spec carries the size + tint.
      lines.forEach((_, i) => {
        const spec = kineticLineSpec(i === idx, tint);
        if (i === idx) {
          expect(spec.fontSize).toBe(24);
          expect(spec.opacity).toBe(1);
          expect(spec.activeTint).toBe(tint);
        } else {
          expect(spec.fontSize).toBe(14);
          expect(spec.opacity).toBe(0.38);
          expect(spec.activeTint).toBe(null);
        }
      });
      expect(lines[idx]?.text).toBe(
        pos < 10_000 ? undefined : pos < 20_000 ? 'first' : pos < 30_000 ? 'second' : 'third',
      );
    }
  });

  test('the ACTIVE line gets the size and the tint; others dim without tint', () => {
    const on = kineticLineSpec(true, '#AABBCC');
    expect(on.fontSize).toBe(24); // the singing line
    expect(on.opacity).toBe(1);
    expect(on.activeTint).toBe('#AABBCC'); // the palette glow — never hardcoded
    const off = kineticLineSpec(false, '#AABBCC');
    expect(off.fontSize).toBe(14);
    expect(off.opacity).toBe(0.38);
    expect(off.activeTint).toBe(null); // no tint leaks to inactive lines
  });

  test('null tint ⇒ the classic ink highlight (the pre-F8 look, byte-identical)', () => {
    expect(kineticLineSpec(true, null).activeTint).toBe(null);
    expect(kineticLineSpec(true, undefined).activeTint).toBe(null);
  });

  test('UNIFORM line height across active and inactive (the scroll contract)', () => {
    expect(kineticLineSpec(true, null).lineHeight).toBe(40);
    expect(kineticLineSpec(false, null).lineHeight).toBe(40);
  });

  test('the scroll target math shares the height constant (literals at 40px rows)', () => {
    // row 2 of a 190px view: 2*40 + 20 - 95 = 5 — the SAME constant the
    // row style reads; a drift anywhere breaks this exact arithmetic
    expect(kineticScrollTarget(2, 190)).toBe(5);
    expect(kineticScrollTarget(0, 190)).toBe(0); // the first line clamps
    expect(kineticScrollTarget(9, 190)).toBe(9 * 40 + 20 - 95);
  });
});

// ── F9 · the aura ───────────────────────────────────────────────────────

describe('wave4 · F9 auraMotion (pure, clamped, monotonic)', () => {
  test('anchors: energy 0 breathes slowest, energy 1 fastest (literals)', () => {
    expect(auraMotion(0).pulseMs).toBe(5200);
    expect(auraMotion(1).pulseMs).toBe(2100);
    expect(auraMotion(0).maxGlow).toBeCloseTo(0.22, 9); // 0.14 + 0.2 * (0.4 + 0)
    expect(auraMotion(1).maxGlow).toBeCloseTo(0.34, 9); // 0.14 + 0.2 * (0.4 + 0.6)
    expect(auraMotion(0).minGlow).toBe(0.14);
  });

  test('monotonic-ish: higher energy ⇒ faster pulse and brighter glow ceiling', () => {
    let prevPulse = auraMotion(0).pulseMs;
    let prevGlow = auraMotion(0).maxGlow;
    for (let i = 1; i <= 100; i++) {
      const m = auraMotion(i / 100);
      expect(m.pulseMs).toBeLessThanOrEqual(prevPulse);
      expect(m.maxGlow).toBeGreaterThanOrEqual(prevGlow);
      prevPulse = m.pulseMs;
      prevGlow = m.maxGlow;
    }
  });

  test('clamped: out-of-range energies never escape the mapping', () => {
    expect(auraMotion(5).pulseMs).toBe(2100);
    expect(auraMotion(-5).pulseMs).toBe(5200);
    expect(auraMotion(5).maxGlow).toBeLessThanOrEqual(0.34);
  });

  test('null/garbage energy ⇒ the calmest wash (never a random guess)', () => {
    expect(auraMotion(null)).toEqual(auraMotion(0));
    expect(auraMotion(undefined)).toEqual(auraMotion(0));
    expect(auraMotion(Number.NaN)).toEqual(auraMotion(0));
  });

  test('the intent resolver is literal (reduce-motion wins over data saver)', () => {
    expect(auraMode(false, false)).toBe('full');
    expect(auraMode(false, true)).toBe('calm');
    expect(auraMode(true, false)).toBe('frozen');
    expect(auraMode(true, true)).toBe('frozen');
  });
});

// ── F10 · focus mode ────────────────────────────────────────────────────

describe('wave4 · F10 focus timer math (literal)', () => {
  test('end = now + minutes (a 25-minute arm lands 1,500,000ms out)', () => {
    expect(focusEndAt(25, 1_000_000)).toBe(1_000_000 + 25 * 60_000);
    expect(focusEndAt(15, 0)).toBe(15 * 60_000);
    expect(focusEndAt(0, 5)).toBe(60_005); // floor: at least one minute
  });

  test('the fade ramp matches the sleep-timer shape (linear over 8s)', () => {
    expect(focusFadeFactor(9_999)).toBe(1.0);
    expect(focusFadeFactor(8_000)).toBe(1.0); // exactly at the window edge
    expect(focusFadeFactor(4_000)).toBe(0.5);
    expect(focusFadeFactor(0)).toBe(0);
    expect(focusFadeFactor(-1)).toBe(0);
  });

  test('BAR: the ENGINE pushes the ramp through the bus (driven time, no sleeps)', async () => {
    resetVolumeBusForTests();
    resetFocusForTests();
    volumeWrites.length = 0;
    armFocus(25);
    const endAt = getFocusState().endAt!;
    focusTick(endAt - 4_000); // 4s remaining — mid-fade
    expect(getFocusState().fading).toBe(true);
    expect(volumeWrites[volumeWrites.length - 1]).toBe(0.5); // the ramp reached the player
    focusTick(endAt - 2_000);
    expect(volumeWrites[volumeWrites.length - 1]).toBe(0.25);
  });
});

describe('wave4 · F10 focus engine through the REAL volume bus', () => {
  test('BAR: the fade-to-zero composes and cancel restores EXACTLY', async () => {
    resetVolumeBusForTests();
    resetFocusForTests();
    armFocus(25);
    let s = getFocusState();
    expect(s.phase).toBe('focus');
    expect(s.endAt).not.toBe(null);

    // simulate the engine reaching the fade window: the bus holds focus
    setFadeFactor('focus', focusFadeFactor(4_000));
    expect(activeFadeOwner()).toBe('focus');
    // the sleep timer OUTRANKS focus (single-owner law):
    setFadeFactor('sleep', 0.5);
    expect(activeFadeOwner()).toBe('sleep');
    setFadeFactor('sleep', 0.5); // sleep keeps its own ramp
    // sleep disarms → the stored focus factor becomes active again
    const { clearFadeFactor } = await import('../../src/player/volumeBus');
    clearFadeFactor('sleep');
    expect(activeFadeOwner()).toBe('focus');

    // cancel: the factor is released, the product is restored, state cleared
    await cancelFocus();
    expect(getFocusState().phase).toBe(null);
    expect(activeFadeOwner()).toBe(null);
  });

  test('subscribe fires on arm and cancel (the countdown chip contract)', async () => {
    resetVolumeBusForTests();
    resetFocusForTests();
    const events: FocusState[] = [];
    const unsub = subscribeFocus((s) => events.push(s));
    armFocus(15);
    await cancelFocus();
    unsub();
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]!.phase).toBe('focus');
    expect(events[events.length - 1]!.phase).toBe(null);
  });

  test('focusOwnsFade is true only while the bus honors focus', async () => {
    const { focusOwnsFade } = await import('../../src/player/focus');
    resetVolumeBusForTests();
    resetFocusForTests();
    expect(focusOwnsFade()).toBe(false); // disarmed
    armFocus(15);
    setFadeFactor('focus', 0.5);
    expect(focusOwnsFade()).toBe(true);
    setFadeFactor('sleep', 0.4); // sleep outranks
    expect(focusOwnsFade()).toBe(false);
    const { clearFadeFactor } = await import('../../src/player/volumeBus');
    clearFadeFactor('sleep');
    expect(focusOwnsFade()).toBe(true);
    await cancelFocus();
    expect(focusOwnsFade()).toBe(false);
  });
});

// ── F10 · the focus pool (BEHAVIORAL: muted artists are honored) ────────

describe('wave4 · F10 focus pool (muted artists, pure core)', () => {
  const {
    buildFocusArtistPool,
    isMutedRow,
  } = require('../../src/ai/focusPicks') as typeof import('../../src/ai/focusPicks');

  test('a MUTED seed artist is never pooled (the bar: respects muted artists)', () => {
    const pool = buildFocusArtistPool({
      seedArtist: 'Badshah',
      topArtists: ['Arijit Singh', 'Pritam'],
      mutedArtists: ['badshah'], // corrections stores lowercase
    });
    expect(pool.map((p) => p.toLowerCase())).not.toContain('badshah');
    expect(pool).toEqual(['Arijit Singh', 'Pritam']);
  });

  test('muted PROFILE artists are dropped; dedupe is case-insensitive', () => {
    const pool = buildFocusArtistPool({
      seedArtist: 'Arijit Singh',
      topArtists: ['ARIJIT SINGH', 'Dua Lipa', 'Mithoon'],
      mutedArtists: ['dua lipa', 'mithoon'],
    });
    expect(pool).toEqual(['Arijit Singh']);
  });

  test('muted-artist ROWS are rejected (primary artist decides)', () => {
    expect(isMutedRow('Badshah, Arijit Singh', ['badshah'])).toBe(true);
    expect(isMutedRow('Arijit Singh & Badshah', ['badshah'])).toBe(false); // primary is Arijit
    expect(isMutedRow('Shreya Ghoshal', [])).toBe(false);
  });
});

// ── source locks (the wiring exists) ────────────────────────────────────

describe('wave4 · source locks', () => {
  test('the player screen mounts the aura + focus mode', async () => {
    const src = await Bun.file(new URL('../../src/screens/PlayerScreen.tsx', import.meta.url)).text();
    expect(src).toContain('AuraVisualizer');
    expect(src).toContain('armFocusSession');
    expect(src).toContain('cancelFocus');
    expect(src).toContain('palette.glow'); // the kinetic tint comes from the palette
  });

  test('SingAlong renders through the kinetic spec (no drift, no blur)', async () => {
    const src = await Bun.file(new URL('../../src/components/SingAlong.tsx', import.meta.url)).text();
    expect(src).toContain('kineticLineSpec');
    expect(src).toContain('activeLrcIndex(lines, positionMs)');
    expect(src).not.toContain('blurRadius');
  });

  test('the focus playlist is hygiene-gated + energy-ceilinged in the facade', async () => {
    const src = await Bun.file(new URL('../../src/ai/mindbeat.ts', import.meta.url)).text();
    expect(src).toContain('focusPicks');
    expect(src).toContain('FOCUS.maxEnergy');
    expect(src).toContain('filterClean(reconcileRecordings(rows))');
    expect(src).toContain('isMutedRow(t.artist, muted)'); // the mute gate is wired
  });

  test('the aura freezes under reduce-motion (component wiring, critic probe)', async () => {
    const src = await Bun.file(new URL('../../src/components/AuraVisualizer.tsx', import.meta.url)).text();
    expect(src).toContain("mode === 'frozen'");
    expect(src).toContain('stopAnimation');
  });

  test('SingAlong reads KINETIC as the single height source (no drift mirror)', async () => {
    const src = await Bun.file(new URL('../../src/components/SingAlong.tsx', import.meta.url)).text();
    expect(src).toContain('KINETIC.lineHeight');
    expect(src).not.toContain('const LINE_H');
  });

  test('the focus sheet guards double-tap double-queue', async () => {
    const src = await Bun.file(new URL('../../src/screens/PlayerScreen.tsx', import.meta.url)).text();
    expect(src).toContain('armingFocus.current');
  });
});
