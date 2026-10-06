/**
 * THE TEN · WAVE 1 LOCKS — the playback engine (F1/F2/F3).
 *
 *   F1 Smart Volume — the curve is locked against LITERALS (X2): null ⇒
 *      1.0, energy 1.0 ⇒ 0.82, energy 0 ⇒ 1.05, the clamp [0.8, 1.05],
 *      monotonicity, toggle-off byte-identity, and the mission's own
 *      composition example 0.5 × 0.85 = 0.425 through the REAL volume
 *      bus writing into a mocked TrackPlayer.
 *   F2 Crossfade — clamp 0–12 (garbage ⇒ 0), the pure fade curve, and
 *      the engine contract: 0 = no fade (bus untouched), a setting
 *      change takes effect on the next transition, ramp resets on a new
 *      track and releases on queue end.
 *   F3 Playback rate — the allowed set snaps (literals), the choice
 *      persists (real in-memory storage round-trip) and re-applies.
 *
 * Mutation targets (scripts/mutation_v42.sh W1-*): remove the smart
 * volume clamp, replace composeVolume's multiply with max, break the
 * fade-curve guard, un-snap the rate set. The critic round added the
 * missing pins: toggle-off immediate re-apply (P0-1), the crossfade
 * boot restore (P0-2 — a proven surviving mutation before it), the
 * transition-instant ramp release, and the seek-backstop mechanism.
 */

import { describe, expect, test, mock } from 'bun:test';

// ── module mocks (bun per-file registry; same pattern as feed_query_locks) ──
// NOTE: bun hoists STATIC imports above runtime mock.module calls, so the
// modules under test are loaded with top-level await AFTER the mocks —
// otherwise the real react-native(-track-player) graph parses and dies.

// Real in-memory AsyncStorage so the store round-trips are HONEST.
const memStore = new Map<string, string>();
mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => memStore.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      memStore.set(k, v);
    },
    removeItem: async (k: string) => {
      memStore.delete(k);
    },
    multiRemove: async (ks: string[]) => {
      for (const k of ks) memStore.delete(k);
    },
  },
}));
mock.module('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: 'active' },
  Platform: { OS: 'android', select: (o: any) => o.android },
  NativeModules: {},
}));

// TrackPlayer recorder — the bus's writes are the behavior under test.
const volumeWrites: number[] = [];
const rateWrites: number[] = [];
mock.module('react-native-track-player', () => ({
  default: {
    setVolume: async (v: number) => {
      volumeWrites.push(v);
    },
    setRate: async (r: number) => {
      rateWrites.push(r);
    },
  },
}));

const {
  smartVolumeMultiplier,
  effectiveSmartMultiplier,
  applySmartVolumeForTrack,
  setSmartVolumeActive,
  resetSmartVolumeForTests,
} = await import('../../src/player/smartVolume');
const {
  composeVolume,
  setSmartVolumeMultiplier,
  setFadeFactor,
  clearFadeFactor,
  activeFadeOwner,
  resetVolumeBusForTests,
} = await import('../../src/player/volumeBus');
const {
  clampCrossfadeSeconds,
  fadeFactorFor,
  crossfadeTick,
  resetCrossfadeRamp,
  setCrossfadeSeconds,
  initCrossfade,
  crossfadeSeconds,
  resetCrossfadeForTests,
} = await import('../../src/player/crossfade');
const {
  nearestAllowedRate,
  setPlaybackRate,
  initPlaybackRate,
  currentRate,
  resetPlaybackRateForTests,
} = await import('../../src/player/playbackRate');

const EPS = 1e-9;

// ── F1 · Smart Volume ───────────────────────────────────────────────────

describe('wave1 · F1 smartVolumeMultiplier (literal curve locks)', () => {
  test('no baked features ⇒ exactly 1.0 (null / undefined / NaN / Infinity)', () => {
    expect(smartVolumeMultiplier(null)).toBe(1.0);
    expect(smartVolumeMultiplier(undefined)).toBe(1.0);
    expect(smartVolumeMultiplier(Number.NaN)).toBe(1.0);
    expect(smartVolumeMultiplier(Number.POSITIVE_INFINITY)).toBe(1.0);
  });

  test('curve anchors: 1.0 ⇒ 0.82, 0 ⇒ 1.05, mid-range untouched', () => {
    expect(smartVolumeMultiplier(1.0)).toBeCloseTo(0.82, 12);
    expect(smartVolumeMultiplier(0.0)).toBeCloseTo(1.05, 12);
    expect(smartVolumeMultiplier(0.5)).toBe(1.0);
    expect(smartVolumeMultiplier(0.85)).toBe(1.0); // boundary: attenuation begins ABOVE
    expect(smartVolumeMultiplier(0.3)).toBe(1.0); // boundary: lift begins BELOW
  });

  test('midpoints of both ramps are exact literals (0.91 and 1.025)', () => {
    // halfway up the attenuation ramp (e = 0.925)
    expect(smartVolumeMultiplier(0.925)).toBeCloseTo(0.91, 12);
    // halfway up the lift ramp (e = 0.15)
    expect(smartVolumeMultiplier(0.15)).toBeCloseTo(1.025, 12);
  });

  test('clamped to [0.8, 1.05] even for out-of-range energies', () => {
    expect(smartVolumeMultiplier(5)).toBe(0.8); // wild banger → floor, not negative
    expect(smartVolumeMultiplier(-5)).toBe(1.05); // absurd quiet → ceiling
    expect(smartVolumeMultiplier(1e9)).toBe(0.8);
  });

  test('monotonic-ish: higher energy NEVER raises the multiplier', () => {
    let prev = smartVolumeMultiplier(0);
    expect(prev).toBe(1.05);
    for (let i = 1; i <= 100; i++) {
      const e = i / 100;
      const m = smartVolumeMultiplier(e);
      expect(m).toBeLessThanOrEqual(prev + EPS);
      prev = m;
    }
    expect(prev).toBeCloseTo(0.82, 12);
  });

  test('toggle OFF ⇒ byte-identical volume: 1.0 for ANY energy', () => {
    for (const e of [0, 0.15, 0.3, 0.5, 0.85, 0.925, 1, 5, -5]) {
      expect(effectiveSmartMultiplier(e, false)).toBe(1.0);
    }
    // and ON still shapes the curve
    expect(effectiveSmartMultiplier(1, true)).toBeCloseTo(0.82, 12);
  });

  test('apply path pushes the shaped multiplier through the real bus', () => {
    resetVolumeBusForTests();
    volumeWrites.length = 0;
    resetSmartVolumeForTests(); // default ON
    const m = applySmartVolumeForTrack(1.0);
    expect(m).toBeCloseTo(0.82, 12);
    expect(volumeWrites[volumeWrites.length - 1]).toBeCloseTo(0.82, 12);
    // a track with no baked row is a no-op multiplier
    const m2 = applySmartVolumeForTrack(null);
    expect(m2).toBe(1.0);
    expect(volumeWrites[volumeWrites.length - 1]).toBe(1.0);
  });
});

describe('wave1 · F1 volume bus composition (the race the mission forbids)', () => {
  test('THE bar: sleep fade 0.5 × smart volume 0.85 = 0.425 — multiplied, not overwritten', () => {
    expect(composeVolume(0.85, 0.5)).toBe(0.425);
  });

  test('the bus WRITES 0.425 into TrackPlayer when both sources report', () => {
    resetVolumeBusForTests();
    volumeWrites.length = 0;
    setSmartVolumeMultiplier(0.85);
    setFadeFactor('sleep', 0.5);
    expect(volumeWrites[volumeWrites.length - 1]).toBe(0.425);
    // releasing the sleep fade returns to the multiplier alone
    clearFadeFactor('sleep');
    expect(volumeWrites[volumeWrites.length - 1]).toBe(0.85);
  });

  // ── v4.3.1 (auditor BAR 2): the volume bus LIE — the old clamp
  // Math.min(1, multiplier) silently ate the Smart Volume quiet-track
  // lift (curve said 1.05; the speaker got 1.0). These locks watch the
  // ACTUAL write, so restoring the fake ceiling is a RED mutation.

  test('the lift is REAL: a quiet track (energy 0) writes 1.05 — ABOVE the old fake ceiling', () => {
    resetVolumeBusForTests();
    volumeWrites.length = 0;
    // the energy→multiplier curve runs, then the bus must ship it intact
    setSmartVolumeMultiplier(smartVolumeMultiplier(0.0));
    const written = volumeWrites[volumeWrites.length - 1];
    expect(written).toBeCloseTo(1.05, 10); // exactly the lift target
    expect(written).toBeGreaterThan(1.0); // the whole point — louder, not fake-flat
    // a mid-lift quiet track (energy 0.15 ⇒ 1.025) also survives the bus
    setSmartVolumeMultiplier(smartVolumeMultiplier(0.15));
    expect(volumeWrites[volumeWrites.length - 1]).toBeCloseTo(1.025, 10);
  });

  test('the ceiling is SMART_VOLUME.max, not 1.0 — a rogue multiplier cannot run away', () => {
    // composition-level: a misbehaving multiplier is clamped to the lift
    // ceiling (1.05), NEVER silently flattened to 1.0, NEVER unclamped
    expect(composeVolume(9, 1)).toBe(1.05);
    expect(composeVolume(9, 0.5)).toBeCloseTo(0.525, 10); // 1.05 × 0.5
    expect(composeVolume(-3, 1)).toBe(0);
    // gate-level: setSmartVolumeMultiplier clamps to the same ceiling
    resetVolumeBusForTests();
    volumeWrites.length = 0;
    setSmartVolumeMultiplier(9);
    expect(volumeWrites[volumeWrites.length - 1]).toBe(1.05);
    resetVolumeBusForTests();
  });

  test('single-owner precedence: sleep > focus > crossfade', () => {
    resetVolumeBusForTests();
    volumeWrites.length = 0;
    setSmartVolumeMultiplier(1.0);
    setFadeFactor('crossfade', 0.3);
    setFadeFactor('focus', 0.2);
    setFadeFactor('sleep', 0.5);
    expect(activeFadeOwner()).toBe('sleep');
    expect(volumeWrites[volumeWrites.length - 1]).toBe(0.5);
    // sleep disarms → focus takes over; the crossfade factor NEVER wins
    // while a higher-priority owner is held
    clearFadeFactor('sleep');
    expect(activeFadeOwner()).toBe('focus');
    expect(volumeWrites[volumeWrites.length - 1]).toBe(0.2);
    clearFadeFactor('focus');
    expect(activeFadeOwner()).toBe('crossfade');
    expect(volumeWrites[volumeWrites.length - 1]).toBe(0.3);
    clearFadeFactor('crossfade');
    expect(activeFadeOwner()).toBe(null);
    expect(volumeWrites[volumeWrites.length - 1]).toBe(1.0);
  });

  test('BAR: toggling OFF re-applies 1.0 IMMEDIATELY — even mid-fade (critic P0-1)', async () => {
    resetVolumeBusForTests();
    resetSmartVolumeForTests(); // default ON
    volumeWrites.length = 0;
    applySmartVolumeForTrack(1.0); // baked banger → 0.82
    setFadeFactor('sleep', 0.5); // sleep fade active → composes 0.82 × 0.5
    expect(volumeWrites[volumeWrites.length - 1]).toBe(0.41);
    await setSmartVolumeActive(false); // the listener toggles OFF
    expect(volumeWrites[volumeWrites.length - 1]).toBe(0.5); // 1.0 × 0.5 — shaping gone THIS instant
    // ...and toggling back ON restores the shaping through the same path
    await setSmartVolumeActive(true);
    expect(volumeWrites[volumeWrites.length - 1]).toBe(0.41);
  });

  test('the toggle re-applies the LAST SEEN track energy (null included)', async () => {
    resetVolumeBusForTests();
    resetSmartVolumeForTests();
    volumeWrites.length = 0;
    applySmartVolumeForTrack(1.0); // baked banger → 0.82 (baseline write)
    applySmartVolumeForTrack(null); // next track has no baked row → back to 1.0
    expect(volumeWrites[volumeWrites.length - 1]).toBe(1.0);
    await setSmartVolumeActive(false); // OFF with no baked energy → still exactly 1.0
    expect(volumeWrites[volumeWrites.length - 1]).toBe(1.0);
  });

  test('out-of-range owner factors are clamped before the write', () => {
    resetVolumeBusForTests();
    volumeWrites.length = 0;
    setSmartVolumeMultiplier(1.0);
    setFadeFactor('sleep', 0.5); // establish a mid-fade baseline (writes 0.5)
    expect(volumeWrites[volumeWrites.length - 1]).toBe(0.5);
    setFadeFactor('sleep', 2.0); // clamped to 1.0 → the fade releases
    expect(volumeWrites[volumeWrites.length - 1]).toBe(1.0);
    setFadeFactor('sleep', -3); // clamped to 0.0
    expect(volumeWrites[volumeWrites.length - 1]).toBe(0);
  });
});

// ── F2 · Crossfade ──────────────────────────────────────────────────────

describe('wave1 · F2 crossfade (clamp + curve + engine contract)', () => {
  test('clamp: 0–12 hard, garbage ⇒ 0, strings parse, rounding', () => {
    expect(clampCrossfadeSeconds(13)).toBe(12);
    expect(clampCrossfadeSeconds(-3)).toBe(0);
    expect(clampCrossfadeSeconds(0)).toBe(0);
    expect(clampCrossfadeSeconds(12)).toBe(12);
    expect(clampCrossfadeSeconds(5.4)).toBe(5);
    expect(clampCrossfadeSeconds('7')).toBe(7);
    expect(clampCrossfadeSeconds(Number.NaN)).toBe(0);
    expect(clampCrossfadeSeconds(undefined)).toBe(0);
    expect(clampCrossfadeSeconds({ junk: true })).toBe(0);
  });

  test('fade curve: linear ramp inside the window, 1.0 outside', () => {
    expect(fadeFactorFor(0, 200, 10)).toBe(1.0); // far from the end
    expect(fadeFactorFor(90, 100, 10)).toBe(1.0); // exactly at the window edge
    expect(fadeFactorFor(95, 100, 10)).toBe(0.5);
    expect(fadeFactorFor(92.5, 100, 10)).toBe(0.75);
    expect(fadeFactorFor(100, 100, 10)).toBe(0);
    expect(fadeFactorFor(105, 100, 10)).toBe(0); // overrun clamps
  });

  test('fade curve guards: fadeSeconds 0 and unknown duration NEVER fade', () => {
    // fadeSeconds 0 ⇒ no fade even at the exact track end
    expect(fadeFactorFor(100, 100, 0)).toBe(1.0);
    expect(fadeFactorFor(99, 100, 0)).toBe(1.0);
    // unknown duration (0) ⇒ no fade — never ramp on a fake timeline
    expect(fadeFactorFor(95, 0, 5)).toBe(1.0);
  });

  test('BAR: value 0 produces NO fade — the bus is never touched', () => {
    resetVolumeBusForTests();
    resetCrossfadeForTests();
    volumeWrites.length = 0;
    void setCrossfadeSeconds(0);
    crossfadeTick(95, 100); // inside what WOULD be the window
    crossfadeTick(99, 100);
    crossfadeTick(100, 100);
    expect(volumeWrites.length).toBe(0); // byte-identical to today
    expect(activeFadeOwner()).toBe(null);
  });

  test('BAR: a setting change takes effect for the next transition', () => {
    resetVolumeBusForTests();
    resetCrossfadeForTests();
    volumeWrites.length = 0;
    void setCrossfadeSeconds(10);
    crossfadeTick(95, 100);
    expect(volumeWrites[volumeWrites.length - 1]).toBe(0.5); // 10s fade active
    void setCrossfadeSeconds(0); // the listener switches OFF
    expect(volumeWrites[volumeWrites.length - 1]).toBe(1.0); // ramp released
    crossfadeTick(97, 100);
    expect(volumeWrites[volumeWrites.length - 1]).toBe(1.0); // no new writes
  });

  test('new track (playhead jump backwards) resets the ramp cleanly', () => {
    resetVolumeBusForTests();
    resetCrossfadeForTests();
    volumeWrites.length = 0;
    void setCrossfadeSeconds(10);
    crossfadeTick(96, 100);
    expect(volumeWrites[volumeWrites.length - 1]).toBeCloseTo(0.4, 12);
    crossfadeTick(1, 220); // the next track landed
    expect(activeFadeOwner()).toBe(null); // ramp released, fresh 1.0
    expect(volumeWrites[volumeWrites.length - 1]).toBe(1.0);
    resetCrossfadeRamp(); // idempotent release
    expect(activeFadeOwner()).toBe(null);
  });

  test('seek backstop: rewinds past the tolerance reset the ramp (mechanism pinned)', () => {
    resetVolumeBusForTests();
    resetCrossfadeForTests();
    volumeWrites.length = 0;
    void setCrossfadeSeconds(10);
    crossfadeTick(98, 100); // track A near its end → 0.2
    expect(volumeWrites[volumeWrites.length - 1]).toBeCloseTo(0.2, 12);
    // a REWIND (not a new track — duration 5 means the old numbers are gone
    // too): the backstop must release the ramp BEFORE re-deriving the factor
    crossfadeTick(1, 5);
    expect(volumeWrites[volumeWrites.length - 2]).toBe(1.0); // the release happened
    expect(volumeWrites[volumeWrites.length - 1]).toBeCloseTo(0.4, 12); // then the new curve
  });

  test('BAR: persisted read — the boot restore re-applies the saved seconds (critic P0-2)', async () => {
    resetCrossfadeForTests();
    resetVolumeBusForTests();
    volumeWrites.length = 0;
    memStore.set('tsf.crossfade.v1', JSON.stringify(7));
    initCrossfade();
    await new Promise((r) => setTimeout(r, 0)); // let the boot read land
    expect(crossfadeSeconds()).toBe(7);
    // the restored value is LIVE: 6s remaining sits inside the 7s window
    crossfadeTick(94, 100);
    expect(volumeWrites[volumeWrites.length - 1]).toBeCloseTo(6 / 7, 12);
  });

  test('persisted write: the setting lands in tsf.crossfade.v1', async () => {
    resetCrossfadeForTests();
    memStore.clear();
    await setCrossfadeSeconds(6);
    expect(memStore.get('tsf.crossfade.v1')).toBe('6');
  });

  test('source lock: the service releases the ramp at the transition instant (critic P1-3)', async () => {
    const src = await Bun.file(new URL('../../src/player/service.ts', import.meta.url)).text();
    // The pairing is pinned: resetCrossfadeRamp must sit INSIDE the
    // PlaybackActiveTrackChanged listener — not just anywhere in the file
    // (critic R2 MINOR-3: the string alone also matches the queue-ended
    // handler, which would let a gutted listener stay green).
    const listener = src.match(/addEventListener\(Event\.PlaybackActiveTrackChanged,\s*\(\)\s*=>\s*\{([\s\S]*?)\}\)/);
    expect(listener).not.toBeNull();
    expect(listener![1]).toContain('resetCrossfadeRamp()');
  });
});

// ── F3 · Playback rate ──────────────────────────────────────────────────

describe('wave1 · F3 playback rate (snapping + persistence)', () => {
  test('the allowed set is exactly the five chips (literal)', () => {
    expect(nearestAllowedRate(0.75)).toBe(0.75);
    expect(nearestAllowedRate(1.0)).toBe(1.0);
    expect(nearestAllowedRate(1.25)).toBe(1.25);
    expect(nearestAllowedRate(1.5)).toBe(1.5);
    expect(nearestAllowedRate(2.0)).toBe(2.0);
  });

  test('anything else snaps to the nearest member', () => {
    expect(nearestAllowedRate(1.3)).toBe(1.25);
    expect(nearestAllowedRate(1.4)).toBe(1.5);
    expect(nearestAllowedRate(0.1)).toBe(0.75);
    expect(nearestAllowedRate(3)).toBe(2.0);
    expect(nearestAllowedRate(Number.NaN)).toBe(1.0);
    expect(nearestAllowedRate('junk')).toBe(1.0);
  });

  test('set persists to tsf.playbackRate.v1 AND applies to the engine', async () => {
    memStore.clear();
    rateWrites.length = 0;
    resetPlaybackRateForTests();
    await setPlaybackRate(1.5);
    expect(currentRate()).toBe(1.5);
    expect(memStore.get('tsf.playbackRate.v1')).toBe('1.5');
    expect(rateWrites[rateWrites.length - 1]).toBe(1.5);
    // an off-set value still persists the SNAPPED member
    await setPlaybackRate(1.33);
    expect(currentRate()).toBe(1.25);
    expect(memStore.get('tsf.playbackRate.v1')).toBe('1.25');
  });

  test('persisted read: boot restore re-applies the saved rate', async () => {
    memStore.clear();
    rateWrites.length = 0;
    resetPlaybackRateForTests();
    memStore.set('tsf.playbackRate.v1', JSON.stringify(2));
    initPlaybackRate();
    await new Promise((r) => setTimeout(r, 0)); // let the boot read land
    expect(currentRate()).toBe(2.0);
    expect(rateWrites[rateWrites.length - 1]).toBe(2.0);
    // corrupt payload → the boot default, never a crash
    memStore.set('tsf.playbackRate.v1', JSON.stringify({ broken: true }));
    resetPlaybackRateForTests();
    initPlaybackRate();
    await new Promise((r) => setTimeout(r, 0));
    expect(currentRate()).toBe(1.0);
  });
});
