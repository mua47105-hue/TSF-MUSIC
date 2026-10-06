/**
 * BAR 3.7 LOCKS — the dynamic intelligent home feed.
 *
 *   1. the pager USES the generator's ladder when it yields
 *   2. an EMPTY yield (cold start / kill switch) keeps the legacy
 *      hardcoded ladder byte-identically
 *   3. the ladder is stable within one cursor position (deterministic)
 *   4. mindbeat.feedSongQueries() reads profile genres/languages + vibe
 *      and excludes internal __mood buckets
 *   5. HomeScreen actually wires the generator (source lock)
 */

import { describe, expect, test, mock } from 'bun:test';

// The facade describe imports mindbeat — mock the RN shell first (same
// pattern as godmode_locks; sqlite throws → init degrades, ledger null).
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

import { EndlessFeedPager } from '../../src/api/feed';

function fetcher(rows: number) {
  return {
    searchSongs: async (q: string, page: number) =>
      Array.from({ length: rows }, (_, i) => ({
        id: `${q}-p${page}-${i}`,
        title: `T ${q} ${page} ${i}`,
        artist: 'A',
        artwork: '',
        duration: 30,
        source: 'saavn' as const,
        previewOnly: false,
      })),
    searchAlbums: async () => [],
  };
}

describe('BAR 3.7 — the pager honors the dynamic generator', () => {
  test('queries come from the generator when it yields (and reach the fetcher)', async () => {
    const observed: string[] = [];
    const pager = new EndlessFeedPager(
      {
        searchSongs: async (q: string) => {
          observed.push(q);
          return Array.from({ length: 10 }, (_, i) => ({
            id: `g-${q}-${i}`, title: `T ${q} ${i}`, artist: `Art ${q} ${i}`, artwork: '',
            duration: 30, source: 'saavn' as const, previewOnly: false,
          }));
        },
        searchAlbums: async () => [],
      },
      { songQueryGenerator: () => ['mindbeats indie acoustic', 'second'] },
    );
    await pager.next();
    await pager.next();
    // the generated queries — not the hardcoded ladder — hit the fetcher
    expect(observed[0]).toBe('mindbeats indie acoustic');
    expect(observed).toContain('second');
    expect(observed).not.toContain('top songs');
  });

  test('an EMPTY yield falls back to the legacy ladder (first query = "top songs")', async () => {
    let observed = '';
    const pager = new EndlessFeedPager(
      {
        searchSongs: async (q: string) => {
          observed = q;
          return Array.from({ length: 10 }, (_, i) => ({
            id: `x-${q}-${i}`, title: `T ${i}`, artist: 'A', artwork: '',
            duration: 30, source: 'saavn' as const, previewOnly: false,
          }));
        },
        searchAlbums: async () => [],
      },
      { songQueryGenerator: () => [] }, // cold start / kill switch
    );
    await pager.next();
    expect(observed).toBe('top songs'); // SONG_QUERIES[0] — byte-identical legacy
  });

  test('no generator at all = pure legacy behavior', async () => {
    let observed = '';
    const pager = new EndlessFeedPager({
      searchSongs: async (q: string) => {
        observed = q;
        return Array.from({ length: 10 }, (_, i) => ({
          id: `l-${q}-${i}`, title: `T ${i}`, artist: 'A', artwork: '',
          duration: 30, source: 'saavn' as const, previewOnly: false,
        }));
      },
      searchAlbums: async () => [],
    });
    await pager.next();
    expect(observed).toBe('top songs');
  });

  test('the generated ladder is stable within one cursor position', async () => {
    const queriesSeen = new Set<string>();
    let genCalls = 0;
    let maxSongPage = 0;
    const pager = new EndlessFeedPager(
      {
        searchSongs: async (q: string, p: number) => {
          maxSongPage = Math.max(maxSongPage, p);
          queriesSeen.add(q);
          // unique TITLE per (page,row) — the pager's recording-level dedup
          // collapses same-titled same-artist rows across pages by design
          return Array.from({ length: 10 }, (_, i) => ({
            id: `s-${p}-${i}`, title: `T ${p}-${i}`, artist: `Art ${p}-${i}`, artwork: '',
            duration: 30, source: 'saavn' as const, previewOnly: false,
          }));
        },
        searchAlbums: async () => [],
      },
      {
        songQueryGenerator: () => {
          genCalls += 1;
          return [`q${genCalls}`]; // a DIFFERENT ladder every call — mid-position changes must be ignored
        },
      },
    );
    await pager.next(); // song page 1 from the q1 ladder
    await pager.next(); // albums dry → song page 2 — SAME position, SAME ladder
    expect(maxSongPage).toBeGreaterThanOrEqual(2); // went deeper
    expect(queriesSeen.size).toBe(1); // ONE query across both pages ('q2' never fetched)
  });
});

describe('BAR 3.7 — the facade query builder', () => {
  test('HomeScreen wires the generator from MINDBEAT (source lock)', async () => {
    const src = await Bun.file('src/screens/HomeScreen.tsx').text();
    expect(src).toContain('songQueryGenerator: () => mindbeat.feedSongQueries()');
  });

  test('feedSongQueries excludes internal __mood buckets and de-dupes', async () => {
    // build the facade shape the builder reads — via a fresh mindbeat-like
    // profile (direct import; the facade reads this.profile at call time)
    const { mindbeat } = await import('../../src/ai/mindbeat');
    mindbeat.profile.genres = {
      __high_energy: { w: 9, lastEventTs: 0, evidenceCount: 3, source: 'organic' },
      punjabi: { w: 4, lastEventTs: 0, evidenceCount: 3, source: 'organic' },
      indie: { w: 2, lastEventTs: 0, evidenceCount: 2, source: 'organic' },
    };
    mindbeat.profile.languages = {
      hindi: { w: 5, lastEventTs: 0, evidenceCount: 5, source: 'organic' },
    };
    const queries = mindbeat.feedSongQueries();
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((q) => !q.includes('__'))).toBe(true);
    expect(new Set(queries).size).toBe(queries.length);
    // real genre words reach the ladder
    expect(queries.some((q) => q.includes('punjabi'))).toBe(true);
  });

  test('the kill switch silences the generator (honest legacy fallback)', async () => {
    const { mindbeat } = await import('../../src/ai/mindbeat');
    await mindbeat.setDisabled(true);
    expect(mindbeat.feedSongQueries()).toEqual([]);
    expect(mindbeat.searchVibeContext()).toBeNull();
    await mindbeat.setDisabled(false);
  });
});
