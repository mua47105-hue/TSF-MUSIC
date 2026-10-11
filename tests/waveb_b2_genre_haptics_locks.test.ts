/**
 * WAVE B · B2 — the genre-aware haptic locks.
 *
 * Evidence classes:
 *
 *  1. THE PATTERN TABLE as literals: the five genre families pin their
 *     exact spec (fireOn slots within a 4/4 bar + impact style), and
 *     compound catalog strings ("Hip-Hop/Rap", "Alternative Rock",
 *     "lo-fi hip hop") resolve through the containment pass.
 *
 *  2. THE BAR end-to-end through hapticEvent: an EDM track at the same
 *     BPM as a classical track FEELS different — heavy only on beat 1
 *     of every bar vs a soft tick on every beat; bollywood fires the 1
 *     and 3 downbeats; lofi/ambient stay still BY DEFAULT and the
 *     'uniform' mode is the override; missing/unknown genre is
 *     byte-identical to the pre-B2 uniform tick.
 *
 *  3. THE MODE LAW: 'off' silences every beat tick; 'uniform' forces
 *     the legacy behavior even for genre-carrying tracks; the
 *     persisted setting round-trips (real in-memory AsyncStorage) and
 *     a corrupted value degrades to 'auto'. The hydration gate and the
 *     reducedHaptics switch remain the first laws.
 *
 * Mutations proven RED (worklog):
 *  M-B2-1  the genre branch removed (hapticPattern always uniform) →
 *          pattern + event locks fail;
 *  M-B2-2  the lofi/ambient disabled branch removed → the stillness
 *          locks fail;
 *  M-B2-3  the 'off' mode gate removed → the mode law locks fail.
 */

import { describe, expect, test, beforeEach, mock } from 'bun:test';

// ── module mocks (bun per-file registry; same pattern as wave3 locks) ──
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

const { hapticPattern, hapticEvent, markHapticsHydrated, resetHapticsHydrationForTests } =
  await import('../src/player/haptics');
const { getHapticGenreModeSetting, setHapticGenreMode } = await import('../src/storage/store');
const { HAPTICS } = await import('../src/ai/core/constants');

// mid ≈ 667ms per beat (HAPTICS.beatIntervalMs.mid) — the shared BPM the
// brief uses to prove genre, not tempo, drives the pattern.
const MID = HAPTICS.beatIntervalMs.mid;

function tick(
  genre: string | null | undefined,
  elapsedMs: number,
  opts: { lastBeatIndex?: number; genreMode?: 'auto' | 'uniform' | 'off'; reduced?: boolean } = {},
) {
  return hapticEvent(
    'beat-tick',
    { tempoClass: 'mid', genre },
    elapsedMs,
    {
      reducedHaptics: opts.reduced ?? false,
      lastBeatIndex: opts.lastBeatIndex ?? -1,
      genreMode: opts.genreMode,
    },
  );
}

beforeEach(() => {
  memStore.clear();
  resetHapticsHydrationForTests();
  markHapticsHydrated(); // the hydrated happy path; the gate has its own test
});

describe('WAVE B · B2 — the pattern table (pure, literal)', () => {
  test('EDM/Hip-hop: heavy on beat 1 of every bar only', () => {
    for (const g of ['edm', 'Hip-Hop/Rap', 'EDM', 'rap', 'trap']) {
      const p = hapticPattern(g, 'mid');
      expect(p).toEqual({ fireOn: [0], style: 'heavy', disabled: false });
    }
  });

  test('Classical/Jazz: a soft tick on every beat', () => {
    for (const g of ['classical', 'jazz', 'Classical']) {
      expect(hapticPattern(g, 'fast')).toEqual({ fireOn: [0, 1, 2, 3], style: 'soft', disabled: false });
    }
  });

  test('Bollywood: medium on the downbeats (beats 1 and 3)', () => {
    expect(hapticPattern('bollywood', 'mid')).toEqual({ fireOn: [0, 2], style: 'medium', disabled: false });
  });

  test('Lofi/Ambient: still by default (disabled, no beats)', () => {
    for (const g of ['lofi', 'lo-fi hip hop', 'ambient', 'chillhop']) {
      expect(hapticPattern(g, 'slow')).toEqual({ fireOn: [], style: 'soft', disabled: true });
    }
  });

  test('Rock/Pop: medium on every beat (compound strings resolve)', () => {
    for (const g of ['rock', 'Alternative Rock', 'pop', 'K-Pop']) {
      expect(hapticPattern(g, 'mid')).toEqual({ fireOn: [0, 1, 2, 3], style: 'medium', disabled: false });
    }
  });

  test('missing/unknown genre ⇒ the UNIFORM fallback (the pre-B2 tick, byte-identical)', () => {
    for (const g of [undefined, null, '', 'mongolian throat singing']) {
      expect(hapticPattern(g, 'slow')).toEqual({ fireOn: [0, 1, 2, 3], style: 'soft', disabled: false });
      expect(hapticPattern(g, 'mid')).toEqual({ fireOn: [0, 1, 2, 3], style: 'light', disabled: false });
      expect(hapticPattern(g, 'fast')).toEqual({ fireOn: [0, 1, 2, 3], style: 'light', disabled: false });
    }
  });
});

describe('WAVE B · B2 — THE BAR end-to-end: same BPM, different wrist', () => {
  test('an EDM track at mid tempo: heavy ONLY when (beatIndex % 4) === 0', () => {
    // the engine's interval floor makes beat index 1 the FIRST fireable
    // tick (t=0 never fires — the pre-B2 law), so the bar-1 downbeats
    // land on indices 4, 8, 12 … every 4th tick, and nothing between
    expect(tick('edm', MID * 1)).toBeNull(); // index 1 — slot 1
    expect(tick('edm', MID * 2, { lastBeatIndex: 1 })).toBeNull(); // slot 2
    expect(tick('edm', MID * 3, { lastBeatIndex: 1 })).toBeNull(); // slot 3
    const b4 = tick('edm', MID * 4, { lastBeatIndex: 1 }); // slot 0 — THE bar hit
    expect(b4).toEqual({ spec: { kind: 'impact', style: 'heavy' }, beatIndex: 4 });
    expect(tick('edm', MID * 5, { lastBeatIndex: 4 })).toBeNull(); // slot 1 — silent
    expect(tick('edm', MID * 7, { lastBeatIndex: 4 })).toBeNull(); // slot 3 — silent
    const b8 = tick('edm', MID * 8, { lastBeatIndex: 4 }); // slot 0 again — the next bar
    expect(b8).toEqual({ spec: { kind: 'impact', style: 'heavy' }, beatIndex: 8 });
  });

  test('a classical track at the SAME tempo: a soft tick on EVERY beat', () => {
    for (let n = 1; n <= 4; n++) {
      const d = tick('classical', MID * n, { lastBeatIndex: n - 2 });
      expect(d).toEqual({ spec: { kind: 'impact', style: 'soft' }, beatIndex: n });
    }
  });

  test('a bollywood track: medium on the downbeat slots (0 and 2), silent between', () => {
    expect(tick('bollywood', MID * 1)).toBeNull(); // slot 1
    expect(tick('bollywood', MID * 2, { lastBeatIndex: 1 })).toEqual({ spec: { kind: 'impact', style: 'medium' }, beatIndex: 2 }); // slot 2
    expect(tick('bollywood', MID * 3, { lastBeatIndex: 2 })).toBeNull(); // slot 3
    expect(tick('bollywood', MID * 4, { lastBeatIndex: 2 })).toEqual({ spec: { kind: 'impact', style: 'medium' }, beatIndex: 4 }); // slot 0
  });

  test('a rock track: medium on every beat', () => {
    expect(tick('rock', MID * 1)).toEqual({ spec: { kind: 'impact', style: 'medium' }, beatIndex: 1 });
    expect(tick('pop', MID * 2, { lastBeatIndex: 1 })).toEqual({ spec: { kind: 'impact', style: 'medium' }, beatIndex: 2 });
  });

  test('lofi/ambient: the wrist stays still BY DEFAULT — the uniform mode is the override', () => {
    expect(tick('lofi', MID * 1)).toBeNull();
    expect(tick('ambient', MID * 4, { lastBeatIndex: 1 })).toBeNull();
    // the override: 'uniform' un-silences the chill genres (legacy tick)
    expect(tick('lofi', MID * 1, { genreMode: 'uniform' })).toEqual({
      spec: { kind: 'impact', style: 'light' },
      beatIndex: 1,
    });
  });

  test('missing genre ⇒ the legacy uniform tick, byte-identical (existing behavior preserved)', () => {
    expect(tick(undefined, MID * 1)).toEqual({ spec: { kind: 'impact', style: 'light' }, beatIndex: 1 });
    expect(tick(null, MID * 2, { lastBeatIndex: 1 })).toEqual({ spec: { kind: 'impact', style: 'light' }, beatIndex: 2 });
  });

  test('the one-fire-per-beat law and the interval floor still hold under genre patterns', () => {
    // before the first beat: nothing
    expect(tick('edm', MID - 1)).toBeNull();
    // an already-fired beat index: nothing
    expect(tick('classical', MID * 3, { lastBeatIndex: 3 })).toBeNull();
  });
});

describe('WAVE B · B2 — the mode law', () => {
  test("'off' silences every beat tick, even for the most haptic genre", () => {
    expect(tick('edm', MID * 5, { lastBeatIndex: 1, genreMode: 'off' })).toBeNull();
    expect(tick('classical', MID * 1, { genreMode: 'off' })).toBeNull();
  });

  test("'uniform' forces the legacy tick EVEN for genre-carrying tracks (the EDM bar stays quiet)", () => {
    // uniform: an index-4 tick of an edm track is NOT the bar-1 heavy hit —
    // it is the legacy light mid-tempo tick on every beat
    expect(tick('edm', MID * 4, { lastBeatIndex: 1, genreMode: 'uniform' })).toEqual({
      spec: { kind: 'impact', style: 'light' },
      beatIndex: 4,
    });
  });

  test('undefined genreMode = auto (the default the persisted toggle boots to)', () => {
    expect(tick('edm', MID * 4, { lastBeatIndex: 1, genreMode: undefined })).toEqual({
      spec: { kind: 'impact', style: 'heavy' },
      beatIndex: 4,
    });
  });

  test('the hydration gate and the reduced switch remain the first laws', () => {
    resetHapticsHydrationForTests(); // un-hydrated: EVERY event nulls
    expect(tick('classical', MID * 1)).toBeNull();
    markHapticsHydrated();
    expect(tick('classical', MID * 1)).not.toBeNull();
    expect(tick('classical', MID * 1, { reduced: true })).toBeNull();
  });

  test('the persisted mode round-trips, and a corrupted value degrades to auto', async () => {
    await setHapticGenreMode('uniform');
    expect(await getHapticGenreModeSetting()).toBe('uniform');
    await setHapticGenreMode('off');
    expect(await getHapticGenreModeSetting()).toBe('off');
    await setHapticGenreMode('auto');
    expect(await getHapticGenreModeSetting()).toBe('auto');
    memStore.set('tsf.hapticGenreMode.v1', JSON.stringify('GARBAGE'));
    expect(await getHapticGenreModeSetting()).toBe('auto');
  });
});
