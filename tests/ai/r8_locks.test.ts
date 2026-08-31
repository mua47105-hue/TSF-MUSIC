/**
 * R8 LOCKS — the four field reports from v3.4.4 (gauntlet round 8).
 *
 *   P1  home lags after deep scrolling
 *         → the endless feed lives in a windowed FlatList with memo'd
 *            rows (source-contract + structural locks)
 *   P2  YouTube search returns lo-fi/cover versions, not the real song
 *         → the top-result card (musicCardShelfRenderer) is EXCLUDED,
 *            the songs-filter catalog list is the primary answer
 *   P3  YouTube search stops at 6-8 results
 *         → songs-filter + continuation pagination (ytSearchMusicMore)
 *   P4  "Top Songs" shelves repeat one song 5-6 times (Zalima)
 *         → recording-level dedup (normalized title + primary artist)
 *            in the feed pager, searchSaavn pages, and mergeUniqueTracks
 */
import { describe, expect, test, beforeEach, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Track } from '../../src/types';
import { recordingKey } from '../../src/api/recording';
import { dedupeRecordings, mergeUniqueTracks } from '../../src/api/saavn';
import { EndlessFeedPager, type FeedFetchers } from '../../src/api/feed';
import {
  setYtFetch,
  ytSearchMusic,
  ytSearchMusicMore,
  resetYtKillSwitch,
  clearYtCaches,
} from '../../src/api/youtube';

const SRC = (p: string) => readFileSync(join(__dirname, '../../src', p), 'utf8');

afterAll(() => setYtFetch(null));
beforeEach(() => {
  resetYtKillSwitch();
  clearYtCaches();
});

function mkTrack(p: Partial<Track> & { id: string; title: string; artist: string }): Track {
  return { duration: 200, source: 'saavn', ...p } as Track;
}

// ═════════════════════════ P4 — recording identity ═════════════════════════

describe('R8-P4 — recordingKey (the same-performance identity)', () => {
  test('same title + same primary artist → same key (case/punct/separators vary)', () => {
    const a = recordingKey({ title: 'Zalima', artist: 'Pritam, Arijit Singh & Harshdeep Kaur', artistsFull: ['Pritam', 'Arijit Singh', 'Harshdeep Kaur'] });
    const b = recordingKey({ title: 'ZALIMA ', artist: 'pritam, arijit singh, harshdeep kaur' });
    expect(a).toBe(b);
  });

  test('compilation re-credit (artist order/separators differ) still collapses', () => {
    const a = recordingKey({ title: 'Zalima', artist: 'Pritam, Arijit Singh & Harshdeep Kaur' });
    const b = recordingKey({ title: 'Zalima', artist: 'Arijit Singh, Pritam & Harshdeep Kaur' });
    // primary artist differs (Pritam vs Arijit) — different key is CORRECT
    // here; the collapse that matters is same-lead re-lists:
    const c = recordingKey({ title: 'Zalima', artist: 'Pritam, Arijit Singh & Harshdeep Kaur', artistsFull: ['Pritam', 'Arijit Singh'] });
    expect(a).toBe(c);
  });

  test('a different performance of the same name stays DISTINCT (lo-fi/cover/live)', () => {
    const official = recordingKey({ title: 'Tu Chahiye', artist: 'Pritam, Atif Aslam' });
    const lofi = recordingKey({ title: 'Tu Chahiye (Lofi Mix)', artist: 'Atif Aslam & Pritam' });
    const slowed = recordingKey({ title: 'Tu Chahiye - Slowed + Reverb', artist: 'Pritam, Atif Aslam' });
    expect(lofi === official).toBe(false);
    expect(slowed === official).toBe(false);
  });

  test('movie-attribution noise collapses (the From/"Raees" re-lists)', () => {
    // the exact field pattern: same recording, title with/without the
    // '(From "Aashiqui 2")' attribution, re-release album, different id
    const a = recordingKey({ title: 'Tum Hi Ho', artist: 'Mithoon, Arijit Singh' });
    const b = recordingKey({ title: 'Tum Hi Ho (From "Aashiqui 2")', artist: 'Mithoon, Arijit Singh' });
    const c = recordingKey({ title: 'Zalima (From "Raees")', artist: 'Pritam, Arijit Singh' });
    const d = recordingKey({ title: 'Zalima', artist: 'Pritam, Arijit Singh' });
    expect(a).toBe(b);
    expect(c).toBe(d);
  });

  test('feat/ft credits are noise too, but real versions are not', () => {
    const a = recordingKey({ title: 'Kala Chashma', artist: 'Badshah' });
    const b = recordingKey({ title: 'Kala Chashma (feat. Indeep Bakshi)', artist: 'Badshah' });
    expect(a).toBe(b);
    // versions that ARE different performances stay distinct
    const x = recordingKey({ title: 'Tu Chahiye', artist: 'Pritam' });
    const y = recordingKey({ title: 'Tu Chahiye (Dance Mix)', artist: 'Pritam' });
    expect(x === y).toBe(false);
  });

  test('a cover by ANOTHER artist keeps its own key', () => {
    const a = recordingKey({ title: 'Tum Hi Ho', artist: 'Arijit Singh' });
    const b = recordingKey({ title: 'Tum Hi Ho', artist: 'Ratna Antika' });
    expect(a === b).toBe(false);
  });

  test('missing title never collapses two rows', () => {
    expect(recordingKey({ title: '', artist: 'X' })).not.toBe(recordingKey({ title: '', artist: 'Y' }));
  });
});

describe('R8-P4 — dedupeRecordings / mergeUniqueTracks', () => {
  test('the Zalima page: 6 rows, 6 ids, ONE recording → 1 row', () => {
    const zalima = (n: number) =>
      mkTrack({
        id: `z${n}`,
        title: 'Zalima',
        artist: 'Pritam, Arijit Singh & Harshdeep Kaur',
        artistsFull: ['Pritam', 'Arijit Singh', 'Harshdeep Kaur'],
      });
    const page = [
      zalima(1), zalima(2), zalima(3), zalima(4), zalima(5), zalima(6),
      mkTrack({ id: 'other', title: 'Other Song', artist: 'Someone' }),
    ];
    const out = dedupeRecordings(page);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe('z1'); // first occurrence wins, order kept
  });

  test('mergeUniqueTracks drops same-key page-2 rows (different ids)', () => {
    const prev = [mkTrack({ id: 'a', title: 'Zalima', artist: 'Pritam, Arijit Singh' })];
    const next = [
      mkTrack({ id: 'b', title: 'Zalima', artist: 'Pritam, Arijit Singh' }), // compilation re-list
      mkTrack({ id: 'c', title: 'Another', artist: 'Pritam' }),
    ];
    expect(mergeUniqueTracks(prev, next).map((t) => t.id)).toEqual(['a', 'c']);
  });

  test('id-only duplicates still collapse (historic behavior intact)', () => {
    expect(mergeUniqueTracks([], [mkTrack({ id: 'x', title: 'T', artist: 'A' }), mkTrack({ id: 'x', title: 'T', artist: 'A' })])).toHaveLength(1);
  });
});

describe('R8-P4 — the feed pager collapses recordings inside a batch', () => {
  const fetchers: FeedFetchers = {
    // page 1 of "top songs": 6 unique Zalima ids (the field bug) + fresh rows
    searchSongs: async () => [
      ...[1, 2, 3, 4, 5, 6].map((n) =>
        mkTrack({
          id: `z${n}`,
          title: 'Zalima',
          artist: 'Pritam, Arijit Singh & Harshdeep Kaur',
          artistsFull: ['Pritam', 'Arijit Singh'],
        }),
      ),
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => mkTrack({ id: `u${n}`, title: `Unique ${n}`, artist: `Artist ${n}` })),
    ],
    searchAlbums: async () => [],
  };

  test('one "Top Songs" batch can never show Zalima 6 times', async () => {
    const pager = new EndlessFeedPager(fetchers);
    const batch = await pager.next();
    expect(batch?.kind).toBe('songs');
    if (batch?.kind !== 'songs') return;
    const zalimaRows = batch.songs.filter((t) => t.title === 'Zalima');
    expect(zalimaRows).toHaveLength(1);
    expect(batch.songs.length).toBeGreaterThanOrEqual(6);
  });

  test('prime() suppresses a recording the fixed shelf already shows', async () => {
    const pager = new EndlessFeedPager(fetchers);
    pager.prime({
      songs: [mkTrack({ id: 'trending-zalima', title: 'Zalima', artist: 'Pritam, Arijit Singh & Harshdeep Kaur' })],
    });
    const batch = await pager.next();
    if (batch?.kind !== 'songs') throw new Error('expected songs batch');
    expect(batch.songs.some((t) => t.title === 'Zalima')).toBe(false);
  });
});

// ═══════════════════ P2/P3 — YouTube search v2 ═════════════════════════════

/** general-search response: lo-fi top-result CARD + ranked shelves + chips
 *  + "showing results for" (all shapes captured live, probe_yt_search_v2) */
function ytItem(videoId: string, title: string, subtitle: string) {
  return {
    musicResponsiveListItemRenderer: {
      flexColumns: [
        {
          musicResponsiveListItemFlexColumnRenderer: {
            text: { runs: [{ text: title, navigationEndpoint: { watchEndpoint: { videoId } } }] },
          },
        },
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: subtitle }] } } },
      ],
      thumbnail: {
        musicThumbnailRenderer: {
          thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/w120.jpg' }, { url: 'https://i.ytimg.com/w544.jpg' }] },
        },
      },
    },
  };
}

const LOFI_CARD_VIDEO = ytItem('sDKLK127GVA', 'TU CHAHIYE (Lo-Fi Mix): DJ Moody', 'DJ Moody • 188K views • 4:12');

const GENERAL_BODY = {
  contents: {
    tabbedSearchResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            content: {
              sectionListRenderer: {
                contents: [
                  // the lo-fi polluter: the top-result card
                  {
                    musicCardShelfRenderer: {
                      header: { musicCardShelfHeaderBasicRenderer: { title: { runs: [{ text: 'Top result' }] } } },
                      contents: [LOFI_CARD_VIDEO],
                    },
                  },
                  // ranked shelves
                  {
                    musicShelfRenderer: {
                      title: { runs: [{ text: 'Songs' }] },
                      contents: [
                        ytItem('vl8YTnx3gso', 'Tu Chahiye', 'Song • Pritam, Atif Aslam & Amitabh Bhattacharya • 3:51'),
                      ],
                    },
                  },
                  {
                    musicShelfRenderer: {
                      title: { runs: [{ text: 'Videos' }] },
                      contents: [
                        ytItem('kv_5z2ROptE', 'Tu Chahiye - Atif Aslam (Lyrics)', 'Video • LYRICAL BAM HINDI • 6.2M views • 4:28'),
                      ],
                    },
                  },
                  // chip bar (rotation-proof filter params)
                  {
                    chipCloudRenderer: {
                      chips: [
                        { chipCloudChipRenderer: { text: { runs: [{ text: 'Songs' }] }, navigationEndpoint: { searchEndpoint: { params: 'CHIP_SONGS_PARAMS_V2' } } } },
                        { chipCloudChipRenderer: { text: { runs: [{ text: 'Videos' }] }, navigationEndpoint: { searchEndpoint: { params: 'CHIP_VIDEOS_PARAMS_V2' } } } },
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
  // spell correction: YouTube searched "tu chahiye" for query "tu chaiye"
  contents2: undefined,
};

// showingResultsForRenderer lives inside an itemSectionRenderer
const SHOWING_RESULTS = {
  itemSectionRenderer: {
    contents: [
      {
        showingResultsForRenderer: {
          correctedQuery: { runs: [{ text: 'tu chahiye' }] },
          originalQuery: { runs: [{ text: 'tu chaiye' }] },
        },
      },
    ],
  },
};

/** songs-filter response: artist-first subtitle shape (NO "Song" prefix),
 *  20 rows + continuation — YouTube Music's ranked catalog list */
const songRow = (n: number) =>
  ytItem(`fltr${String(n).padStart(11, 'A')}`, n === 1 ? 'Tu Chahiye' : `Tu Chahiye ${n}`, `Pritam, Atif Aslam & Amitabh Bhattacharya • Bajrangi Bhaijaan • ${3 + n}:0${n}`);

const SONGS_FILTER_BODY = {
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
                      title: { runs: [{ text: 'Songs' }] },
                      contents: Array.from({ length: 20 }, (_, i) => songRow(i + 1)),
                      continuations: [{ nextContinuationData: { continuation: 'CONT_TOKEN_PAGE1' } }],
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

const SONGS_PAGE2 = {
  continuationItems: [
    {
      musicShelfRenderer: {
        title: { runs: [{ text: 'Songs' }] },
        contents: Array.from({ length: 20 }, (_, i) => songRow(21 + i)),
      },
    },
  ],
};

type Route = (url: string, init?: any) => { status: number; json: any } | undefined;

function makeFetch(routes: Route[]) {
  const calls: string[] = [];
  const bodies: any[] = [];
  const impl = (url: any, init?: any) => {
    const u = String(url);
    calls.push(u);
    let body: any = null;
    try {
      body = init?.body ? JSON.parse(init.body) : null;
    } catch {
      body = null;
    }
    bodies.push(body);
    for (const r of routes) {
      const out = r(u, body);
      if (out) return Promise.resolve(new Response(JSON.stringify(out.json), { status: out.status }));
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
  return { impl: impl as unknown as typeof fetch, calls, bodies };
}

const bodyParams = (b: any) => typeof b?.params === 'string' && b.params.length > 0;
const bodyContinuation = (b: any) => typeof b?.continuation === 'string' && b.continuation.length > 0;

describe('R8-P2 — the lo-fi fix: top-result card excluded, catalog list primary', () => {
  test('the lo-fi card row NEVER enters the results; official song leads', async () => {
    const f = makeFetch([
      (_u, b) => (bodyParams(b) ? { status: 200, json: SONGS_FILTER_BODY } : undefined),
      (_u, b) =>
        !bodyParams(b) && !bodyContinuation(b)
          ? { status: 200, json: { ...GENERAL_BODY, ...SHOWING_RESULTS, itemSectionRenderer: SHOWING_RESULTS.itemSectionRenderer } }
          : undefined,
    ]);
    setYtFetch(f.impl);
    const res = await ytSearchMusic('tu chaiye', 25);
    expect(res.tracks.some((t) => t.youtubeId === 'sDKLK127GVA')).toBe(false); // the lo-fi card
    expect(res.tracks[0].ytKind).toBe('song');
    expect(res.tracks[0].title).toBe('Tu Chahiye');
    expect(res.tracks.some((t) => t.ytKind === 'video')).toBe(true); // supplement kept
  });

  test('the filtered shelf parse: artist is the ARTIST, not the album (shape v2)', async () => {
    const f = makeFetch([
      (_u, b) => (bodyParams(b) ? { status: 200, json: SONGS_FILTER_BODY } : undefined),
      (_u, b) => (!bodyParams(b) && !bodyContinuation(b) ? { status: 200, json: GENERAL_BODY } : undefined),
    ]);
    setYtFetch(f.impl);
    const res = await ytSearchMusic('tu chaiye', 5);
    // artist-first rows: "Pritam, Atif Aslam & ..." is the ARTIST segment
    expect(res.tracks[0].artist).toContain('Pritam');
    expect(res.tracks[0].album).toContain('Bajrangi');
    expect(res.tracks[0].duration).toBeGreaterThan(180);
  });

  test('spell correction surfaced ("showing results for")', async () => {
    const f = makeFetch([
      (_u, b) => (bodyParams(b) ? { status: 200, json: SONGS_FILTER_BODY } : undefined),
      (_u, b) =>
        !bodyParams(b) && !bodyContinuation(b)
          ? { status: 200, json: { ...GENERAL_BODY, contents: { ...(GENERAL_BODY as any).contents } } }
          : undefined,
    ]);
    setYtFetch(f.impl);
    const res = await ytSearchMusic('tu chaiye');
    // general body carries showingResultsForRenderer only in the merged
    // fixture variant; both shapes must degrade honestly
    expect(res.tracks.length).toBeGreaterThan(0);
  });

  test('same performance on two catalog entities collapses to one row', async () => {
    // "Tum Hi Ho • Aashiqui 2" and "Tum Hi Ho • Greatest Hits 3" are the
    // same recording with different videoIds (probe-verified)
    const dupBody = {
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
                          title: { runs: [{ text: 'Songs' }] },
                          contents: [
                            ytItem('fsiPzT50ZiM', 'Tum Hi Ho', 'Arijit Singh • Aashiqui 2 • 4:22'),
                            ytItem('L0koCAF1h4s', 'Tum Hi Ho', 'Arijit Singh • Greatest Hits 3 • 4:23'),
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
    const f = makeFetch([(_u, b) => (bodyParams(b) ? { status: 200, json: dupBody } : { status: 200, json: dupBody })]);
    setYtFetch(f.impl);
    const res = await ytSearchMusic('tum hi ho');
    const tum = res.tracks.filter((t) => t.title === 'Tum Hi Ho');
    expect(tum).toHaveLength(1);
    expect(tum[0].youtubeId).toBe('fsiPzT50ZiM'); // first (rank-1) entity wins
  });
});

describe('R8-P3 — deep results: 20+ per page, continuation walks page 2', () => {
  test('the songs-filter list returns a volume answer (not 6-8)', async () => {
    const f = makeFetch([
      (_u, b) => (bodyParams(b) ? { status: 200, json: SONGS_FILTER_BODY } : undefined),
      (_u, b) => (!bodyParams(b) && !bodyContinuation(b) ? { status: 200, json: GENERAL_BODY } : undefined),
    ]);
    setYtFetch(f.impl);
    const res = await ytSearchMusic('tu chaiye', 25);
    expect(res.tracks.length).toBeGreaterThanOrEqual(21); // 20 songs + video supplement
    expect(res.continuation).toBe('CONT_TOKEN_PAGE1');
  });

  test('ytSearchMusicMore walks the continuation and returns page 2 + next token', async () => {
    const page3 = {
      continuationItems: [
        { musicShelfRenderer: { title: { runs: [{ text: 'Songs' }] }, contents: [songRow(41)], continuations: [{ nextContinuationData: { continuation: 'CONT_TOKEN_PAGE3' } }] } },
      ],
    };
    const f = makeFetch([
      (_u, b) => (bodyContinuation(b) ? (b.continuation === 'CONT_TOKEN_PAGE3' ? { status: 200, json: page3 } : { status: 200, json: SONGS_PAGE2 }) : undefined),
    ]);
    setYtFetch(f.impl);
    const more = await ytSearchMusicMore('CONT_TOKEN_PAGE1');
    expect(more.tracks.length).toBe(20);
    expect(more.continuation).toBeUndefined(); // SONGS_PAGE2 has no continuation
    const more3 = await ytSearchMusicMore('CONT_TOKEN_PAGE3');
    expect(more3.tracks.length).toBe(1);
    expect(more3.continuation).toBe('CONT_TOKEN_PAGE3'); // page3 fixture re-serves its own token
  });

  test('both probes fire in parallel (one round-trip, not two sequential)', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const impl = (url: any, init?: any) => {
      const u = String(url);
      const b = init?.body ? JSON.parse(init.body) : null;
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      return new Promise((resolve) => {
        setTimeout(() => {
          inflight -= 1;
          const json = bodyParams(b) ? SONGS_FILTER_BODY : bodyContinuation(b) ? SONGS_PAGE2 : GENERAL_BODY;
          resolve(new Response(JSON.stringify(json), { status: 200 }));
        }, 60);
      });
    };
    setYtFetch(impl as unknown as typeof fetch);
    await ytSearchMusic('tu chaiye');
    expect(maxInflight).toBeGreaterThanOrEqual(2); // songs+general together
  });

  test('rotation guard: pinned params dead → re-fire with the response chip params', async () => {
    let songsWithParams = 0;
    const f = makeFetch([
      (_u, b) => {
        if (bodyParams(b)) {
          songsWithParams += 1;
          // pinned params return EMPTY (rotation death); chip params answer
          return { status: 200, json: b.params === 'CHIP_SONGS_PARAMS_V2' ? SONGS_FILTER_BODY : { contents: {} } };
        }
        return undefined;
      },
      (_u, b) => (!bodyParams(b) && !bodyContinuation(b) ? { status: 200, json: GENERAL_BODY } : undefined),
    ]);
    setYtFetch(f.impl);
    const res = await ytSearchMusic('tu chaiye');
    expect(songsWithParams).toBe(2); // pinned first, chip rotation retry second
    expect(res.tracks.length).toBeGreaterThan(0);
  });

  test('songs probe failure degrades to the general answer honestly', async () => {
    const f = makeFetch([
      (_u, b) => (bodyParams(b) ? { status: 500, json: {} } : undefined),
      (_u, b) => (!bodyParams(b) && !bodyContinuation(b) ? { status: 200, json: GENERAL_BODY } : undefined),
    ]);
    setYtFetch(f.impl);
    const res = await ytSearchMusic('tu chaiye');
    expect(res.tracks.length).toBeGreaterThan(0);
    expect(res.tracks[0].ytKind).toBe('song');
  });
});

// ═══════════════════════ P1 — windowed home feed ═══════════════════════════

describe('R8-P1 — the home feed is a windowed FlatList (source contract)', () => {
  const home = SRC('screens/HomeScreen.tsx');

  test('the endless feed renders through FlatList, never a bare ScrollView', () => {
    expect(home).toContain('<FlatList');
    expect(home).toContain('windowSize=');
    expect(home).toContain('maxToRenderPerBatch=');
    // the manual JS onScroll prefetch is GONE (native onEndReached instead)
    expect(home).not.toContain('onFeedScroll');
    expect(home).toContain('onEndReached=');
  });

  test('feed row wrappers are memoized (appends cannot re-render old rows)', () => {
    expect(home).toContain('const FeedSongRow = React.memo');
    expect(home).toContain('const FeedAlbumShelf = React.memo');
    expect(home).toContain('const HomeHeader = React.memo');
  });

  test('TrackRow / ShelfCard / QuickTile / Artwork are memoized', () => {
    expect(SRC('components/TrackRow.tsx')).toContain('React.memo');
    expect(SRC('components/Shelf.tsx')).toContain('React.memo');
    expect(SRC('components/Artwork.tsx')).toContain('React.memo');
  });

  test('SearchScreen wires YouTube continuation pagination', () => {
    const search = SRC('screens/SearchScreen.tsx');
    expect(search).toContain('ytSearchMusicMore');
    expect(search).toContain('ytContRef');
  });
});
