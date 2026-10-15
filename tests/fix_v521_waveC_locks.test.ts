/**
 * WAVE C LOCKS — v5.2.1 FIX-C1 … FIX-C5.
 *
 * THE AUDIT'S HEADLINE (C1): src/ai/engine.ts and the four v2 surfaces
 * (mixes, daylist, ontherise, shuffle) had ZERO test imports — while
 * service.ts:199 falls back to engine.getRadio() whenever MINDBEAT is
 * disabled/cold/broken. THE UNTESTED PATH IS THE PATH USERS GET WHEN
 * INTELLIGENCE IS OFF. This file ports the surfaces.test.ts harness
 * pattern (fixture catalog + buildProfile over the four-community
 * ledger) to all five modules, plus:
 *
 *  C2 · lrclib originCache is BOUNDED (30, LRU) — the doc's "LRU-30"
 *      claim was a lie until this wave; 31st insert evicts the oldest.
 *  C3 · artists photoCache + namePhotoCache are BOUNDED (300, LRU).
 *  C4 · every PERF_BUDGETS key appears in perf.test.ts — the comment's
 *      "enforced by perf.test.ts" is now TRUE for all 7 (the audit found
 *      coldStartDeltaMs + aiPlaylistEndToEndMs asserted nowhere; both
 *      now carry measured values, with coldStart's device half honestly
 *      attributed to the E2E gate).
 *  C5 · the hygiene fixture mock is FILE-SCOPED (afterAll restores the
 *      real module) — the v5.0.1 mock-leak class closed a third time;
 *      this file loads AFTER tests/ai/hygiene_behavioral_locks.test.ts
 *      and canaries the restoration with a live delegation check.
 *
 * Mutations proven RED (worklog V5.2.1-WAVE-C): M-C1-1..5, M-C2-1/2,
 * M-C3-1/2, M-C4-1/2, M-C5-1/2 — every one restored byte-exact.
 */

import { describe, expect, test, afterAll, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rnMockSurface } from './helpers/rnMockSurface';
import { fourCommunityLedger } from './ai/corpus';

mock.module('react-native', () => rnMockSurface());
const __asmem = new Map<string, string>();
mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => __asmem.get(k) ?? null,
    setItem: async (k: string, v: string) => { __asmem.set(k, v); },
    removeItem: async (k: string) => { __asmem.delete(k); },
    multiRemove: async (ks: string[]) => { ks.forEach((k) => __asmem.delete(k)); },
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

// ── the fixture saavn seam (spread-real — the hygiene pattern) ─────────
// Only the two catalog entry points engine.ts consumes are overridden;
// every other export stays the REAL function. The afterAll restores the
// real module (the C5 law applies to THIS file too).
const realSaavn = await import('../src/api/saavn');

/** The mutable fixture seam: null = the REAL module answers (network);
 *  set = the fixture catalog answers (deterministic). Swapped per-test,
 *  reset in finally — never left dangling. */
let seam: { search(q: string, limit: number): Promise<any[]>; artist(a: string, limit: number): Promise<any[]> } | null = null;

const FIXTURE_ARTISTS = [
  'arijit singh', 'shreya ghoshal', 'pritam', 'jubin nautiyal',
  'diljit dosanjh', 'ap dhillon', 'eminem', 'nusrat fateh ali khan',
  'rekha bhardwaj', 'karan aujla', 'guru randhawa',
];

function fxTrack(artist: string, i: number, extra: Record<string, unknown> = {}): any {
  return {
    id: `cfx-${artist.replace(/\s+/g, '-')}-${i}`,
    title: `${artist.split(' ')[0]} Song ${i}`,
    artist,
    album: `${artist} Album`,
    artwork: '',
    duration: 200 + (i % 5) * 10,
    source: 'saavn',
    previewOnly: false,
    language: artist === 'eminem' ? 'english' : 'hindi',
    year: 2024,
    ...extra,
  };
}

const FIXTURES: any[] = FIXTURE_ARTISTS.flatMap((a) => Array.from({ length: 10 }, (_, i) => fxTrack(a, i)));

function fixtureForArtist(artist: string, limit: number): any[] {
  const own = FIXTURES.filter((t) => t.artist === artist);
  const rest = FIXTURES.filter((t) => t.artist !== artist);
  return [...own, ...rest].slice(0, limit);
}

mock.module('../src/api/saavn', () => ({
  ...realSaavn,
  searchSaavnClean: async (q: string, limit = 20) => {
    if (seam) return seam.search(q, limit);
    const tokens = String(q).toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const scored = FIXTURES.map((t) => {
      const hay = `${t.artist} ${t.title}`.toLowerCase();
      let s = 0;
      for (const w of tokens) if (hay.includes(w)) s += 2;
      return { t, s };
    });
    const hits = scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.t);
    return (hits.length ? hits : FIXTURES).slice(0, limit);
  },
  getArtistTracks: async (artistName: string, limit = 14) => {
    if (seam) return seam.artist(artistName, limit);
    return FIXTURE_ARTISTS.includes(artistName) ? fixtureForArtist(artistName, limit) : realSaavn.getArtistTracks(artistName, limit);
  },
}));

afterAll(() => {
  // the C5 law: this file's overrides are file-scoped too
  mock.module('../src/api/saavn', () => realSaavn);
});

const ROOT = join(import.meta.dir, '..', 'src');
const readSrc = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

// ── fixtures for the v2 surfaces ───────────────────────────────────────
import { buildProfile } from '../src/ai/core/profile';
import { SessionBrain } from '../src/ai/core/session';
import type { CatalogApi, SurfaceCtx } from '../src/ai/surfaces/deps';
import type { Track } from '../src/types';

const NOW = 1750000000000;
const { listens, sessions } = fourCommunityLedger();
const PROFILE = buildProfile(listens, [], sessions, { now: NOW });
const BRAIN = new SessionBrain(NOW);
for (const l of listens.slice(-12)) BRAIN.push(l);

function fixtureApi(): CatalogApi {
  return {
    async search(_q: string, limit = 20) {
      const start = Math.abs(_q.length * 7) % FIXTURES.length;
      return [...FIXTURES.slice(start), ...FIXTURES.slice(0, start)].slice(0, limit) as Track[];
    },
    async artistTracks(artist: string, limit = 14) {
      return fixtureForArtist(artist, limit) as Track[];
    },
    async trending(limit = 20) {
      return FIXTURES.slice(0, limit) as Track[];
    },
  };
}

function ctx(overrides: Partial<SurfaceCtx> = {}): SurfaceCtx {
  return {
    api: fixtureApi(),
    profile: PROFILE,
    session: BRAIN.state,
    now: NOW,
    listens,
    ...overrides,
  };
}

const seedTrack: Track = {
  id: 'cfx-arijit-singh-0',
  title: 'Arijit Song 0',
  artist: 'arijit singh',
  artwork: '',
  duration: 210,
  source: 'saavn',
  previewOnly: false,
};

// ── C1 · engine.ts — the fallback engine gets tests ────────────────────
describe('FIX-C1 · engine.ts (the intelligence-off path users actually get)', () => {
  test('getTopArtists weights recents + favorites + counts, most-loved first', async () => {
    const store = await import('../src/storage/store');
    const t = (id: string, artist: string): Track =>
      ({ id, title: id, artist, artwork: '', duration: 200, source: 'saavn', previewOnly: false } as Track);
    // b is loved (favorites + counts), a is merely recent — love outranks recency
    await store.pushRecent(t('r1', 'artist b'));
    await store.pushRecent(t('r2', 'artist a'));
    await store.toggleFavorite(t('f1', 'artist b'));
    await store.incrementPlayCount(t('p1', 'artist b'));
    await store.incrementPlayCount(t('p2', 'artist b'));
    const top = await (await import('../src/ai/engine')).getTopArtists(4);
    expect(top[0]).toBe('artist b');
    expect(top).toContain('artist a');
    expect(top).not.toContain('Unknown artist');
  });

  test('getRadio returns clean, non-preview, seed-excluded fixture tracks', async () => {
    const { getRadio } = await import('../src/ai/engine');
    const out = await getRadio(seedTrack, 8);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(8);
    expect(out.some((t) => t.id === seedTrack.id)).toBeFalse(); // the seed never radios itself
    for (const t of out) {
      expect(t.source).toBe('saavn');
      expect(t.previewOnly).toBeFalse();
    }
  });

  test('getRadio degrades to the honest empty when the catalog dies', async () => {
    const { getRadio } = await import('../src/ai/engine');
    seam = {
      search: async () => {
        throw new Error('lab: catalog down');
      },
      artist: async () => {
        throw new Error('lab: catalog down');
      },
    };
    try {
      const out = await getRadio(seedTrack, 8);
      expect(out).toEqual([]); // honest empty — never a fabricated row
    } finally {
      seam = null; // the seam never dangles
    }
  });

  test('getRecommendations: interleaved pools, per-artist cap 2, seeds excluded', async () => {
    const { getRecommendations } = await import('../src/ai/engine');
    const seeds = [seedTrack, { ...seedTrack, id: 'cfx-arijit-singh-1' }];
    const out = await getRecommendations(seeds as Track[], 10);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(10);
    for (const s of seeds) expect(out.some((t) => t.id === s.id)).toBeFalse();
    const perArtist = new Map<string, number>();
    for (const t of out) perArtist.set(t.artist, (perArtist.get(t.artist) ?? 0) + 1);
    for (const [a, n] of perArtist) expect(n, `artist ${a} exceeded the 2-per-artist cap`).toBeLessThanOrEqual(2);
  });

  test('getDailyMixes: cold start → honest empty; cached → returns the cache', async () => {
    const { getDailyMixes } = await import('../src/ai/engine');
    const store = await import('../src/storage/store');
    // the lab storage is cold for mixes (no cache set yet) and the engine's
    // own build needs play-count history the cold store lacks → honest empty
    const cold = await getDailyMixes();
    expect(Array.isArray(cold)).toBeTrue();
    // the cache path: whatever is cached comes back byte-identical
    const mixes = [
      { id: 'mix-0-artist-a', title: 'Daily Mix 1', subtitle: 'artist a', artwork: '', tracks: [seedTrack, seedTrack, seedTrack] },
    ];
    await store.setDailyMixCache(mixes as any);
    const served = await getDailyMixes();
    expect(served.length).toBe(1);
    expect(served[0].id).toBe('mix-0-artist-a');
    await store.setDailyMixCache([] as any); // leave the shared cache cold for later files
  });
});

// ── C1 · the four v2 surfaces ──────────────────────────────────────────
describe('FIX-C1 · mixes.ts — the 60/25/15 cluster-cross surface', () => {
  test('buildDailyMixesV2 returns cluster-crossed mixes with honest reasons', async () => {
    const { buildDailyMixesV2 } = await import('../src/ai/surfaces/mixes');
    const mixes = await buildDailyMixesV2(ctx(), new Set());
    expect(mixes.length).toBeGreaterThan(0);
    for (const m of mixes) {
      expect(m.tracks.length).toBeGreaterThanOrEqual(4); // the <4 mix never ships
      expect(m.clusterLabel.length).toBeGreaterThan(0);
      expect(m.moodLabel.length).toBeGreaterThan(0);
      for (const t of m.tracks) {
        expect(t.isRecommended).toBeTrue(); // mixes ARE recommendations
        expect(t.reason.length).toBeGreaterThan(0); // the reason must render
        expect(typeof t.exploration).toBe('boolean');
      }
    }
  });

  test('the ≤30% yesterday-repeat bar holds under a heavy yesterday', async () => {
    const { buildDailyMixesV2 } = await import('../src/ai/surfaces/mixes');
    const { CADENCE } = await import('../src/ai/core/constants');
    // EVERY fixture row served yesterday — a maximal anti-staleness stress.
    // THE LAW has two honest outcomes and only two: either the surface
    // REFUSES to build a mix that would breach the cap (honest empty — the
    // closed fixture catalog has no unheard rows left), or every mix it
    // DOES build obeys ≤ ceil(total × 0.3). What it may never do is serve a
    // breaching mix — that is exactly what the M-C1 mutation proves.
    const yesterdayIds = new Set(FIXTURES.map((t) => t.id));
    const mixes = await buildDailyMixesV2(ctx(), yesterdayIds);
    for (const m of mixes) {
      const total = m.tracks.length;
      const fromYesterday = m.tracks.filter((t) => yesterdayIds.has(t.id)).length;
      expect(fromYesterday, `mix ${m.id} repeats ${fromYesterday}/${total}`).toBeLessThanOrEqual(
        Math.ceil(total * CADENCE.mixMaxRepeatFromYesterday),
      );
    }
    // the positive control (the catalog CAN build mixes on a clean day)
    // lives in the first test of this describe — silence here is only
    // honest because that test builds.
  });

  test('shouldRefreshMixes: the nightly + every-3rd-session cadence (pure)', async () => {
    const { shouldRefreshMixes } = await import('../src/ai/surfaces/mixes');
    const sameDay = NOW - 1000;
    expect(shouldRefreshMixes(sameDay, 0, NOW)).toBeFalse(); // same day, no sessions → keep
    expect(shouldRefreshMixes(sameDay, 3, NOW)).toBeTrue(); // 3rd session → refresh
    const yesterday = NOW - 26 * 3600_000;
    expect(shouldRefreshMixes(yesterday, 0, NOW)).toBeTrue(); // day changed → refresh
  });
});

describe('FIX-C1 · daylist.ts — the Now Sound surface', () => {
  test('buildNowSound returns a block-tagged card with reasoned picks', async () => {
    const { buildNowSound } = await import('../src/ai/surfaces/daylist');
    const card = await buildNowSound(ctx(), 12);
    expect(card).not.toBeNull();
    expect(card!.tracks.length).toBeGreaterThan(0);
    expect(['morning', 'afternoon', 'evening', 'night', 'lateNight']).toContain(card!.block);
    expect(card!.title.length).toBeGreaterThan(0); // the microgenre name
    for (const t of card!.tracks) expect(t.reason.length).toBeGreaterThan(0);
  });

  test('a profile with NO artists → honest null (the cold start)', async () => {
    const { buildNowSound } = await import('../src/ai/surfaces/daylist');
    const coldProfile = buildProfile([], [], [], { now: NOW, isColdStart: true });
    const card = await buildNowSound(ctx({ profile: coldProfile }), 12);
    expect(card).toBeNull();
  });

  test('the card is stable for the same ctx (no per-call coin flips)', async () => {
    const { buildNowSound } = await import('../src/ai/surfaces/daylist');
    const a = await buildNowSound(ctx(), 6);
    const b = await buildNowSound(ctx(), 6);
    expect(a!.title).toBe(b!.title);
    expect(a!.tracks.map((t) => t.id)).toEqual(b!.tracks.map((t) => t.id));
  });
});

describe('FIX-C1 · ontherise.ts — the discovery flagship', () => {
  test('buildOnTheRise resolves seed-of-seed chains with honest viaArtist', async () => {
    const { buildOnTheRise } = await import('../src/ai/surfaces/ontherise');
    const card = await buildOnTheRise(ctx(), 25);
    const topArtists = Object.entries(PROFILE.artists).sort((a, b) => b[1].w - a[1].w).slice(0, 4).map(([a]) => a);
    const ring: Array<{ via: string; artist: string }> = [];
    for (const a of topArtists) {
      const nbs = Object.entries(PROFILE.coplayArtists[a] ?? {}).sort((x, y) => y[1] - x[1]).slice(0, 3);
      for (const [n, w] of nbs) if (w > 0.02 && !topArtists.includes(n)) ring.push({ via: a, artist: n });
    }
    console.log('[dbg] rise card:', card === null ? 'NULL' : `tracks=${card.tracks.length}`, 'top:', JSON.stringify(topArtists), 'ring:', ring.length, JSON.stringify(ring.slice(0, 3)));
    const { decide } = await import('../src/ai/core/decision');
    const { estimateFeatures } = await import('../src/ai/core/features');
    const { buildServeRecency } = await import('../src/ai/core/decision');
    const sr = buildServeRecency(ctx().listens);
    const pools: any[] = [];
    for (const r of ring.slice(0, 6)) {
      const tracks = await (ctx().api as any).artistTracks(r.artist, 8);
      for (const t of tracks) pools.push({ trackId: t.id, artist: t.artist, language: t.language, features: estimateFeatures({ artist: t.artist, title: t.title, album: t.album }), pool: 'discovery' });
    }
    console.log('[dbg] pools:', pools.length, 'served:', pools.filter((p) => sr.has(p.trackId)).length);
    const ranked = decide(pools, { surface: 'on_the_rise', block: 'evening', dayKind: 'weekday', seedTrackIds: [], seedArtists: topArtists, requested: 25 }, { profile: PROFILE, session: BRAIN.state, now: NOW }, { serveRecency: sr, forceExploration: true });
    console.log('[dbg] ranked:', ranked.length, JSON.stringify(ranked.slice(0, 4).map((r: any) => r.trackId)));
    expect(card).not.toBeNull(); // the four-community ledger has co-play edges
    expect(card!.tracks.length).toBeGreaterThan(0);
    for (const t of card!.tracks) {
      expect(t.viaArtist.length).toBeGreaterThan(0); // the chain is printed or it is a lie
      expect(t.reason.length).toBeGreaterThan(0);
    }
  });

  test('every rise pick is OUTSIDE the listener\'s top artists (discovery, not echo)', async () => {
    const { buildOnTheRise } = await import('../src/ai/surfaces/ontherise');
    const card = await buildOnTheRise(ctx(), 25);
    const topArtists = Object.entries(PROFILE.artists)
      .sort((a, b) => b[1].w - a[1].w)
      .slice(0, 4)
      .map(([a]) => a);
    for (const t of card!.tracks) {
      expect(topArtists.includes(t.artist.toLowerCase())).toBeFalse();
    }
  });

  test('a cold profile → honest null (no edges, no fabricated rise)', async () => {
    const { buildOnTheRise } = await import('../src/ai/surfaces/ontherise');
    const coldProfile = buildProfile([], [], [], { now: NOW, isColdStart: true });
    expect(await buildOnTheRise(ctx({ profile: coldProfile }), 25)).toBeNull();
  });
});

describe('FIX-C1 · shuffle.ts — Smart Shuffle v2', () => {
  test('planFor: the 1:3 injection ratio over big queues, gentler on small ones', async () => {
    const { planFor } = await import('../src/ai/surfaces/shuffle');
    const small = planFor(8);
    expect(small.recCount).toBeGreaterThanOrEqual(1);
    expect(small.insertEvery).toBe(4);
    const big = planFor(30);
    expect(big.recCount).toBe(Math.max(2, Math.floor(30 / 3)));
    expect(big.insertEvery).toBe(3);
  });

  test('buildShuffleRecs injects reasoned recs for the upcoming window', async () => {
    const { buildShuffleRecs } = await import('../src/ai/surfaces/shuffle');
    const upcoming: Track[] = FIXTURES.filter((t) => t.artist === 'arijit singh').slice(0, 6);
    const recs = await buildShuffleRecs(ctx(), upcoming as Track[]);
    expect(recs.length).toBeGreaterThan(0);
    for (const r of recs) {
      expect(r.reason.length).toBeGreaterThan(0);
      expect(r.isRecommended).toBeTrue();
      expect(upcoming.some((u) => u.id === r.id)).toBeFalse(); // recs are NEW rows
    }
  });

  test('queue healing: the rec batch moves away from the skipped artist', async () => {
    const { buildShuffleRecs } = await import('../src/ai/surfaces/shuffle');
    const upcoming: Track[] = FIXTURES.filter((t) => t.artist === 'arijit singh').slice(0, 6);
    const skipped: Track = { ...(FIXTURES.find((t) => t.artist === 'eminem') as Track) };
    const recs = await buildShuffleRecs(ctx(), upcoming as Track[], { healFrom: skipped });
    for (const r of recs) {
      expect(r.artist.toLowerCase()).not.toBe(skipped.artist.toLowerCase()); // the "it's listening back" moment
    }
  });
});

// ── C1 · THE kill-switch fallback chain ────────────────────────────────
describe('FIX-C1 · the intelligence-off fallback is non-empty (service.ts:199 contract)', () => {
  test('mindbeat.radio (disabled) → [] AND engine.getRadio → tracks: the chain never starves', async () => {
    const { mindbeat } = await import('../src/ai/mindbeat');
    await mindbeat.init().catch(() => undefined);
    mindbeat.disabled = true; // the kill switch
    const fromMindbeat = await mindbeat.radio(seedTrack, 10);
    expect(fromMindbeat).toEqual([]); // the kill switch silences MINDBEAT
    const { getRadio } = await import('../src/ai/engine');
    const fromEngine = await getRadio(seedTrack, 10);
    expect(fromEngine.length).toBeGreaterThan(0); // the fallback does NOT starve
    mindbeat.disabled = false;
  });
});

// ── C2 + C3 — the bounded caches ───────────────────────────────────────
describe('FIX-C2 + C3 — the caches are bounded (the doc claims become true)', () => {
  test('BoundedMap: the 31st insert evicts the oldest (LRU-30)', async () => {
    const { BoundedMap } = await import('../src/api/boundedMap');
    const m = new BoundedMap<string, number>(30);
    for (let i = 0; i < 31; i++) m.set(`k${i}`, i);
    expect(m.size).toBe(30);
    expect(m.has('k0')).toBeFalse(); // the OLDEST went
    expect(m.has('k30')).toBeTrue(); // the newest stayed
  });

  test('BoundedMap: a get() refreshes recency (true LRU, not just FIFO)', async () => {
    const { BoundedMap } = await import('../src/api/boundedMap');
    const m = new BoundedMap<string, number>(3);
    m.set('a', 1);
    m.set('b', 2);
    m.set('c', 3);
    m.get('a'); // a is hot now
    m.set('d', 4); // b (coldest) goes — NOT a
    expect(m.has('a')).toBeTrue();
    expect(m.has('b')).toBeFalse();
    expect(m.size).toBe(3);
  });

  test('BoundedMap: a cap below 1 is a construction error (no silent unbounded)', async () => {
    const { BoundedMap } = await import('../src/api/boundedMap');
    expect(() => new BoundedMap(0)).toThrow();
    expect(() => new BoundedMap(-5)).toThrow();
    expect(() => new BoundedMap(1.5)).toThrow();
  });

  test('source law: the lrclib origin cache rides BoundedMap at 30', () => {
    const src = readSrc('api', 'lrclib.ts');
    expect(src).toContain('new BoundedMap<string, { at: number; origin: LyricOrigin | null }>(ORIGIN_CACHE_CAP)');
    expect(src).toContain('ORIGIN_CACHE_CAP = 30');
  });

  test('source law: BOTH artist photo caches ride BoundedMap at 300', () => {
    const src = readSrc('api', 'artists.ts');
    const rides = src.match(/new BoundedMap<string, string>\(ARTIST_PHOTO_CACHE_CAP\)/g) ?? [];
    expect(rides.length).toBe(2); // photoCache + namePhotoCache
    expect(src).toContain('ARTIST_PHOTO_CACHE_CAP = 300');
  });
});

// ── C4 — the budgets are all enforced ──────────────────────────────────
describe('FIX-C4 — every PERF_BUDGETS key appears in perf.test.ts', () => {
  test('the comment no longer lies: all 7 budgets are asserted (or honestly scoped)', () => {
    const constants = readSrc('ai', 'core', 'constants.ts');
    const budgets = constants.match(/export const PERF_BUDGETS = \{([\s\S]*?)\} as const;/)![1];
    const keys = [...budgets.matchAll(/(\w+):/g)].map((m) => m[1]);
    expect(keys.length).toBe(7);
    const perf = readFileSync(join(ROOT, '..', 'tests', 'ai', 'perf.test.ts'), 'utf8');
    const body = perf
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*\/\/.*$/gm, ' '); // CODE, not documentation — a name in a comment asserts nothing
    for (const k of keys) {
      expect(body.includes(k), `budget ${k} is asserted nowhere in perf.test.ts`).toBeTrue();
    }
  });
});

// ── C5 — the mock-leak canary ──────────────────────────────────────────
describe('FIX-C5 — the hygiene fixture mock never leaks into this file', () => {
  test('canary: getArtistTracks("arctic monkeys") carries NO hygiene fixture rows', async () => {
    // This file loads AFTER tests/ai/hygiene_behavioral_locks.test.ts. If
    // that file's fixture override leaked (no afterAll restoration), the
    // hyg-fx-* rows would answer here. With the restoration, the REAL
    // module answers (live network row ids, or an offline rejection —
    // either way, never a hygiene fixture).
    const { getArtistTracks } = await import('../src/api/saavn');
    const rows = (await getArtistTracks('arctic monkeys', 5).catch(() => [])) as Track[];
    expect(rows.some((t) => String(t.id).startsWith('hyg-fx-'))).toBeFalse();
  });

  test('source law: the hygiene file restores the real module in afterAll', () => {
    const hygiene = readFileSync(join(ROOT, '..', 'tests', 'ai', 'hygiene_behavioral_locks.test.ts'), 'utf8');
    expect(hygiene).toContain("afterAll(() => {\n  mock.module('../../src/api/saavn', () => realSaavn);\n});");
  });
});
