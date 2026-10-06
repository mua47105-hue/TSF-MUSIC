/**
 * THE TEN · WAVE 3 LOCKS — intelligence & social (F6/F7).
 *
 *   F6 Local Rewind — the 30-second rule boundary (29s out, 30s in),
 *      the honest stream floor (9 → null, 10 → cards), the midnight
 *      window (3:59 in, 4:00 out, TZ-safe), the closed-set aura
 *      quadrants with boundary + NaN behavior, deterministic rankings,
 *      the streak math, and the range window (31-day-old listens
 *      cannot leak into a 30-day rewind).
 *   F7 Taste DNA — encode→decode round-trips LOSSLESSLY (including
 *      Hindi artist names), the payload carries ONLY the closed key
 *      set (privacy: no raw events, no trackIds), corrupt/wrong-version
 *      codes decode to null (never a crash), buildTasteDna excludes
 *      __mood buckets and bounds the lists, and computeBlend is
 *      deterministic (same two DNAs ⇒ the same blend).
 *
 * Mutation targets (scripts/mutation_v42.sh W3-*): the midnight window,
 * the stream floor, the aura split, the base64url alphabet, the blend
 * intersection.
 */

import { describe, expect, test, mock } from 'bun:test';

// The facade locks import mindbeat — mock the RN shell FIRST (same
// pattern as feed_query_locks; sqlite throws → init degrades honestly).
mock.module('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: 'active' },
  Platform: { OS: 'android', select: (o: any) => o.android },
  NativeModules: {},
}));
mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
    multiRemove: async () => undefined,
  },
}));
mock.module('expo-sqlite', () => ({
  openDatabaseAsync: async () => {
    throw new Error('bun lab: no sqlite');
  },
  openDatabaseSync: () => {
    throw new Error('bun lab: no sqlite');
  },
}));

const { buildWrapped, auraFor } = await import('../../src/ai/wrapped');
const {
  buildTasteDna,
  encodeTasteDna,
  decodeTasteDna,
  computeBlend,
} = await import('../../src/ai/tasteDna');
import type { ListenRecord } from '../../src/ai/core/types';
import type { TasteProfile } from '../../src/ai/core/types';

const NOW = new Date();
NOW.setHours(12, 0, 0, 0); // local noon — stable against TZ shifts
const NOW_TS = NOW.getTime();
const DAY = 86_400_000;

function listen(opts: {
  trackId: string;
  title: string;
  artist: string;
  startedTs: number;
  listenedMs: number;
  energy?: number;
  valence?: number;
}): ListenRecord {
  return {
    trackId: opts.trackId,
    artist: opts.artist,
    title: opts.title,
    energy: opts.energy ?? 0.5,
    valence: opts.valence ?? 0.5,
    sessionId: 's1',
    surface: 'user_queue',
    startedTs: opts.startedTs,
    listenedMs: opts.listenedMs,
    durationMs: 210000,
    completionRatio: 0.9,
    grade: 'COMPLETED',
    wasRecommended: false,
    explorationSlot: false,
  };
}

/** A listen at local hour h TODAY (deterministic against the test TZ). */
function listenAtHour(h: number, trackId: string, title: string, artist: string, daysAgo = 0): ListenRecord {
  const d = new Date(NOW_TS - daysAgo * DAY);
  d.setHours(h, 0, 0, 0);
  return listen({ trackId, title, artist, startedTs: d.getTime(), listenedMs: 60_000 });
}

// ── F6 · the Local Rewind ───────────────────────────────────────────────

describe('wave3 · F6 the 30-second rule (literal boundary)', () => {
  test('a 29-second listen is NOT a stream; 30s IS', () => {
    const short = listen({ trackId: 'a', title: 'A', artist: 'X', startedTs: NOW_TS - DAY, listenedMs: 29_000 });
    const exact = listen({ trackId: 'b', title: 'B', artist: 'X', startedTs: NOW_TS - DAY, listenedMs: 30_000 });
    expect(buildWrapped([short], 30, NOW_TS)).toBe(null); // 0 streams < floor
    // nine more qualifying listens clear the honest floor; the 29s one
    // must STILL not count (streams = exactly 10, one track short)
    const filler: ListenRecord[] = [];
    for (let i = 0; i < 9; i++) filler.push(listen({ trackId: `f${i}`, title: `F${i}`, artist: 'Y', startedTs: NOW_TS - DAY, listenedMs: 60_000 }));
    const w = buildWrapped([short, exact, ...filler], 30, NOW_TS);
    expect(w!.streams).toBe(10); // the 29s listen did not count
    expect(w!.topTrack!.title).not.toBe('A'); // and it is not in the rankings
  });

  test('the honest floor: 9 streams ⇒ NULL, 10 streams ⇒ cards', () => {
    const listens: ListenRecord[] = [];
    for (let i = 0; i < 9; i++) listens.push(listen({ trackId: `t${i}`, title: `T${i}`, artist: 'X', startedTs: NOW_TS - DAY, listenedMs: 60_000 }));
    expect(buildWrapped(listens, 30, NOW_TS)).toBe(null);
    listens.push(listen({ trackId: 't9', title: 'T9', artist: 'X', startedTs: NOW_TS - DAY, listenedMs: 60_000 }));
    const w = buildWrapped(listens, 30, NOW_TS);
    expect(w!.streams).toBe(10);
  });

  test('the range window: 31-day-old listens cannot leak into a 30-day rewind', () => {
    const old = listen({ trackId: 'old', title: 'Old', artist: 'X', startedTs: NOW_TS - 31 * DAY, listenedMs: 60_000 });
    const listens = [old];
    for (let i = 0; i < 10; i++) listens.push(listen({ trackId: `t${i}`, title: `T${i}`, artist: 'Y', startedTs: NOW_TS - DAY, listenedMs: 60_000 }));
    const w = buildWrapped(listens, 30, NOW_TS);
    expect(w!.topArtist!.artist).toBe('Y');
    expect(JSON.stringify(w!.topTracks)).not.toContain('Old');
  });
});

describe('wave3 · F6 rankings + midnight + streak', () => {
  test('top artist/track rank by plays desc, ties by name asc (deterministic)', () => {
    const listens: ListenRecord[] = [];
    for (let i = 0; i < 6; i++) listens.push(listen({ trackId: 'z', title: 'Zed', artist: 'Beta', startedTs: NOW_TS - DAY, listenedMs: 60_000 }));
    for (let i = 0; i < 6; i++) listens.push(listen({ trackId: 'y', title: 'Yak', artist: 'Alpha', startedTs: NOW_TS - DAY, listenedMs: 60_000 }));
    const w = buildWrapped(listens, 30, NOW_TS)!;
    expect(w.topArtist!.artist).toBe('Alpha'); // tie 6-6 → name asc
    expect(w.topTrack!.title).toBe('Yak');
  });

  test('MIDNIGHT OBSESSION: 00:00–03:59 count, 04:00 does not (BOTH edges pinned)', () => {
    const listens: ListenRecord[] = [];
    for (let i = 0; i < 11; i++) listens.push(listenAtHour(12, `t${i}`, `Day${i}`, 'Day Artist', 0));
    listens.push(listenAtHour(0, 'm0', 'Midnight Zero', 'Night Artist'));
    listens.push(listenAtHour(2, 'm2', 'Night Two', 'Night Artist'));
    listens.push(listenAtHour(3, 'm3', 'Night Three', 'Night Artist'));
    listens.push(listenAtHour(4, 'm4', 'Four AM', 'Night Artist'));
    const w = buildWrapped(listens, 30, NOW_TS)!;
    // 00:xx and 03:xx both count (1 each) → the tie-break names the
    // window's start explicitly; the 04:00 listen is excluded. A shifted
    // window start (midnightFromHour 0→2) makes 'Midnight Zero' vanish
    // and this exact expectation goes red.
    expect(w.midnight!.title).toBe('Midnight Zero');
  });

  test('no midnight listening ⇒ the card honestly reports it (not fake zeros)', () => {
    const listens: ListenRecord[] = [];
    for (let i = 0; i < 10; i++) listens.push(listenAtHour(12, `t${i}`, `Day${i}`, 'Day Artist', 0));
    const w = buildWrapped(listens, 30, NOW_TS)!;
    expect(w.midnight).toBe(null);
  });

  test('NaN feature rows never steer the aura (no fake GOLDEN_HOUR from garbage)', () => {
    const listens: ListenRecord[] = [];
    for (let i = 0; i < 10; i++) {
      listens.push(listen({ trackId: `t${i}`, title: `T${i}`, artist: 'X', startedTs: NOW_TS - DAY, listenedMs: 60_000, energy: Number.NaN, valence: 0.1 }));
    }
    const w = buildWrapped(listens, 30, NOW_TS)!;
    // all-energy-NaN ⇒ sums stay 0 → the mean falls to 0 → DEEP_FOG (the
    // honest low quadrant), never the NaN-clamped brightest quadrant
    expect(w.aura!.label).toBe('DEEP_FOG');
  });

  test('streak copy: the summary carries the streak END (honest thru-date)', () => {
    const listens: ListenRecord[] = [];
    for (const daysAgo of [0, 1, 2]) {
      listens.push(listen({ trackId: `t${daysAgo}`, title: 'T', artist: 'X', startedTs: NOW_TS - daysAgo * DAY, listenedMs: 60_000 }));
    }
    for (let k = 0; k < 7; k++) {
      listens.push(listen({ trackId: `f${k}`, title: `F${k}`, artist: 'Y', startedTs: NOW_TS - DAY, listenedMs: 60_000 }));
    }
    const w = buildWrapped(listens, 30, NOW_TS)!;
    expect(w.streakDays).toBe(3);
    // the streak ends TODAY (NOW is local noon): end = today's midnight-ish ts
    expect(w.streakEndTs).not.toBe(null);
    expect(new Date(w.streakEndTs!).toDateString()).toBe(new Date(NOW_TS).toDateString());
    // an old streak reports its OWN end, never today's
    const oldListens = listens.filter((l) => l.startedTs < NOW_TS - 5 * DAY).concat(
      listen({ trackId: 'x1', title: 'X', artist: 'Z', startedTs: NOW_TS - 6 * DAY, listenedMs: 60_000 }),
    );
    for (let k = 0; k < 10; k++) {
      oldListens.push(listen({ trackId: `o${k}`, title: `O${k}`, artist: 'Z', startedTs: NOW_TS - 6 * DAY, listenedMs: 60_000 }));
    }
    const w2 = buildWrapped(oldListens, 30, NOW_TS)!;
    expect(w2.streakEndTs!).toBeLessThan(NOW_TS - 5 * DAY); // ended days ago — honest
  });

  test('streak counts consecutive days ending at the last active day', () => {
    const listens: ListenRecord[] = [];
    for (const daysAgo of [0, 1, 2, 4, 5]) {
      for (let k = 0; k < 2; k++) {
        listens.push(listen({ trackId: `t${daysAgo}-${k}`, title: `T${daysAgo}`, artist: 'X', startedTs: NOW_TS - daysAgo * DAY, listenedMs: 60_000 }));
      }
    }
    const w = buildWrapped(listens, 30, NOW_TS)!;
    expect(w.streakDays).toBe(3); // today, yesterday, 2 days ago — the gap ends it
  });
});

describe('wave3 · F6 the aura (closed set, truth-conditioned)', () => {
  test('the four quadrants are literal', () => {
    expect(auraFor(0.9, 0.9)).toBe('GOLDEN_HOUR');
    expect(auraFor(0.9, 0.2)).toBe('RED_LINE');
    expect(auraFor(0.2, 0.9)).toBe('SOFT_LANDING');
    expect(auraFor(0.2, 0.2)).toBe('DEEP_FOG');
  });

  test('boundaries: exactly at the split counts as the high side', () => {
    expect(auraFor(0.5, 0.5)).toBe('GOLDEN_HOUR');
    expect(auraFor(0.5, 0.49)).toBe('RED_LINE');
    expect(auraFor(0.49, 0.5)).toBe('SOFT_LANDING');
  });

  test('garbage energy/valence fall back to the split (never NaN labels)', () => {
    expect(auraFor(Number.NaN, 0.9)).toBe('GOLDEN_HOUR');
    expect(auraFor(0.2, Number.NaN)).toBe('SOFT_LANDING');
  });
});

// ── F7 · Taste DNA ──────────────────────────────────────────────────────

function mockProfile(): TasteProfile {
  return {
    builtAt: 1,
    sessionCount: 3,
    artists: {
      'arijit singh': { w: 4.2, lastEventTs: NOW_TS, evidenceCount: 9, source: 'listen' },
      'pritam': { w: 2.0, lastEventTs: NOW_TS, evidenceCount: 4, source: 'listen' },
      'dua lipa': { w: 1.1, lastEventTs: NOW_TS, evidenceCount: 2, source: 'listen' },
      'श्रेया घोषाल': { w: 0.7, lastEventTs: NOW_TS, evidenceCount: 1, source: 'listen' },
    },
    genres: {
      bollywood: { w: 3.0, lastEventTs: NOW_TS, evidenceCount: 8, source: 'listen' },
      '__mood_calm': { w: 9.9, lastEventTs: NOW_TS, evidenceCount: 99, source: 'listen' }, // internal — must be excluded
      pop: { w: 1.4, lastEventTs: NOW_TS, evidenceCount: 3, source: 'listen' },
    },
    languages: {},
    eras: {},
    proxy: {
      energyPref: { mean: 0.62, std: 0.2 },
      valencePref: { mean: 0.48, std: 0.2 },
      tempoDist: { slow: 0.3, mid: 0.5, fast: 0.2 },
    },
    daypart: {},
    activities: {},
    skipProfiles: {},
    coplayTracks: {},
    coplayArtists: {},
    flowTracks: {},
    clusters: { artistClusters: [], moodCells: [] },
    exploration: {} as TasteProfile['exploration'],
    corrections: { mutedArtists: [], mutedTracks: [], boosts: {}, wrongLabels: [] },
  } as unknown as TasteProfile;
}

describe('wave3 · F7 buildTasteDna (bounds + privacy of the payload)', () => {
  test('excludes __mood buckets, sorts by weight, rounds the center', () => {
    const dna = buildTasteDna(mockProfile());
    expect(dna.genres.map((g) => g.n)).toEqual(['bollywood', 'pop']); // __mood_calm GONE
    expect(dna.artists[0]!.n).toBe('arijit singh');
    expect(dna.energy).toBe(0.62);
    expect(dna.valence).toBe(0.48);
  });

  test('the payload carries ONLY the closed key set — no raw events, no trackIds', () => {
    const dna = buildTasteDna(mockProfile());
    const raw = JSON.stringify(dna);
    const keys = Object.keys(JSON.parse(raw)).sort();
    expect(keys).toEqual(['artists', 'at', 'energy', 'genres', 'v', 'valence']); // closed set
    expect(raw).not.toContain('trackId');
    expect(raw).not.toContain('listenedMs');
    expect(raw).not.toContain('sessionCount');
  });

  test('lists are bounded (artistCount / genreCount)', () => {
    const p = mockProfile();
    for (let i = 0; i < 30; i++) {
      (p.artists as Record<string, { w: number; lastEventTs: number; evidenceCount: number; source: string }>)[`artist ${i}`] = {
        w: 5 - i * 0.1,
        lastEventTs: NOW_TS,
        evidenceCount: 1,
        source: 'listen',
      };
    }
    const dna = buildTasteDna(p);
    expect(dna.artists.length).toBeLessThanOrEqual(20);
  });
});

describe('wave3 · F7 encode/decode (round-trip + honest failures)', () => {
  test('round-trips LOSSLESSLY — including Hindi (Devanagari) artist names', () => {
    const dna = buildTasteDna(mockProfile()); // carries 'श्रेया घोषाल'
    const code = encodeTasteDna(dna);
    expect(code).not.toContain('='); // base64URL, padding-free (clipboard-safe)
    expect(code).toMatch(/^[A-Za-z0-9\-_]+$/);
    const back = decodeTasteDna(code);
    expect(back).toEqual(dna); // lossless
  });

  test('a DNA younger than the share floor is REFUSED (no one-sided blends)', async () => {
    const { mindbeat } = await import('../../src/ai/mindbeat');
    // bun lab: the facade runs against the degraded store (ledger null),
    // so a young profile is the honest path — the floor must fire
    const code = await mindbeat.tasteDnaCode();
    expect(code).toBe(null); // emptyProfile has 0 artists < minArtistsForShare
  });

  test('buildBlendPlaylist discriminates bad_code from nothing_resolved', async () => {
    const { mindbeat } = await import('../../src/ai/mindbeat');
    const bad = await mindbeat.buildBlendPlaylist('garbage!!!');
    expect(bad).toEqual({ status: 'bad_code' }); // an honest distinct status
  });

  test('INTEROP: the encoder emits the STANDARD base64url table (critic R2 pin)', () => {
    // A reference vector produced by the standard base64url encoder — a
    // self-invented alphabet would round-trip against itself and still
    // be unreadable by every other tool, so the table is pinned to the
    // standard, literally.
    const dna = { v: 1, artists: [], genres: [], energy: 0.5, valence: 0.5, at: 0 };
    expect(encodeTasteDna(dna as never)).toBe(
      'eyJ2IjoxLCJhcnRpc3RzIjpbXSwiZ2VucmVzIjpbXSwiZW5lcmd5IjowLjUsInZhbGVuY2UiOjAuNSwiYXQiOjB9',
    );
    // the '~' payload forces the 62/63 digits ('-' and '_') — the exact
    // table positions an invented alphabet gets wrong:
    const tilde = { v: 1, artists: [{ n: '~~~', w: 1 }], genres: [], energy: 0.5, valence: 0.5, at: 0 };
    expect(encodeTasteDna(tilde as never)).toBe(
      'eyJ2IjoxLCJhcnRpc3RzIjpbeyJuIjoifn5-IiwidyI6MX1dLCJnZW5yZXMiOltdLCJlbmVyZ3kiOjAuNSwidmFsZW5jZSI6MC41LCJhdCI6MH0',
    );
  });

  test('corrupt / empty / wrong-version codes ⇒ null (never a crash)', () => {
    expect(decodeTasteDna('')).toBe(null);
    expect(decodeTasteDna('   ')).toBe(null);
    expect(decodeTasteDna('not a code at all!!!')).toBe(null);
    expect(decodeTasteDna('aGVsbG8gd29ybGQ=')).toBe(null); // valid b64, not our JSON
    // a DNA stamped with a FUTURE version is refused (honest incompatibility)
    const dna = buildTasteDna(mockProfile());
    const rogue = encodeTasteDna({ ...dna, v: 99 });
    expect(decodeTasteDna(rogue)).toBe(null);
  });

  test('copy/paste noise (newlines + spaces) is tolerated', () => {
    const dna = buildTasteDna(mockProfile());
    const code = encodeTasteDna(dna);
    const wrapped = code.match(/.{1,12}/g)!.join('\n');
    expect(decodeTasteDna(wrapped)).toEqual(dna);
  });

  test('malformed entries inside a payload are dropped, not trusted', () => {
    const dna = buildTasteDna(mockProfile());
    const rogue = {
      ...dna,
      artists: [{ n: 'ok', w: 1 }, { n: '', w: 1 }, { n: 'bad weight', w: 'high' }, { n: 'x'.repeat(200), w: 1 }],
      genres: [{ n: '__smuggled', w: 9 }],
    } as unknown as ReturnType<typeof buildTasteDna>;
    const back = decodeTasteDna(encodeTasteDna(rogue));
    expect(back!.artists.map((a) => a.n)).toEqual(['ok']);
    expect(back!.genres).toEqual([]); // internal buckets never cross the wire
  });
});

describe('wave3 · F7 computeBlend (deterministic + truth-conditioned)', () => {
  const a = buildTasteDna(mockProfile());
  const b = buildTasteDna({
    ...mockProfile(),
    artists: {
      'arijit singh': { w: 2.2, lastEventTs: NOW_TS, evidenceCount: 5, source: 'listen' },
      'the weeknd': { w: 3.0, lastEventTs: NOW_TS, evidenceCount: 6, source: 'listen' },
      'dua lipa': { w: 1.0, lastEventTs: NOW_TS, evidenceCount: 2, source: 'listen' },
    },
    genres: { pop: { w: 2.0, lastEventTs: NOW_TS, evidenceCount: 4, source: 'listen' } },
  } as unknown as TasteProfile);

  test('same two DNAs ⇒ the SAME blend (pure determinism)', () => {
    expect(computeBlend(a, b)).toEqual(computeBlend(a, b));
    expect(computeBlend(a, b)).toEqual(computeBlend(structuredClone(a), structuredClone(b)));
  });

  test('shared = the intersection (case-insensitive); bridge = one-sided artists only', () => {
    const blend = computeBlend(a, b);
    expect(blend.shared.map((s) => s.n).sort()).toEqual(['arijit singh', 'dua lipa']);
    const bridgeNames = blend.bridge.map((x) => x.n);
    expect(bridgeNames).toContain('pritam'); // mine only
    expect(bridgeNames).toContain('the weeknd'); // theirs only
    expect(bridgeNames).not.toContain('arijit singh'); // shared artists are never bridge
    expect(blend.bridge.every((x) => x.from === 'mine' || x.from === 'theirs')).toBe(true);
  });

  test('the blend center is the mean of the two preference centers', () => {
    const blend = computeBlend(a, b);
    expect(blend.energy).toBeCloseTo((a.energy + b.energy) / 2, 10);
    expect(blend.valence).toBeCloseTo((a.valence + b.valence) / 2, 10);
  });

  // ── v4.3.1 (auditor BAR 3): determinism is pinned against ORDER and
  // against TIES — calling computeBlend twice proves nothing (a
  // Math.random() comparator survived the old lock because stable inputs
  // + stable iteration usually reproduce). These fixtures attack both.

  test('KEY-ORDER invariance: shuffling the DNA arrays cannot move the blend', () => {
    const mine = {
      v: 1,
      artists: [
        { n: 'arijit singh', w: 5 },
        { n: 'shubh', w: 3 },
        { n: 'billie eilish', w: 2 },
      ],
      genres: [
        { n: 'bollywood', w: 4 },
        { n: 'pop', w: 1 },
      ],
      energy: 0.4,
      valence: 0.6,
      at: NOW_TS,
    };
    const theirs = {
      v: 1,
      artists: [
        { n: 'billie eilish', w: 4 },
        { n: 'arctic monkeys', w: 2 },
      ],
      genres: [{ n: 'pop', w: 2 }],
      energy: 0.5,
      valence: 0.5,
      at: NOW_TS,
    };
    const shuffledMine = { ...mine, artists: [...mine.artists].reverse(), genres: [...mine.genres].reverse() };
    const shuffledTheirs = { ...theirs, artists: [...theirs.artists].reverse(), genres: [...theirs.genres].reverse() };
    const expected = computeBlend(mine, theirs);
    // the EXACT same output — shared and bridge arrays, same order, same
    // ties broken the same way — regardless of the input key order
    expect(computeBlend(shuffledMine, theirs)).toEqual(expected);
    expect(computeBlend(mine, shuffledTheirs)).toEqual(expected);
    expect(computeBlend(shuffledMine, shuffledTheirs)).toEqual(expected);
  });

  test('TIED weights: alphabetical tie-break strictly enforced + 40-run stability (a Math.random comparator cannot survive)', () => {
    const tie = (names: string[], w: number) => ({
      v: 1,
      artists: names.map((n) => ({ n, w })),
      genres: [] as Array<{ n: string; w: number }>,
      energy: 0.5,
      valence: 0.5,
      at: NOW_TS,
    });
    const mine = tie(['zed one', 'alpha two', 'mike three'], 5);
    const theirs = tie(['zed one', 'alpha two', 'mike three'], 5);
    const first = computeBlend(mine, theirs);
    // every weight ties ⇒ ONLY the name break sorts: a < m < z
    expect(first.shared.map((s) => s.n)).toEqual(['alpha two', 'mike three', 'zed one']);
    // 40 runs must be byte-identical — under an injected Math.random
    // comparator, 3 tied elements land in one of 6 orders per run, so a
    // 40-run all-equal match happens with probability ≈ 6^-39: never.
    for (let i = 0; i < 40; i++) expect(computeBlend(mine, theirs)).toEqual(first);
  });

  test('BRIDGE ties: equal weights interleave alphabetically, and a cross-side tie gives MINE the first seat (fairness pin)', () => {
    const mine = {
      v: 1,
      artists: [
        { n: 'aaa solo', w: 5 },
        { n: 'tie band', w: 5 },
      ],
      genres: [],
      energy: 0.5,
      valence: 0.5,
      at: NOW_TS,
    };
    const theirs = {
      v: 1,
      artists: [
        { n: 'zzz solo', w: 5 },
        { n: 'tie band', w: 5 },
      ],
      genres: [],
      energy: 0.5,
      valence: 0.5,
      at: NOW_TS,
    };
    const blend = computeBlend(mine, theirs);
    // shared: both sides know 'tie band' (meaned 5)
    expect(blend.shared.map((s) => s.n)).toEqual(['tie band']);
    // bridge: 'aaa solo' (mine) and 'zzz solo' (theirs) tie at 5 ⇒ name asc
    // puts aaa first; the from-tiebreak is never even needed here — pin it
    expect(blend.bridge.map((b) => `${b.n}:${b.from}`)).toEqual(['aaa solo:mine', 'zzz solo:theirs']);
  });
});

// ── source locks (the wiring exists) ────────────────────────────────────

describe('wave3 · source locks', () => {
  test('StatsScreen renders the rewind cards', async () => {
    const src = await Bun.file(new URL('../../src/screens/StatsScreen.tsx', import.meta.url)).text();
    expect(src).toContain('RewindCards');
    expect(src).toContain('RewindEmpty');
  });

  test('the rewind shares through the existing pipeline with a text fallback', async () => {
    const src = await Bun.file(new URL('../../src/share/share.ts', import.meta.url)).text();
    expect(src).toContain('shareWrappedNow');
  });

  test('TasteScreen carries the Blend import/export UI', async () => {
    const src = await Bun.file(new URL('../../src/screens/TasteScreen.tsx', import.meta.url)).text();
    expect(src).toContain('tasteDnaCode');
    expect(src).toContain('buildBlendPlaylist');
  });

  test('the blend resolver is hygiene-gated — BEHAVIORALLY (auditor BAR 1)', async () => {
    // v4.3.1: the old lock grepped mindbeat.ts for the string
    // `filterClean(reconcileRecordings(rows))`, which appears at MULTIPLE
    // call sites — deleting the BLEND's own gate kept the suite green.
    // The replacement drives the real facade and asserts the explicit and
    // profane fixture rows never land in the saved playlist:
    // see tests/ai/hygiene_behavioral_locks.test.ts.
    const src = await Bun.file(new URL('../../tests/ai/hygiene_behavioral_locks.test.ts', import.meta.url)).text();
    expect(src).toContain('buildBlendPlaylist');
  });
});
