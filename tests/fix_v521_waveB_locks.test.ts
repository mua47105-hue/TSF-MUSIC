/**
 * WAVE B LOCKS — v5.2.1 FIX-B1 … FIX-B8 (lock-the-survivors).
 *
 * The forensic audit ran 16 adversarial mutations against v5.2.0; 8
 * SURVIVED the full suite. Each survivor is a House Law that existed in
 * code but not in tests. This file is the teeth:
 *
 *  B1 · AppState single-owner gate (Law 3): the pure dual-owner law
 *      (trackOwnership.ts) simulated against BOTH owners — exactly one
 *      ledger write per transition in either app state; source laws pin
 *      both call sites (PlayerProvider + service).
 *  B2 · sanitizeArtistImage host law (Law 9): valid artist URL passes,
 *      placeholder falls, EVIL HOST falls, 150x150 upgrades.
 *  B3 · SEATBELT final-paint guard (Law 13): a late zero can't unsee
 *      early rows; a real late result still replaces; the wiring is a
 *      source law on SearchScreen.
 *  B4 · track-row testID (Law 12): bun-level presence lock. HONEST
 *      DEVIATION, stated: bun has no RN renderer and the repo's
 *      webmock-parity law forbids dragging PlayerProvider+sqlite+expo
 *      mocks into a render just to read one attribute (that is the
 *      v5.2.0 mock-leak class). The lock asserts the literal JSX
 *      attribute on the Pressable a Maestro flow taps; the BEHAVIORAL
 *      side stays with the E2E lab, which does render it.
 *  B5 · cross-source recording reconciliation (Law 6): the S2 merged
 *      pool runs reconcileRecordings — the same recording under two
 *      provider ids dedupes; the primary-path wiring is a source law.
 *  B6 · kill-switch gates: mindbeat.disabled=true ⇒ EVERY intelligence
 *      surface returns its honest empty shape and none throw.
 *  B7 · YouTube disabled-source error:true (Law 7): the disabled path
 *      keeps the transport-failure contract.
 *  B8 · mixed wall+video verdict is NEUTRAL: the kill-switch streak is
 *      KEPT (no noteYtSuccess reset on a verdict that observed a wall),
 *      with a positive control proving the honest video-only verdict
 *      still resets.
 *
 * Mutations proven RED (worklog V5.2.1-WAVE-B): M-B1-1/2, M-B2-1/2,
 * M-B3-1/2, M-B4-1/2, M-B5-1/2, M-B6-1/2, M-B7-1/2, M-B8-1/2 — every one
 * restored byte-exact, `git status --porcelain` free of mutation residue.
 */

import { describe, expect, test, beforeEach, afterAll, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rnMockSurface } from './helpers/rnMockSurface';

mock.module('react-native', () => rnMockSurface());
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

const { providerOwnsTransition, serviceOwnsTransition } = await import('../src/player/trackOwnership');
const { sanitizeArtistImage } = await import('../src/api/artists');
const { seatbeltPaint } = await import('../src/search/seatbelt');
const { verifySet, mergePools } = await import('../src/search/verify');
const { mindbeat } = await import('../src/ai/mindbeat');
const {
  setYtFetch,
  ytSearchMusicMore,
  ytResolveStream,
  ytAvailable,
  noteYtFailure,
  resetYtKillSwitch,
  clearYtCaches,
} = await import('../src/api/youtube');

const ROOT = join(import.meta.dir, '..', 'src');
const readSrc = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

const track = (id: string, title: string, artist: string, extra: Record<string, unknown> = {}) =>
  ({ id, title, artist, artwork: '', duration: 200, source: 'saavn', previewOnly: false, ...extra } as any);

// ── B1 — the single-owner law ──────────────────────────────────────────
describe('FIX-B1 — exactly one ledger owner per transition', () => {
  test('background transition: provider declines, service owns — one write', () => {
    const ledger: string[] = [];
    const provider = () => {
      if (providerOwnsTransition('background', 't1', '')) ledger.push('provider');
    };
    const service = () => {
      if (serviceOwnsTransition('background')) ledger.push('service');
    };
    provider();
    service();
    expect(ledger).toEqual(['service']);
  });

  test('foreground transition: provider owns, service declines — one write', () => {
    const ledger: string[] = [];
    const provider = () => {
      if (providerOwnsTransition('active', 't2', 't1')) ledger.push('provider');
    };
    const service = () => {
      if (serviceOwnsTransition('active')) ledger.push('service');
    };
    provider();
    service();
    expect(ledger).toEqual(['provider']);
  });

  test('no id / unchanged id: nobody writes (no phantom instrumentation)', () => {
    expect(providerOwnsTransition('active', undefined, '')).toBeFalse();
    expect(providerOwnsTransition('active', 't1', 't1')).toBeFalse();
  });

  test('source law: BOTH call sites pin the ownership contract', () => {
    const provider = readSrc('player', 'PlayerProvider.tsx');
    expect(provider).toContain('providerOwnsTransition(AppState.currentState');
    const service = readSrc('player', 'service.ts');
    const gateAt = service.indexOf("if (AppState.currentState !== 'active')");
    const startedAt = service.indexOf('mindbeat.trackStarted(t,');
    expect(gateAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(startedAt); // the service gate sits BEFORE its own instrumentation
  });
});

// ── B2 — the artist image host law ─────────────────────────────────────
describe('FIX-B2 — sanitizeArtistImage is host-lawful', () => {
  test('valid artist URL passes and upgrades to 500', () => {
    expect(
      sanitizeArtistImage('https://c.saavncdn.com/artists/Arijit_Singh_004_20241118063717_150x150.jpg'),
    ).toBe('https://c.saavncdn.com/artists/Arijit_Singh_004_20241118063717_500x500.jpg');
  });
  test('the evil host falls (the M2b survivor case)', () => {
    expect(sanitizeArtistImage('https://evil.com/artists/x.jpg')).toBe('');
  });
  test('placeholder + share-image fall', () => {
    expect(sanitizeArtistImage('https://c.saavncdn.com/artists/artist-default.jpg')).toBe('');
    expect(sanitizeArtistImage('https://c.saavncdn.com/artists/share-image.jpg')).toBe('');
  });
  test('plain http falls; non-artists paths fall', () => {
    expect(sanitizeArtistImage('http://c.saavncdn.com/artists/x.jpg')).toBe('');
    expect(sanitizeArtistImage('https://c.saavncdn.com/501x501/x_150x150.jpg')).toBe('');
    expect(sanitizeArtistImage(undefined)).toBe('');
  });
});

// ── B3 — the SEATBELT final-paint law ──────────────────────────────────
describe('FIX-B3 — the late paint never regresses below the early paint', () => {
  test('early rows exist + late paint is zero ⇒ the early rows persist', () => {
    const early = [track('a', 'A', 'x'), track('b', 'B', 'y')];
    expect(seatbeltPaint([], early)).toEqual(early);
  });
  test('a real late result still replaces (stale rows must not zombie)', () => {
    const early = [track('a', 'A', 'x')];
    const late = [track('c', 'C', 'z')];
    expect(seatbeltPaint(late, early)).toEqual(late);
  });
  test('both empty ⇒ empty (honest zero stays zero)', () => {
    expect(seatbeltPaint([], [])).toEqual([]);
  });
  test('source law: SearchScreen wires the pure law into the final paint', () => {
    const src = readSrc('screens', 'SearchScreen.tsx');
    expect(src).toContain('seatbeltPaint(finalTracks, prev)');
  });
});

// ── B4 — the track-row testID ──────────────────────────────────────────
describe('FIX-B4 — the row the E2E taps keeps its testID', () => {
  test('source law: TrackRow exposes testID="track-row" on its Pressable', () => {
    const src = readSrc('components', 'TrackRow.tsx');
    expect(src).toContain('testID="track-row"');
  });
});

// ── B5 — the cross-source recording reconciliation ─────────────────────
describe('FIX-B5 — the S2 merged pool obeys the recording law', () => {
  test('the same recording under two provider ids dedupes in verifySet', () => {
    const plan = { normalized: 'tum hi ho', kind: 'track', titleTokens: ['tum', 'hi', 'ho'] } as any;
    const out = verifySet(plan, [
      { pool: 'saavn', tracks: [track('saavn-1', 'Tum Hi Ho', 'Arijit Singh')] },
      { pool: 'youtube', tracks: [track('yt-abc', 'Tum Hi Ho', 'Arijit Singh')] },
    ]);
    expect(out.rows.length).toBe(1);
    expect(out.clusters).toBe(1);
  });

  test('genuinely different recordings survive the merge', () => {
    const plan = { normalized: 'mix', kind: 'track', titleTokens: ['mix'] } as any;
    const out = verifySet(plan, [
      { pool: 'saavn', tracks: [track('s1', 'Tum Hi Ho', 'Arijit Singh')] },
      { pool: 'youtube', tracks: [track('y1', 'Labon Ko', 'KK')] },
    ]);
    expect(out.rows.length).toBe(2);
  });

  test('mergePools alone still shows the raw duplicate (the law lives in verifySet)', () => {
    const merged = mergePools([
      { pool: 'saavn', tracks: [track('saavn-1', 'Tum Hi Ho', 'Arijit Singh')] },
      { pool: 'youtube', tracks: [track('yt-abc', 'Tum Hi Ho', 'Arijit Singh')] },
    ]);
    expect(merged.length).toBe(2); // id-dedup cannot see the recording twin
  });

  test('source law: verifySet reconciles + the primary search path obeys the same law', () => {
    const v = readSrc('search', 'verify.ts');
    expect(v).toContain('reconcileRecordings([...organicRows, ...rescuedRows])'); // rescue-aware: the organic twin can never be evicted
    const saavn = readSrc('api', 'saavn.ts');
    expect(saavn).toContain('return dedupeRecordings(');
    expect(saavn).toContain('reconcileRecordings(keyPass)');
  });
});

// ── B6 — the kill switch silences every surface ────────────────────────
describe('FIX-B6 — intelligenceDisabled ⇒ every surface degrades honestly', () => {
  test('all 15 kill-switch surfaces return empty/null without throwing', async () => {
    await mindbeat.init().catch(() => undefined);
    mindbeat.disabled = true; // the kill switch (private field, runtime-set — the godmode pattern)

    // THE AUDITED 15 — exactly the surfaces whose source carries a
    // `this.disabled` gate. (smartFolders/thisDayLastYear/radarAxes
    // degrade through the cold-ledger path; wrapped() deliberately
    // THROWS on a cold ledger — "unavailable" ≠ "not enough data" is its
    // documented honesty contract, and its data is the user's own
    // history, not intelligence output.)
    const anyTrack = track('seed', 'Seed', 'Artist');
    const surfaces: Array<[string, () => Promise<unknown> | unknown]> = [
      ['radio', () => mindbeat.radio(anyTrack, 12)],
      ['shuffleRecs', () => mindbeat.shuffleRecs([anyTrack], null)],
      ['surprisePick', () => mindbeat.surprisePick([])],
      ['vibeShift', () => mindbeat.vibeShift(null, new Set())],
      ['focusPicks', () => mindbeat.focusPicks(null)],
      ['moodJourney', () => mindbeat.moodJourney({ energy: 0.4 } as any, { energy: 0.8 } as any, 4)],
      ['resumeSession', () => mindbeat.resumeSession('sess-1')],
      ['decadeRadio', () => mindbeat.decadeRadio(1990, 10)],
      ['feedSongQueries', () => mindbeat.feedSongQueries()],
      ['soundAlike', () => mindbeat.soundAlike(anyTrack, 8)],
      ['searchVibeContext', () => mindbeat.searchVibeContext()],
      ['dailyMixes', () => mindbeat.dailyMixes()],
      ['weeklyCrate', () => mindbeat.weeklyCrate()],
      ['nowSound', () => mindbeat.nowSound()],
      ['onTheRise', () => mindbeat.onTheRise()],
    ];

    for (const [name, call] of surfaces) {
      const value = await call(); // a throw here IS the RED
      const empty =
        value === null ||
        value === undefined ||
        (Array.isArray(value) && value.length === 0) ||
        (typeof value === 'string' && value === '') ||
        (typeof value === 'object' &&
          value !== null &&
          'tracks' in (value as Record<string, unknown>) &&
          Array.isArray((value as Record<string, unknown>).tracks) &&
          ((value as Record<string, unknown>).tracks as unknown[]).length === 0);
      expect(empty).toBeTrue(); // THE BAR: graceful empty, never data, never a throw
      expect(name.length).toBeGreaterThan(0); // every listed surface was actually exercised
    }
    expect(surfaces.length).toBe(15);
    mindbeat.disabled = false;
  });

  test('source law: EVERY audited surface body carries its own kill-switch gate', () => {
    // The old count law (≥15 this.disabled hits) could not catch ONE gate
    // removal — the file carries ~25 references (assignments, helpers,
    // write-gates). Per-method bodies are the honest teeth: removing the
    // gate from ANY audited surface is a RED, proven by M-B6-1/M-B6-2.
    const src = readSrc('ai', 'mindbeat.ts');
    const surfaces = [
      'radio', 'shuffleRecs', 'surprisePick', 'vibeShift', 'focusPicks',
      'moodJourney', 'resumeSession', 'decadeRadio', 'feedSongQueries',
      'soundAlike', 'searchVibeContext', 'dailyMixes', 'weeklyCrate',
      'nowSound', 'onTheRise',
    ];
    const starts = surfaces
      .map((n) => {
        const a1 = src.indexOf(`async ${n}(`);
        const a2 = src.indexOf(`${n}(`);
        return { name: n, at: a1 >= 0 ? a1 : a2 };
      })
      .sort((a, b) => a.at - b.at); // FILE order, not list order — bodies slice monotonically
    for (let i = 0; i < starts.length; i += 1) {
      expect(starts[i].at, `anchor for ${starts[i].name} not found`).toBeGreaterThan(-1);
      const from = starts[i].at;
      const to = i + 1 < starts.length ? starts[i + 1].at : src.length;
      const body = src.slice(from, to);
      expect(body.includes('this.disabled'), `surface ${starts[i].name} lost its kill-switch gate`).toBeTrue();
    }
  });
});

// ── B7 — the disabled-source error:true contract ───────────────────────
describe('FIX-B7 — a disabled YouTube reports error:true, not a lie', () => {
  beforeEach(() => {
    resetYtKillSwitch();
    clearYtCaches();
  });

  test('ytSearchMusicMore: disabled ⇒ { tracks: [], error: true } (the caller keeps its token)', async () => {
    noteYtFailure();
    noteYtFailure();
    noteYtFailure(); // 3 strikes → 1h soft-disable
    expect(ytAvailable()).toBeFalse();
    const out = await ytSearchMusicMore('CONTINUATION-TOKEN-1');
    expect(out.error).toBeTrue();
    expect(out.tracks).toEqual([]);
  });

  test('ytResolveStream: disabled ⇒ { ok: false, reason: "disabled" }', async () => {
    noteYtFailure();
    noteYtFailure();
    noteYtFailure();
    const out = await ytResolveStream('abc123');
    expect(out.ok).toBeFalse();
    expect(out.reason).toBe('disabled');
  });

  test('an available source does NOT carry the error flag (the flag stays honest)', async () => {
    setYtFetch(
      ((_url: string, init?: any) => {
        const cn = String(init?.headers?.['X-YouTube-Client-Name'] ?? '');
        if (cn === '67')
          return Promise.resolve(
            new Response(JSON.stringify({ playabilityStatus: { status: 'OK' }, streamingData: { adaptiveFormats: [] } }), { status: 200 }),
          );
        return Promise.resolve(
          new Response(JSON.stringify({ playabilityStatus: { status: 'UNPLAYABLE' } }), { status: 200 }),
        );
      }) as unknown as typeof fetch,
    );
    const out = await ytResolveStream('vid-1');
    expect(out.reason).not.toBe('disabled');
  });

  afterAll(() => setYtFetch(null));
});

// ── B8 — the mixed verdict is neutral ──────────────────────────────────
describe('FIX-B8 — a wall+video verdict keeps the kill-switch streak', () => {
  beforeEach(() => {
    resetYtKillSwitch();
    clearYtCaches();
  });
  afterAll(() => setYtFetch(null));

  test('mixed verdict → neutral: two strikes stay two, one more trips the switch', async () => {
    const mixed = ((_url: string, init?: any) => {
      const cn = String(init?.headers?.['X-YouTube-Client-Name'] ?? '');
      if (cn === '101')
        return Promise.resolve(new Response(JSON.stringify({ playabilityStatus: { status: 'LOGIN_REQUIRED' } }), { status: 200 })); // WALL
      return Promise.resolve(new Response(JSON.stringify({ playabilityStatus: { status: 'UNPLAYABLE' } }), { status: 200 })); // video verdict
    }) as unknown as typeof fetch;
    setYtFetch(mixed);

    resetYtKillSwitch();
    noteYtFailure();
    noteYtFailure(); // streak = 2
    await ytResolveStream('mix-1'); // observes wall + video — must be NEUTRAL
    noteYtFailure(); // the 3rd strike
    expect(ytAvailable()).toBeFalse(); // the streak survived the mixed verdict
  });

  test('positive control: a video-only verdict still resets the streak (no over-correction)', async () => {
    const videoOnly = ((_url: string, init?: any) =>
      Promise.resolve(
        new Response(JSON.stringify({ playabilityStatus: { status: 'UNPLAYABLE' } }), { status: 200 }),
      )) as unknown as typeof fetch;
    setYtFetch(videoOnly);

    resetYtKillSwitch();
    noteYtFailure();
    noteYtFailure(); // streak = 2
    await ytResolveStream('vid-only'); // no wall observed → the source is healthy → reset
    noteYtFailure();
    noteYtFailure(); // 2 fresh strikes
    expect(ytAvailable()).toBeTrue(); // the reset happened (2 < 3)
  });
});
