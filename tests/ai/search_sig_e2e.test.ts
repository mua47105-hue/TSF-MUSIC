/**
 * SI1 — THE LOCKED REGRESSION: "tu chaiye of atif aslam" end-to-end.
 *
 * v3.3.0 painted O'Meri Laila as "Best match for your search" while the
 * real song was unreachable. Locked forever: the engine must end in
 * S-RESCUED with the verified target on top — YouTube full-length when
 * available, iTunes 30 s preview otherwise, and an honest S-PARTIAL
 * (never wrong "Best match") when neither provider can satisfy intent.
 */

import { describe, expect, test, beforeAll, beforeEach, mock } from 'bun:test';

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

import { resetYtKillSwitch, clearYtCaches } from '../../src/api/youtube';
import { clearSearchCaches } from '../../src/search/retrieve';

const JUNK_RESULTS = {
  results: [
    saavnRow('om1', "O'Meri Laila", [{ name: 'Atif Aslam' }, { name: 'Jyotica Tangri' }], '39513344'),
    saavnRow('km1', 'Kon Mayate', [{ name: 'Atif Aslam BD' }], '280'),
    saavnRow('ad1', 'Tu Chahiye', [{ name: 'A.R. Dixit' }], '22124'),
    saavnRow('sp1', 'Tu Chaiye', [{ name: 'SPECRO' }], '56'),
    saavnRow('rk1', 'Na Tu Chaiye', [{ name: 'Rock Hussain' }], '52490'),
    saavnRow('pv1', 'Tu Chahiye Mujhe', [{ name: 'Payal Jain' }], '901'),
    saavnRow('mr1', 'Marhami Haan Tu Chahiye', [{ name: 'Akshay Gemini' }], '410'),
    saavnRow('zh1', 'Tu Chahiye!', [{ name: 'Zohaan' }], '88'),
    saavnRow('ab1', 'Tu Chahiye', [{ name: 'Abir, Faraz' }], '1500'),
    saavnRow('sd1', 'Tu Chahiye', [{ name: 'Sahil Dahiya Wrld' }], '340'),
  ],
};

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

const YTM_BODY = {
  contents: {
    tabbedSearchResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            content: {
              sectionListRenderer: {
                contents: [
                  {
                    musicShelfRenderer: {
                      contents: [
                        {
                          musicResponsiveListItemRenderer: {
                            flexColumns: [
                              {
                                musicResponsiveListItemFlexColumnRenderer: {
                                  text: {
                                    runs: [
                                      {
                                        text: 'Tu Chahiye',
                                        navigationEndpoint: { watchEndpoint: { videoId: 'WTLLym2wzIM' } },
                                      },
                                    ],
                                  },
                                },
                              },
                              {
                                musicResponsiveListItemFlexColumnRenderer: {
                                  text: { runs: [{ text: 'Song • Pritam, Atif Aslam & Amitabh Bhattacharya • 3:51' }] },
                                },
                              },
                            ],
                            thumbnail: {
                              musicThumbnailRenderer: {
                                thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/w544.jpg' }] },
                              },
                            },
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    },
  },
};

const YT_PLAYER_OK = {
  playabilityStatus: { status: 'OK' },
  streamingData: {
    adaptiveFormats: [
      { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 129703, url: 'https://rr1.example.googlevideo.com/videoplayback?eid=WTLLym2wzIM140' },
    ],
  },
};

const ITUNES_HIT = {
  results: [
    {
      trackId: 9001,
      trackName: 'Tu Chahiye (From "Bajrangi Bhaijaan")',
      artistName: 'Atif Aslam',
      collectionName: 'Hits of Atif Aslam',
      previewUrl: 'https://audio-ssl.itunes.apple.com/preview/9001.m4a',
      artworkUrl100: 'https://is1-ssl.mzstatic.com/image/100x100bb.jpg',
      trackTimeMillis: 231000,
    },
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

const isYtSearch = (u: string) => u.includes('youtubei/v1/search');
const isYtPlayer = (u: string) => u.includes('youtubei/v1/player');
const isSaavnSearch = (u: string) => u.includes('jiosaavn.com') && u.includes('search.getResults');
const isSaavnAc = (u: string) => u.includes('jiosaavn.com') && u.includes('autocomplete');
const isItunes = (u: string) => u.includes('itunes.apple.com');

async function engine() {
  return await import('../../src/api/music');
}

beforeAll(() => {
  resetYtKillSwitch();
  clearYtCaches();
});

beforeEach(() => {
  // each scenario must run on a cold engine (the LRU intentionally
  // serves repeats in production — tests need fresh generations)
  clearSearchCaches();
});

describe('SI1 — "tu chaiye of atif aslam" must find Tu Chahiye', () => {
  test('rescued via YouTube full-length when the ladder can stream it', async () => {
    installFetch([
      (u) => (isSaavnSearch(u) ? { status: 200, json: JUNK_RESULTS } : undefined),
      (u) => (isSaavnAc(u) ? { status: 200, json: { data: {} } } : undefined),
      (u) => (isYtSearch(u) ? { status: 200, json: YTM_BODY } : undefined),
      (u) => (isYtPlayer(u) ? { status: 200, json: YT_PLAYER_OK } : undefined),
      (u) => (isItunes(u) ? { status: 200, json: ITUNES_HIT } : undefined),
    ]);
    const { searchMusicV2 } = await engine();
    const res = await searchMusicV2('tu chaiye of atif aslam');
    expect(res.sigState).toBe('rescued');
    expect(res.tracks.length).toBeGreaterThan(0);
    const top = res.tracks[0];
    expect(top.rescueRung).toBe('youtube');
    expect(top.source).toBe('youtube');
    expect(/tu chahiye/i.test(top.title)).toBe(true);
    expect(/atif/i.test(top.artist)).toBe(true);
    // the wrong-song rows must sit BELOW the rescued target
    const wrongIdx = res.tracks.findIndex((t) => /laila/i.test(t.title));
    if (wrongIdx !== -1) expect(wrongIdx).toBeGreaterThan(0);
  });

  test('rescued via iTunes preview when YouTube cannot stream', async () => {
    installFetch([
      (u) => (isSaavnSearch(u) ? { status: 200, json: JUNK_RESULTS } : undefined),
      (u) => (isSaavnAc(u) ? { status: 200, json: { data: {} } } : undefined),
      (u) => (isYtSearch(u) ? { status: 200, json: { contents: {} } } : undefined), // YT search dead
      (u) => (isItunes(u) ? { status: 200, json: ITUNES_HIT } : undefined),
    ]);
    const { searchMusicV2 } = await engine();
    const res = await searchMusicV2('tu chaiye of atif aslam');
    expect(res.sigState).toBe('rescued');
    expect(res.tracks[0].rescueRung).toBe('itunes');
    expect(res.tracks[0].previewOnly).toBe(true);
    expect(/tu chahiye/i.test(res.tracks[0].title)).toBe(true);
  });

  test('S-PARTIAL with honest labelling when no provider satisfies intent', async () => {
    // YouTube kill-switched (documented datacenter behavior), iTunes has
    // nothing matching — the title-matching rows stay, truthfully labelled.
    const { resetYtKillSwitch: reset } = await import('../../src/api/youtube');
    reset();
    const { noteYtFailure } = await import('../../src/api/youtube');
    noteYtFailure(0);
    noteYtFailure(0);
    noteYtFailure(0); // 3rd → soft-disable
    installFetch([
      (u) => (isSaavnSearch(u) ? { status: 200, json: JUNK_RESULTS } : undefined),
      (u) => (isSaavnAc(u) ? { status: 200, json: { data: {} } } : undefined),
      (u) => (isItunes(u) ? { status: 200, json: { results: [] } } : undefined),
    ]);
    const { searchMusicV2 } = await engine();
    const res = await searchMusicV2('tu chaiye of atif aslam');
    expect(res.sigState).toBe('partial');
    expect(res.tracks.length).toBeGreaterThan(0);
    // the top row must be a TITLE match — never O'Meri Laila
    expect(/tu chah?iye/i.test(res.tracks[0].title)).toBe(true);
    expect(res.tracks[0].reasonCode).not.toBe('MATCHES_SEARCH');
    // partial chips list the distinct title-matching artists
    expect(res.partialArtists?.length).toBeGreaterThan(0);
    expect(res.partialArtists).toContain('A.R. Dixit');
  });
});
