/**
 * THE ENTITY_ARTIST ZERO-WIPE LOCK — "arijit" must return songs BY Arijit.
 *
 * Found by the Android E2E lab (round 8): an artist-only query painted 22
 * rows early, then the HONEST ZERO check (S6/SIG M2.1 — every row scores
 * queryMatch < 0.34 because an artist query has no title axis) wiped them
 * to zero 10ms later. On device the user saw 'NOT IN THE STACKS' over a
 * healthy answer. For artist intent the ARTIST axis is the relevance
 * axis. Locked forever: entity_artist results survive the final paint.
 */

import { describe, expect, test, beforeAll, beforeEach, afterAll, mock } from 'bun:test';

mock.module('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
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

import { setYtFetch, resetYtKillSwitch, clearYtCaches } from '../../src/api/youtube';
import { clearSearchCaches } from '../../src/search/retrieve';

function saavnRow(id: string, title: string, artists: Array<{ name: string }>, plays: string) {
  return {
    id,
    title,
    more_info: {
      encrypted_media_url: 'enc-' + id,
      '320kbps': 'true',
      language: 'hindi',
      year: '2020',
      artistMap: { primary_artists: artists, featured_artists: [] },
    },
    play_count: plays,
  };
}

const ARTIST_QUERY_ROWS = {
  results: [
    saavnRow('th1', 'Tum Hi Ho', [{ name: 'Arijit Singh' }], '395133440'),
    saavnRow('ch1', 'Channa Mereya', [{ name: 'Arijit Singh' }], '280123456'),
    saavnRow('kh1', 'Kesariya', [{ name: 'Arijit Singh' }], '221249999'),
    saavnRow('ra1', 'Raabta', [{ name: 'Arijit Singh' }], '52490000'),
    saavnRow('ag1', 'Agar Tum Saath Ho', [{ name: 'Arijit Singh' }], '90111111'),
    saavnRow('ij1', 'Ijazat', [{ name: 'Arijit Singh' }], '410222'),
    saavnRow('hv1', 'Hawayein', [{ name: 'Arijit Singh' }], '880123'),
    saavnRow('gl1', 'Gerua', [{ name: 'Arijit Singh' }], '340555'),
  ],
};

type Route = (url: string, init?: any) => { status: number; json: any } | undefined;

function installFetch(routes: Route[]) {
  const impl = (url: any, init?: any) => {
    const u = String(url);
    for (const r of routes) {
      const out = r(u, init);
      if (out) return Promise.resolve(new Response(JSON.stringify(out.json), { status: out.status }));
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
  (globalThis as any).fetch = impl as typeof fetch;
}

const isSaavnSearch = (u: string) => u.includes('jiosaavn.com') && u.includes('search.getResults');
const isItunes = (u: string) => u.includes('itunes.apple.com');

const PRISTINE_FETCH = globalThis.fetch;

beforeAll(() => {
  setYtFetch(null);
  resetYtKillSwitch();
  clearYtCaches();
});

afterAll(() => {
  globalThis.fetch = PRISTINE_FETCH;
});

beforeEach(() => {
  clearSearchCaches();
});

describe('entity_artist — artist-only queries never wipe their own rows', () => {
  test('"arijit" final paint keeps the songs BY Arijit Singh', async () => {
    installFetch([(u) => (isSaavnSearch(u) ? { status: 200, json: ARTIST_QUERY_ROWS } : undefined)]);

    const { searchMusicV2 } = await import('../../src/api/music');

    let earlyCount = -1;
    const res = await searchMusicV2('arijit', {
      onEarly: (r) => {
        earlyCount = r.tracks.length;
      },
    });

    expect(earlyCount).toBeGreaterThan(0); // the early paint fired
    expect(res.tracks.length).toBeGreaterThan(0); // …and the final paint keeps it (was 0)
    expect(res.tracks.some((t) => t.artist.toLowerCase().includes('arijit'))).toBe(true);
  });

  test('a genuinely unrelated query still ends honest-zero (the check still bites)', async () => {
    const UNRELATED = {
      results: [
        saavnRow('zz1', 'Totally Unrelated Song', [{ name: 'Somebody Else' }], '12'),
        saavnRow('zz2', 'Another Unrelated Tune', [{ name: 'Someone Else' }], '34'),
      ],
    };
    installFetch([
      // serve rows ONLY for the exact original query — the relaxation
      // ladder's re-probes get nothing, so a wipe can't be papered over
      (u) =>
        isSaavnSearch(u) && decodeURIComponent(u).includes('zzz qqq unheard thing')
          ? { status: 200, json: UNRELATED }
          : isSaavnSearch(u)
            ? { status: 200, json: { results: [] } }
            : undefined,
      (u) => (isItunes(u) ? { status: 200, json: { results: [] } } : undefined),
    ]);

    const { searchMusicV2 } = await import('../../src/api/music');
    const res = await searchMusicV2('zzz qqq unheard thing');
    expect(res.tracks.length).toBe(0); // honest zero survives for real junk
  });
});
