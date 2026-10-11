/**
 * WAVE B · B1 — the ReplayGain locks.
 *
 * Evidence classes:
 *
 *  1. THE BAR as literals (X2 — no recomputed expectations): loudness
 *     −10 ⇒ −4 dB (quieter), −18 ⇒ +4 dB (louder), missing ⇒ 0 dB (no
 *     adjustment), the ±6 dB clamp on extreme masters, and the dB→linear
 *     conversion (10^(dB/20)) pinned to high-precision literals.
 *
 *  2. THE COMPOSITION through the REAL volume bus writing into a mocked
 *     TrackPlayer: smart volume × replay gain × fade — multiplied, not
 *     raced; the persistent factor survives a fade release; missing
 *     loudness writes EXACTLY what smart volume alone would write (the
 *     honest no-op); the ±6 dB band clamps a rogue factor; and the
 *     legacy two-argument composeVolume contract is untouched.
 *
 *  3. THE WIRING apply path: applyReplayGainForTrack pushes the linear
 *     factor through the bus and returns it.
 *
 * Mutations proven RED (worklog):
 *  M-B1-1  the gain factor dropped from recompute → composition locks fail;
 *  M-B1-2  the ±6 dB clamp removed from computeGain → clamp locks fail;
 *  M-B1-3  the missing-loudness guard removed → no-adjustment bar fails.
 */

import { describe, expect, test, beforeEach, mock } from 'bun:test';

// ── module mocks (bun per-file registry; same pattern as wave1 locks) ──
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

const volumeWrites: number[] = [];
mock.module('react-native-track-player', () => ({
  default: {
    setVolume: async (v: number) => {
      volumeWrites.push(v);
    },
  },
}));

const { computeGain, gainToLinear, replayGainFactor, applyReplayGainForTrack } = await import(
  '../src/player/replayGain'
);
const {
  composeVolume,
  setSmartVolumeMultiplier,
  setReplayGainFactor,
  setFadeFactor,
  clearFadeFactor,
  resetVolumeBusForTests,
} = await import('../src/player/volumeBus');
const { REPLAY_GAIN } = await import('../src/ai/core/constants');

beforeEach(() => {
  resetVolumeBusForTests();
  volumeWrites.length = 0;
});

describe('WAVE B · B1 — the pure core: computeGain (THE BAR as literals)', () => {
  test('loudness −10 (a loud master) ⇒ −4 dB gain — QUIETER', () => {
    expect(computeGain({ loudness: -10 })).toBe(-4);
  });

  test('loudness −18 (a quiet indie song) ⇒ +4 dB gain — LOUDER', () => {
    expect(computeGain({ loudness: -18 })).toBe(4);
  });

  test('missing loudness ⇒ 0 dB — no adjustment, the honest no-op', () => {
    expect(computeGain({})).toBe(0);
    expect(computeGain({ loudness: undefined })).toBe(0);
    expect(computeGain({ loudness: null })).toBe(0);
    expect(computeGain({ loudness: NaN })).toBe(0);
    expect(computeGain({ loudness: Infinity })).toBe(0);
  });

  test('the ±6 dB clamp holds on extreme masters', () => {
    // −14 − 5 = −19 ⇒ clamped to −6 (a brutal master can only be cut so much)
    expect(computeGain({ loudness: -5 })).toBe(-6);
    // −14 − (−40) = +26 ⇒ clamped to +6 (a whisper master can only be lifted so much)
    expect(computeGain({ loudness: -40 })).toBe(6);
    // at the exact target: 0 dB
    expect(computeGain({ loudness: -14 })).toBe(0);
  });

  test('dB→linear: 10^(dB/20) — 0 dB is EXACTLY 1.0', () => {
    expect(gainToLinear(0)).toBe(1);
    expect(gainToLinear(-4)).toBeCloseTo(0.6309573444801932, 12);
    expect(gainToLinear(4)).toBeCloseTo(1.5848931924611136, 12);
    expect(gainToLinear(-6)).toBeCloseTo(REPLAY_GAIN.minFactor, 12);
    expect(gainToLinear(6)).toBeCloseTo(REPLAY_GAIN.maxFactor, 12);
  });

  test('replayGainFactor composes the two: missing ⇒ EXACTLY 1.0', () => {
    expect(replayGainFactor(-10)).toBeCloseTo(0.6309573444801932, 12);
    expect(replayGainFactor(-18)).toBeCloseTo(1.5848931924611136, 12);
    expect(replayGainFactor(null)).toBe(1);
    expect(replayGainFactor(undefined)).toBe(1);
    // a track-shaped input works too (future loudness sources plug in)
    expect(replayGainFactor({ loudness: -10 })).toBeCloseTo(0.6309573444801932, 12);
  });
});

describe('WAVE B · B1 — the bus composition (multiplied, not raced)', () => {
  test('THE bar: smart 0.85 × replayGain(−4 dB) × sleep fade 0.5 — all three multiply', () => {
    setSmartVolumeMultiplier(0.85);
    setReplayGainFactor(gainToLinear(-4)); // 0.6309573444801932
    setFadeFactor('sleep', 0.5);
    const expected = 0.85 * 0.6309573444801932 * 0.5;
    expect(volumeWrites[volumeWrites.length - 1]).toBeCloseTo(expected, 12);
  });

  test('the +4 dB quiet-track boost SURVIVES the bus (the old 1.05 write ceiling is not repeated on the gain axis)', () => {
    setReplayGainFactor(gainToLinear(4)); // 1.5848931924611136
    expect(volumeWrites[volumeWrites.length - 1]).toBeCloseTo(1.5848931924611136, 12);
    // with the smart lift stacked: 1.05 × 1.584893… — the honest ceiling is the PRODUCT band
    setSmartVolumeMultiplier(1.05);
    expect(volumeWrites[volumeWrites.length - 1]).toBeCloseTo(1.05 * 1.5848931924611136, 12);
  });

  test('ReplayGain is PERSISTENT: it survives a fade release (it is not a fade owner)', () => {
    setSmartVolumeMultiplier(0.85);
    setReplayGainFactor(gainToLinear(-4));
    setFadeFactor('sleep', 0.5);
    clearFadeFactor('sleep');
    // the sleep fade is gone, but the gain REMAINS (persistent, not a ramp)
    expect(volumeWrites[volumeWrites.length - 1]).toBeCloseTo(0.85 * 0.6309573444801932, 12);
    // and it never claimed the single-owner slot
    expect(composeVolume.length).toBeGreaterThanOrEqual(2); // signature accepts 2 args
  });

  test('missing loudness end-to-end: the write is EXACTLY smart volume alone', () => {
    setSmartVolumeMultiplier(0.9);
    const before = volumeWrites[volumeWrites.length - 1];
    const applied = applyReplayGainForTrack(null);
    expect(applied).toBe(1);
    expect(volumeWrites[volumeWrites.length - 1]).toBe(before); // byte-identical write
  });

  test('applyReplayGainForTrack pushes the linear factor through the bus', () => {
    setSmartVolumeMultiplier(1.0);
    const applied = applyReplayGainForTrack(-18); // +4 dB
    expect(applied).toBeCloseTo(1.5848931924611136, 12);
    expect(volumeWrites[volumeWrites.length - 1]).toBeCloseTo(1.5848931924611136, 12);
    // the next track has no loudness evidence → back to exactly 1.0
    applyReplayGainForTrack(null);
    expect(volumeWrites[volumeWrites.length - 1]).toBe(1);
  });

  test('a rogue gain factor is clamped to the ±6 dB band — never a run-away write', () => {
    setReplayGainFactor(9); // would be +19 dB — the band says no
    expect(volumeWrites[volumeWrites.length - 1]).toBeCloseTo(REPLAY_GAIN.maxFactor, 12);
    resetVolumeBusForTests();
    volumeWrites.length = 0;
    setReplayGainFactor(0.01); // would be −40 dB — the band says no
    expect(volumeWrites[volumeWrites.length - 1]).toBeCloseTo(REPLAY_GAIN.minFactor, 12);
    resetVolumeBusForTests();
    volumeWrites.length = 0;
    setReplayGainFactor(NaN); // garbage degrades to 1.0 — and the write-dedup skips the no-op
    expect(volumeWrites.length).toBe(0); // nothing written…
    setSmartVolumeMultiplier(0.5); // …and the NEXT real write is NOT NaN-poisoned
    expect(volumeWrites[volumeWrites.length - 1]).toBe(0.5); // 1.0 × 1.0 × 0.5
  });

  test('THE CEILING of the composition is the honest product band (1.05 × 10^(6/20))', () => {
    expect(composeVolume(9, 1, 9)).toBeCloseTo(1.05 * REPLAY_GAIN.maxFactor, 12);
    // negative anything ⇒ 0
    expect(composeVolume(-3, 1, 1)).toBe(0);
  });

  test('the LEGACY two-argument composeVolume contract is untouched (0.5 × 0.85 = 0.425)', () => {
    expect(composeVolume(0.85, 0.5)).toBe(0.425);
    expect(composeVolume(9, 1)).toBe(1.05);
    expect(composeVolume(9, 0.5)).toBeCloseTo(0.525, 10);
  });
});
