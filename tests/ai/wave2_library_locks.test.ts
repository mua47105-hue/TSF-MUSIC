/**
 * THE TEN · WAVE 2 LOCKS — library & data (F4/F5).
 *
 *   F4 Smart crates — every folder predicate is pinned against scripted
 *      ledger/store fixtures with LITERAL thresholds (9 plays out, 10 in;
 *      ratio 0.333 out, 0.667 in; 89d out, 91d in), re-listings fold into
 *      one recording, hygiene passes (filterClean + reconcileRecordings),
 *      and empty evidence is an honest empty array.
 *   F5 Meta overrides — identity passthrough (SAME object), override
 *      creates a NEW object without mutating the source, re-credited rows
 *      share one override via the recording key, streamUrl can NEVER be
 *      persisted (whitelist), the 500-cap LRU evicts, and the store
 *      round-trips through real AsyncStorage.
 *
 * Mutation targets (scripts/mutation_v42.sh W2-*): heavy-rotation floor,
 * graveyard ratio, the forgotten-gems evidence gate, the override
 * passthrough.
 */

import { describe, expect, test, mock } from 'bun:test';

// bun hoists static imports above runtime mocks → dynamic imports below.

// Real in-memory AsyncStorage (honest persistence round-trips).
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
  },
}));
mock.module('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: 'active' },
  Platform: { OS: 'android', select: (o: any) => o.android },
  NativeModules: {},
}));

const { heavyRotation, theGraveyard, forgottenGems, recentlyRescued, buildSmartFolders } = await import(
  '../../src/ai/smartFolders'
);
const { titleKeyOf, creditSetOf, nestedCredits } = await import('../../src/api/recording');
const {
  saavnRescueId,
  resolveSaavnRow,
  resetSaavnRescueForTests,
} = await import('../../src/player/saavnRescue');
const {
  initMetaOverrides,
  saveMetaOverride,
  removeMetaOverride,
  applyMetaOverride,
  metaOverrideKeyFor,
  getMetaOverridesSync,
  resetMetaOverridesForTests,
  reloadMetaOverridesForTests,
} = await import('../../src/storage/metaOverrides');

import type { ListenRecord } from '../../src/ai/core/types';
import type { PlayCountEntry, Track } from '../../src/types';

const NOW = 1_760_000_000_000; // fixed "now" — determinism
const DAY = 86_400_000;

function listen(
  trackId: string,
  title: string,
  artist: string,
  daysAgo: number,
  grade: ListenRecord['grade'] = 'COMPLETED',
): ListenRecord {
  return {
    trackId,
    artist,
    title,
    energy: 0.5,
    valence: 0.5,
    sessionId: 's1',
    surface: 'user_queue',
    startedTs: NOW - daysAgo * DAY,
    listenedMs: 30000,
    durationMs: 210000,
    completionRatio: 0.9,
    grade,
    wasRecommended: false,
    explorationSlot: false,
  };
}

function fav(id: string, title: string, artist: string, extra: Partial<Track> = {}): Track {
  return {
    id,
    title,
    artist,
    artwork: `https://img/${id}.jpg`,
    duration: 200,
    source: 'saavn',
    previewOnly: false,
    ...extra,
  };
}

function pc(lastAt: number): PlayCountEntry {
  return {
    track: { id: 'x', title: 'x', artist: 'x', artwork: '', duration: 1, source: 'saavn', previewOnly: false },
    count: 1,
    lastAt,
  };
}

// ── F4 · smart crates ───────────────────────────────────────────────────

describe('wave2 · F4 heavy rotation (literal threshold locks)', () => {
  test('10 plays in 14d IN, 9 plays OUT, 10 plays 15d ago OUT', () => {
    const listens: ListenRecord[] = [];
    for (let i = 0; i < 10; i++) listens.push(listen('a1', 'Song A', 'Artist A', (i % 10) + 0.5));
    for (let i = 0; i < 9; i++) listens.push(listen('b1', 'Song B', 'Artist B', (i % 9) + 0.5));
    for (let i = 0; i < 10; i++) listens.push(listen('c1', 'Song C', 'Artist C', 15 + (i % 5)));
    const out = heavyRotation(listens, [], NOW);
    expect(out.map((t) => t.title)).toEqual(['Song A']);
    expect(out[0]!.playCount).toBe(10);
  });

  test('re-listings of ONE recording fold together (6+4 plays = 10 ⇒ in)', () => {
    const listens: ListenRecord[] = [];
    for (let i = 0; i < 6; i++) listens.push(listen('saavn-1', 'Tu Chahiye (From "Movie")', 'Arijit Singh', i + 0.5));
    for (let i = 0; i < 4; i++) listens.push(listen('yt-9', 'Tu Chahiye', 'Arijit Singh', i + 0.5));
    const out = heavyRotation(listens, [], NOW);
    expect(out.length).toBe(1); // one recording, not two rows
    expect(out[0]!.playCount).toBe(10);
  });

  test('credit-REORDERED re-listings fold and SUM (critic P1: 6+4 = 10, not 0)', () => {
    const listens: ListenRecord[] = [];
    // "Arijit Singh, Mithoon" vs "Mithoon, Arijit Singh" — the same song
    // re-credited in a different order keys differently on primaryArtist,
    // but folds together through the nested-credit bucket.
    for (let i = 0; i < 6; i++) listens.push(listen('saavn-1', 'Tum Hi Ho', 'Arijit Singh, Mithoon', i + 0.5));
    for (let i = 0; i < 4; i++) listens.push(listen('saavn-2', 'Tum Hi Ho', 'Mithoon, Arijit Singh', i + 0.5));
    const out = heavyRotation(listens, [], NOW);
    expect(out.length).toBe(1);
    expect(out[0]!.playCount).toBe(10);
  });

  test('SINGLETON GUARD: a featured artist\u0027s same-titled song never folds in (critic R2)', () => {
    const listens: ListenRecord[] = [];
    // "Kar Gayi Chull" by Badshah alone vs the Fazilpuria track featuring
    // him — nested credits ({badshah} \u2282 {fazilpuria, badshah}) but the
    // lone credit is only SECONDARY: these are DIFFERENT songs, so 6+6
    // plays stay split and NEITHER honestly reaches Heavy Rotation.
    for (let i = 0; i < 6; i++) listens.push(listen('saavn-1', 'Kar Gayi Chull', 'Badshah', i + 0.5));
    for (let i = 0; i < 6; i++) listens.push(listen('saavn-2', 'Kar Gayi Chull', 'Fazilpuria, Badshah', i + 0.5));
    expect(heavyRotation(listens, [], NOW)).toEqual([]);
  });

  test('artist-less ledger rows never fold (two distinct songs must not merge)', () => {
    const listens: ListenRecord[] = [];
    for (let i = 0; i < 6; i++) listens.push(listen('x1', 'Mystery Song', '', i + 0.5, 'COMPLETED'));
    for (let i = 0; i < 6; i++) listens.push(listen('x2', 'Mystery Song', '', i + 0.5, 'COMPLETED'));
    // 12 attempts across two DIFFERENT songs with no artist identity —
    // an honest folder refuses to fold them into one 12-play recording.
    expect(heavyRotation(listens, [], NOW)).toEqual([]);
  });

  test("ledger rows are ENRICHED from the device's own copies (playable rows)", () => {
    const listens: ListenRecord[] = [];
    for (let i = 0; i < 11; i++) listens.push(listen('saavn-777', 'Banger', 'Star Artist', i + 0.5));
    const full = fav('saavn-777', 'Banger', 'Star Artist', {
      encryptedUrl: 'encrypted://abc',
      previewUrl: 'https://preview/abc.mp4',
      artwork: 'https://img/777.jpg',
      saavnId: '777',
    });
    const out = heavyRotation(listens, [full], NOW);
    expect(out.length).toBe(1);
    expect(out[0]!.encryptedUrl).toBe('encrypted://abc'); // resolvable at play time
    expect(out[0]!.previewUrl).toBe('https://preview/abc.mp4');
    expect(out[0]!.artwork).toBe('https://img/777.jpg'); // no bare seed tile
    expect(out[0]!.saavnId).toBe('777'); // the by-id rescue rung can find it
  });

  test('un-enriched rows still carry the provider id the rescue rung needs', () => {
    const listens: ListenRecord[] = [];
    for (let i = 0; i < 11; i++) listens.push(listen('saavn-888', 'No Local Copy', 'Star Artist', i + 0.5));
    const out = heavyRotation(listens, [], NOW);
    expect(out.length).toBe(1);
    expect(out[0]!.id).toBe('saavn-888'); // buildPlayable strips the prefix → getSongById('888')
  });

  test('skip grades do not count as plays in the fold (skips are not streams)', () => {
    const listens: ListenRecord[] = [];
    for (let i = 0; i < 8; i++) listens.push(listen('a1', 'Song A', 'Artist A', i + 0.5, 'COMPLETED'));
    for (let i = 0; i < 3; i++) listens.push(listen('a1', 'Song A', 'Artist A', i + 0.5, 'INSTANT_REJECT'));
    const out = heavyRotation(listens, [], NOW);
    // 11 attempts but the folder counts PLAYS — 8 completed < 10 ⇒ honest out
    expect(out).toEqual([]);
  });
});

describe('wave2 · F4 the graveyard (literal ratio + evidence locks)', () => {
  test('3 plays / 2 skips (0.667) IN · 3 plays / 1 skip OUT · 2 plays / 2 skips OUT', () => {
    const listens: ListenRecord[] = [
      listen('d1', 'Dead Song', 'Artist D', 1, 'MID_SKIP'),
      listen('d1', 'Dead Song', 'Artist D', 2, 'EARLY_SKIP'),
      listen('d1', 'Dead Song', 'Artist D', 3, 'COMPLETED'),
      listen('e1', 'Fine Song', 'Artist E', 1, 'MID_SKIP'),
      listen('e1', 'Fine Song', 'Artist E', 2, 'COMPLETED'),
      listen('e1', 'Fine Song', 'Artist E', 3, 'COMPLETED'),
      listen('f1', 'Sparse Song', 'Artist F', 1, 'EARLY_SKIP'),
      listen('f1', 'Sparse Song', 'Artist F', 2, 'EARLY_SKIP'),
    ];
    const out = theGraveyard(listens, [], NOW);
    expect(out.map((t) => t.title)).toEqual(['Dead Song']);
  });

  test('boundary: ratio exactly 0.6 is NOT graveyard (strictly greater)', () => {
    const listens: ListenRecord[] = [
      listen('g1', 'Edge Song', 'Artist G', 1, 'MID_SKIP'),
      listen('g1', 'Edge Song', 'Artist G', 2, 'MID_SKIP'),
      listen('g1', 'Edge Song', 'Artist G', 3, 'MID_SKIP'),
      listen('g1', 'Edge Song', 'Artist G', 4, 'COMPLETED'),
      listen('g1', 'Edge Song', 'Artist G', 5, 'COMPLETED'),
    ]; // 3/5 = 0.6 exactly
    expect(theGraveyard(listens, [], NOW)).toEqual([]);
  });
});

describe('wave2 · F4 forgotten gems (staleness + evidence locks)', () => {
  test('91d IN · 89d OUT · never-played OUT (no honest timestamp)', () => {
    const favorites = [fav('g1', 'Old Gem', 'Artist G'), fav('h1', 'Fresh Heart', 'Artist H'), fav('i1', 'Unplayed Heart', 'Artist I')];
    const playCounts: Record<string, PlayCountEntry> = {
      g1: pc(NOW - 91 * DAY),
      h1: pc(NOW - 89 * DAY),
      // i1: deliberately no entry
    };
    const out = forgottenGems(favorites, playCounts, [], NOW);
    expect(out.map((t) => t.title)).toEqual(['Old Gem']);
  });

  test('ledger evidence RESCUES a gem whose playCounts entry was evicted (critic MINOR-5)', () => {
    const favorites = [fav('k1', 'Ledger Gem', 'Artist K')];
    // playCounts has NO entry for k1 (evicted by the 300-LRU), but the
    // ledger remembers a listen 100 days ago for the same recording —
    // the heart is honestly "forgotten", not "unexplored".
    const listens = [listen('k1', 'Ledger Gem', 'Artist K', 100)];
    const out = forgottenGems(favorites, {}, listens, NOW);
    expect(out.map((t) => t.title)).toEqual(['Ledger Gem']);
    // and a RECENT ledger listen keeps it out (fresh evidence wins):
    const recent = [listen('k1', 'Ledger Gem', 'Artist K', 2)];
    expect(forgottenGems(favorites, {}, recent, NOW)).toEqual([]);
  });

  test('a different same-titled song\u0027s recent play does NOT un-forget the gem (critic R2)', () => {
    // Heart + stale play of "Kar Gayi Chull | Badshah" (100d), but
    // yesterday the Fazilpuria song played — without the singleton guard
    // the recent listen masked the gem. With it, the gem stays listed.
    const favorites = [fav('k9', 'Kar Gayi Chull', 'Badshah')];
    const playCounts: Record<string, PlayCountEntry> = { k9: pc(NOW - 100 * DAY) };
    const listens = [listen('saavn-2', 'Kar Gayi Chull', 'Fazilpuria, Badshah', 1)];
    const out = forgottenGems(favorites, playCounts, listens, NOW);
    expect(out.map((t) => t.title)).toEqual(['Kar Gayi Chull']);
  });

  test('stalest first (deterministic order) + explicit rows filtered out', () => {
    const favorites = [
      fav('g1', '91d Gem', 'Artist G'),
      fav('j1', '100d Gem', 'Artist J'),
      fav('x1', 'Explicit Gem', 'Artist X', { explicit: true }),
    ];
    const playCounts: Record<string, PlayCountEntry> = {
      g1: pc(NOW - 91 * DAY),
      j1: pc(NOW - 100 * DAY),
      x1: pc(NOW - 120 * DAY),
    };
    const out = forgottenGems(favorites, playCounts, [], NOW);
    expect(out.map((t) => t.title)).toEqual(['100d Gem', '91d Gem']); // stalest first, explicit gone
  });
});

describe('wave2 · F4 recently rescued (provenance locks)', () => {
  test('only rows whose played entry came via a rescue rung, order preserved', () => {
    const recents = [
      fav('r1', 'Rescued One', 'A', { rescued: true, rescueRung: 'youtube' }),
      fav('n1', 'Normal', 'B'),
      fav('r2', 'Rescued Two', 'C', { rescued: true, rescueRung: 'variant' }),
    ];
    const out = recentlyRescued(recents);
    expect(out.map((t) => t.id)).toEqual(['r1', 'r2']);
  });

  test('explicit rescued rows are filtered (safety first)', () => {
    const recents = [fav('r1', 'Rescued Explicit', 'A', { rescued: true, explicit: true })];
    expect(recentlyRescued(recents)).toEqual([]);
  });
});

describe('wave2 · F4 buildSmartFolders (facade honesty)', () => {
  test('empty evidence ⇒ honest empty arrays, never fake filler', () => {
    const out = buildSmartFolders({ listens: [], favorites: [], playCounts: {}, recents: [], now: NOW });
    expect(out.heavyRotation).toEqual([]);
    expect(out.forgottenGems).toEqual([]);
    expect(out.graveyard).toEqual([]);
    expect(out.recentlyRescued).toEqual([]);
  });
});

// ── F5 · metadata overrides ─────────────────────────────────────────────

const T1 = fav('saavn-100', 'Wrong Title', 'Wrong Artist', { album: 'Wrong Album' });
const T2 = fav('yt-200', 'Wrong Title', 'Wrong Artist'); // re-credited re-listing, same recording

describe('wave2 · F5 applyMetaOverride (purity + identity locks)', () => {
  test('identity passthrough: no map / no entry ⇒ the SAME object', () => {
    resetMetaOverridesForTests();
    initMetaOverrides();
    expect(applyMetaOverride(T1, null)).toBe(T1); // same reference
    expect(applyMetaOverride(T1, {})).toBe(T1); // same reference
    expect(applyMetaOverride(T1, getMetaOverridesSync())).toBe(T1);
  });

  test('an override returns a NEW object with exactly the corrected fields', async () => {
    resetMetaOverridesForTests();
    initMetaOverrides();
    await saveMetaOverride(metaOverrideKeyFor(T1), { title: 'Right Title', artist: 'Right Artist' });
    const before = { ...T1 };
    const shown = applyMetaOverride(T1, getMetaOverridesSync());
    expect(shown).not.toBe(T1); // new object
    expect(shown.title).toBe('Right Title');
    expect(shown.artist).toBe('Right Artist');
    expect(shown.album).toBe('Wrong Album'); // untouched field passes through
    expect(T1).toEqual(before); // the source row was NEVER mutated
  });

  test('re-credited re-listings share ONE override (recording-key identity)', async () => {
    resetMetaOverridesForTests();
    initMetaOverrides();
    await saveMetaOverride(metaOverrideKeyFor(T1), { title: 'Right Title', artist: 'Right Artist' });
    const shown2 = applyMetaOverride(T2, getMetaOverridesSync());
    expect(shown2.title).toBe('Right Title'); // a different provider id, the same song
    expect(shown2).not.toBe(T2);
  });

  test('removeMetaOverride restores provider truth', async () => {
    resetMetaOverridesForTests();
    initMetaOverrides();
    await saveMetaOverride(metaOverrideKeyFor(T1), { title: 'Right Title' });
    await removeMetaOverride(metaOverrideKeyFor(T1));
    expect(applyMetaOverride(T1, getMetaOverridesSync())).toBe(T1);
  });
});

describe('wave2 · F5 persistence (whitelist + cap + round-trip)', () => {
  test('streamUrl can NEVER be persisted — the whitelist strips it', async () => {
    resetMetaOverridesForTests();
    memStore.clear();
    initMetaOverrides();
    await saveMetaOverride(metaOverrideKeyFor(T1), {
      title: 'Right Title',
      // the malicious/buggy caller tries to sneak a stream URL in:
      ...( { streamUrl: 'https://ip-bound.example/stream.m3u8' } as any),
    } as any);
    const raw = memStore.get('tsf.metaOverrides.v1') ?? '';
    expect(raw).not.toContain('streamUrl');
    expect(raw).not.toContain('ip-bound.example');
    const shown = applyMetaOverride(T1, getMetaOverridesSync());
    expect((shown as Track).streamUrl).toBeUndefined();
  });

  test('whitespace-only corrections are ignored (no empty overrides)', async () => {
    resetMetaOverridesForTests();
    memStore.clear();
    initMetaOverrides();
    await saveMetaOverride(metaOverrideKeyFor(T1), { title: '   ' });
    expect(Object.keys(getMetaOverridesSync()).length).toBe(0);
  });

  test('LRU cap: the 501st correction evicts the oldest', async () => {
    resetMetaOverridesForTests();
    memStore.clear();
    initMetaOverrides();
    for (let i = 0; i < 501; i++) {
      await saveMetaOverride(`key-${i}`, { title: `T${i}` });
    }
    const map = getMetaOverridesSync();
    expect(Object.keys(map).length).toBe(500);
    expect(map['key-0']).toBeUndefined(); // the oldest is gone
    expect(map['key-500']).toBeDefined(); // the newest survives
    // the persisted copy agrees with the cache (real round-trip)
    await reloadMetaOverridesForTests();
    expect(Object.keys(getMetaOverridesSync()).length).toBe(500);
    expect(getMetaOverridesSync()['key-500']?.title).toBe('T500');
  });
});

// ── F4 · the by-id rescue rung (BEHAVIORAL — scripted double, no grep) ──

describe('wave2 · F4 saavnRescue (behavioral locks, critic R2)', () => {
  const row = (over: Partial<Track>): Track =>
    ({ id: 'saavn-123', title: 'T', artist: 'A', artwork: '', duration: 1, source: 'saavn', previewOnly: false, ...over });

  test('resolves a URL-less saavn row through the injected fetcher', async () => {
    resetSaavnRescueForTests();
    let calledWith = '';
    const fresh = fav('saavn-123', 'T', 'A', { encryptedUrl: 'enc://x', saavnId: '123' });
    const out = await resolveSaavnRow(row({ saavnId: '123' }), async (id) => {
      calledWith = id;
      return fresh;
    });
    expect(calledWith).toBe('123');
    expect(out).toBe(fresh);
  });

  test('strips the saavn- prefix when only the composite id exists', async () => {
    resetSaavnRescueForTests();
    let calledWith = '';
    await resolveSaavnRow(row({}), async (id) => {
      calledWith = id;
      return null;
    });
    expect(calledWith).toBe('123');
  });

  test('youtube rows NEVER rescue (the fetcher is not even called)', async () => {
    resetSaavnRescueForTests();
    let calls = 0;
    const out = await resolveSaavnRow(row({ source: 'youtube', id: 'yt-1' }), async () => {
      calls += 1;
      return null;
    });
    expect(out).toBe(null);
    expect(calls).toBe(0);
  });

  test('an id-less saavn row is unrescuable and never fetched', async () => {
    resetSaavnRescueForTests();
    let calls = 0;
    const out = await resolveSaavnRow(row({ id: 'saavn-' }), async () => {
      calls += 1;
      return null;
    });
    expect(out).toBe(null);
    expect(calls).toBe(0);
  });

  test('a failed fetch is negative-cached: the second call never re-probes', async () => {
    resetSaavnRescueForTests();
    let calls = 0;
    const failing = async () => {
      calls += 1;
      return null;
    };
    const t = row({});
    expect(await resolveSaavnRow(t, failing)).toBe(null);
    expect(await resolveSaavnRow(t, failing)).toBe(null);
    expect(calls).toBe(1); // the dead id is remembered for the session
  });

  test('the negative cache is bounded: the 201st dead id evicts the oldest', async () => {
    resetSaavnRescueForTests();
    let calls = 0;
    const failing = async () => {
      calls += 1;
      return null;
    };
    for (let i = 0; i < 201; i++) {
      await resolveSaavnRow(row({ id: `saavn-${i}` }), failing);
    }
    expect(calls).toBe(201);
    // id 0 was evicted (oldest) — probing it again re-fetches; id 200 is
    // still remembered and costs no call.
    await resolveSaavnRow(row({ id: 'saavn-0' }), failing);
    await resolveSaavnRow(row({ id: 'saavn-200' }), failing);
    expect(calls).toBe(202);
  });

  test('saavnRescueId: the identity rules in isolation', () => {
    expect(saavnRescueId(row({}))).toBe('123');
    expect(saavnRescueId(row({ saavnId: '999' }))).toBe('999');
    expect(saavnRescueId(row({ source: 'youtube' }))).toBe(null);
    expect(saavnRescueId(row({ id: 'saavn-' }))).toBe(null);
  });
});

// ── source locks (the wiring actually exists) ───────────────────────────

describe('wave2 · source locks', () => {
  test('LibraryScreen wires the Crates chip to mindbeat.smartFolders', async () => {
    const src = await Bun.file(new URL('../../src/screens/LibraryScreen.tsx', import.meta.url)).text();
    expect(src).toContain("'crates'");
    expect(src).toContain('mindbeat.smartFolders()');
  });

  test('TrackRow renders through the override resolver', async () => {
    const src = await Bun.file(new URL('../../src/components/TrackRow.tsx', import.meta.url)).text();
    expect(src).toContain('applyMetaOverride(track');
  });

  test('TrackMenu carries the Edit Info editor', async () => {
    const src = await Bun.file(new URL('../../src/components/TrackMenu.tsx', import.meta.url)).text();
    expect(src).toContain('Edit info');
    expect(src).toContain('saveMetaOverride');
  });

  test('buildPlayable preserves rescue provenance (the Recently Rescued feed)', async () => {
    const src = await Bun.file(new URL('../../src/player/PlayerProvider.tsx', import.meta.url)).text();
    expect(src).toContain('rescued: (t as Track).rescued');
  });

  test('buildPlayable wires the BEHAVIORAL rescue module (not an inline grep target)', async () => {
    const src = await Bun.file(new URL('../../src/player/PlayerProvider.tsx', import.meta.url)).text();
    expect(src).toContain('resolveSaavnRow(t, getSongById)');
  });

  test('the Edit Info save never lies (blank form = restore or honest no-op)', async () => {
    const src = await Bun.file(new URL('../../src/components/TrackMenu.tsx', import.meta.url)).text();
    expect(src).toContain('NOTHING TO CHANGE');
    expect(src).toContain('allEmpty');
  });
});
