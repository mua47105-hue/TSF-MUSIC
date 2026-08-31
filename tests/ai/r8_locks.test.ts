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
 *         + P4b: re-ordered/truncated CREDIT re-lists collapse by
 *            nested credit-set reconciliation (live-probed residual gap)
 */
import { describe, expect, test, beforeEach, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Track } from '../../src/types';
import { recordingKey, reconcileRecordings } from '../../src/api/recording';
import { dedupeRecordings, mergeUniqueTracks, getTrending } from '../../src/api/saavn';
import { EndlessFeedPager, type FeedFetchers } from '../../src/api/feed';
import { YtAppendController, type YtAppendPage } from '../../src/search/ytAppend';
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

// ═══════════════ P4b — credit-order reconciliation (residual gap) ═══════════
// Live ground truth: JioSaavn re-lists the same recording with a
// RE-ORDERED or TRUNCATED credit list — "Tum Hi Ho | Arijit Singh,
// Mithoon" vs "Tum Hi Ho | Mithoon, Arijit Singh" carry different
// primary-artist keys, so key-dedup alone still showed one song twice.

describe('R8-P4b — reconcileRecordings (nested credit sets)', () => {
  test('the credit-order flip collapses (live: Tum Hi Ho x2 in Top Songs)', () => {
    const out = reconcileRecordings([
      mkTrack({ id: 'a', title: 'Tum Hi Ho (From "Aashiqui 2")', artist: 'Arijit Singh, Mithoon', artistsFull: ['Arijit Singh', 'Mithoon'] }),
      mkTrack({ id: 'b', title: 'Tum Hi Ho (From "Aashiqui 2")', artist: 'Mithoon, Arijit Singh', artistsFull: ['Mithoon', 'Arijit Singh'] }),
    ]);
    expect(out.map((t) => t.id)).toEqual(['a']);
  });

  test('the truncated re-credit collapses (live: Labon Ko)', () => {
    const out = reconcileRecordings([
      mkTrack({ id: 'a', title: 'Labon Ko', artist: 'KK, Pritam, Sayeed Quadri', artistsFull: ['KK', 'Pritam', 'Sayeed Quadri'] }),
      mkTrack({ id: 'b', title: 'Labon Ko', artist: 'Pritam, KK', artistsFull: ['Pritam', 'KK'] }),
    ]);
    expect(out.map((t) => t.id)).toEqual(['a']);
  });

  test('play-count twins collapse (the lyricist-first fuller-credit re-list, live: Humnava Mere)', () => {
    // JioSaavn re-lists one recording with the lyricist-first FULL credit
    // list vs the plain singer credit — the singleton guard blocks the
    // credit collapse (correctly), but both rows carry the SAME global
    // play counter (live probe: 137,044,726 vs 137,044,723)
    const out = reconcileRecordings([
      mkTrack({ id: 'a', title: 'Humnava Mere', artist: 'Manoj Muntashir, Rocky-Shiv, Jubin Nautiyal', artistsFull: ['Manoj Muntashir', 'Rocky-Shiv', 'Jubin Nautiyal'], playCount: 137044726 }),
      mkTrack({ id: 'b', title: 'Humnava Mere', artist: 'Jubin Nautiyal', artistsFull: ['Jubin Nautiyal'], playCount: 137044723 }),
    ]);
    expect(out.map((t) => t.id)).toEqual(['a']);
  });

  test('a guard-blocked pair with DIFFERENT counters stays (twins need Δ ≤ 1000)', () => {
    // same Humnava shape, but the second row is a genuinely different
    // performance (a cover): credits nest, the singleton guard blocks,
    // and the play counters sit millions apart — no twin
    const out = reconcileRecordings([
      mkTrack({ id: 'a', title: 'Humnava Mere', artist: 'Manoj Muntashir, Rocky-Shiv, Jubin Nautiyal', artistsFull: ['Manoj Muntashir', 'Rocky-Shiv', 'Jubin Nautiyal'], playCount: 137044726 }),
      mkTrack({ id: 'b', title: 'Humnava Mere', artist: 'Jubin Nautiyal', artistsFull: ['Jubin Nautiyal'], playCount: 502311 }),
    ]);
    expect(out).toHaveLength(2);
  });

  test('SMALL counters never twin (two obscure same-titled songs, round-3 NEW-6)', () => {
    // 943 vs 1200 plays — within the raw Δ, but small counters are
    // noise, not identity: both rows must stay
    const out = reconcileRecordings([
      mkTrack({ id: 'a', title: 'Trending', artist: 'Manoj Muntashir, Rocky-Shiv, Jubin Nautiyal', artistsFull: ['Manoj Muntashir', 'Rocky-Shiv', 'Jubin Nautiyal'], playCount: 1200 }),
      mkTrack({ id: 'b', title: 'Trending', artist: 'Jubin Nautiyal', artistsFull: ['Jubin Nautiyal'], playCount: 943 }),
    ]);
    expect(out).toHaveLength(2);
  });

  test('rows without play counts fall back to the credit rules alone', () => {
    const out = reconcileRecordings([
      mkTrack({ id: 'a', title: 'Humnava Mere', artist: 'Manoj Muntashir, Rocky-Shiv, Jubin Nautiyal' }),
      mkTrack({ id: 'b', title: 'Humnava Mere', artist: 'Jubin Nautiyal' }),
    ]);
    expect(out).toHaveLength(2); // no counters → the conservative guard wins
  });

  test('genuinely different songs with the same title SURVIVE (disjoint credits)', () => {
    const out = reconcileRecordings([
      mkTrack({ id: 'a', title: 'Tum Se Hi', artist: 'Pritam, Mohit Chauhan', artistsFull: ['Pritam', 'Mohit Chauhan'] }),
      mkTrack({ id: 'b', title: 'Tum Se Hi', artist: 'Ankit Tiwari, Leena Bose', artistsFull: ['Ankit Tiwari', 'Leena Bose'] }),
      mkTrack({ id: 'c', title: 'Wajah Tum Ho', artist: 'Armaan Malik' }),
      mkTrack({ id: 'd', title: 'Wajah Tum Ho', artist: 'Mithoon, Altamash Faridi, Tulsi Kumar', artistsFull: ['Mithoon', 'Altamash Faridi', 'Tulsi Kumar'] }),
    ]);
    expect(out).toHaveLength(4);
  });

  test('version words still protect the distinct performances', () => {
    const out = reconcileRecordings([
      mkTrack({ id: 'a', title: 'Kesariya', artist: 'Arijit Singh', artistsFull: ['Arijit Singh'] }),
      mkTrack({ id: 'b', title: 'Kesariya (Lofi Flip)', artist: 'VIBIE, Arijit Singh, Pritam' }),
    ]);
    expect(out).toHaveLength(2);
  });

  test('empty-credit rows never collapse on credits alone', () => {
    const out = reconcileRecordings([
      mkTrack({ id: 'a', title: 'Trending', artist: '' }),
      mkTrack({ id: 'b', title: 'Trending', artist: '' }),
    ]);
    expect(out).toHaveLength(2);
  });

  test('titleless rows pass through untouched (key pass owns them)', () => {
    const out = reconcileRecordings([
      mkTrack({ id: 'a', title: '', artist: 'X' }),
      mkTrack({ id: 'b', title: '', artist: 'X' }),
    ]);
    expect(out).toHaveLength(2);
  });

  test('idempotent: reconciling its own output changes nothing', () => {
    const rows = [
      mkTrack({ id: 'a', title: 'Tum Hi Ho', artist: 'Arijit Singh, Mithoon', artistsFull: ['Arijit Singh', 'Mithoon'] }),
      mkTrack({ id: 'b', title: 'Tum Hi Ho', artist: 'Mithoon, Arijit Singh', artistsFull: ['Mithoon', 'Arijit Singh'] }),
      mkTrack({ id: 'c', title: 'Other', artist: 'Arijit Singh' }),
    ];
    const once = reconcileRecordings(rows);
    expect(reconcileRecordings(once)).toEqual(once);
  });
});

describe('R8-P4b — dedupeRecordings / mergeUniqueTracks absorb re-credits', () => {
  test('dedupeRecordings collapses the flipped-credit row (end-to-end)', () => {
    const out = dedupeRecordings([
      mkTrack({ id: 'a', title: 'Gehra Hua (From "Dhurandhar")', artist: 'Shashwat Sachdev, Arijit Singh, Irshad Kamil, Armaan Khan' }),
      mkTrack({ id: 'b', title: 'Gehra Hua (From "Dhurandhar")', artist: 'Irshad Kamil, Arijit Singh, Shashwat Sachdev, Armaan Khan' }),
      mkTrack({ id: 'c', title: 'Apna Bana Le', artist: 'Amitabh Bhattacharya, Sachin-Jigar, Arijit Singh' }),
      mkTrack({ id: 'd', title: 'Apna Bana Le', artist: 'Sachin-Jigar, Arijit Singh' }),
    ]);
    expect(out.map((t) => t.id)).toEqual(['a', 'c']);
  });

  test('mergeUniqueTracks drops a page-2 row that only re-orders the credits', () => {
    const prev = [mkTrack({ id: 'a', title: 'Tum Hi Ho', artist: 'Arijit Singh, Mithoon', artistsFull: ['Arijit Singh', 'Mithoon'] })];
    const next = [
      mkTrack({ id: 'b', title: 'Tum Hi Ho', artist: 'Mithoon, Arijit Singh', artistsFull: ['Mithoon', 'Arijit Singh'] }),
      mkTrack({ id: 'c', title: 'Zara Sa', artist: 'KK, Pritam' }),
    ];
    expect(mergeUniqueTracks(prev, next).map((t) => t.id)).toEqual(['a', 'c']);
  });
});

describe('R8-P4b — the feed pager suppresses re-credited re-lists across batches', () => {
  const fetchers: FeedFetchers = {
    // page 1 shows the song; page 2 re-lists it with flipped credits
    searchSongs: async (_q: string, page: number) =>
      page === 1
        ? [
            mkTrack({ id: 'thh1', title: 'Tum Hi Ho', artist: 'Arijit Singh, Mithoon', artistsFull: ['Arijit Singh', 'Mithoon'] }),
            ...[1, 2, 3, 4, 5, 6, 7].map((n) => mkTrack({ id: `u${n}`, title: `Unique ${n}`, artist: `Artist ${n}` })),
          ]
        : page === 2
          ? [
              mkTrack({ id: 'thh2', title: 'Tum Hi Ho', artist: 'Mithoon, Arijit Singh', artistsFull: ['Mithoon', 'Arijit Singh'] }),
              ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => mkTrack({ id: `v${n}`, title: `Deeper ${n}`, artist: `Performer ${n}` })),
            ]
          : [],
    searchAlbums: async () => [],
  };

  test('a page-2 row that only flips the credit order never renders', async () => {
    const pager = new EndlessFeedPager(fetchers);
    const seen: Track[] = [];
    for (let i = 0; i < 6; i++) {
      const batch = await pager.next();
      if (!batch || batch.kind !== 'songs') continue;
      seen.push(...batch.songs);
    }
    expect(seen.filter((t) => t.title === 'Tum Hi Ho').map((t) => t.id)).toEqual(['thh1']);
  });

  test('prime() bucket: a flipped-credit feed row is suppressed by the fixed shelf', async () => {
    const pager = new EndlessFeedPager({
      ...fetchers,
      searchSongs: async () => [
        mkTrack({ id: 'feed-thh', title: 'Tum Hi Ho', artist: 'Mithoon, Arijit Singh', artistsFull: ['Mithoon', 'Arijit Singh'] }),
        ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => mkTrack({ id: `u${n}`, title: `Unique ${n}`, artist: `Artist ${n}` })),
      ],
    });
    pager.prime({
      songs: [mkTrack({ id: 'shelf-thh', title: 'Tum Hi Ho (From "Aashiqui 2")', artist: 'Arijit Singh, Mithoon', artistsFull: ['Arijit Singh', 'Mithoon'] })],
    });
    const batch = await pager.next();
    if (batch?.kind !== 'songs') throw new Error('expected songs batch');
    expect(batch.songs.some((t) => t.id === 'feed-thh')).toBe(false);
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

  test('SearchScreen eager top-up: a short first page walks page 2 unprompted (the BIG list)', () => {
    const search = SRC('screens/SearchScreen.tsx');
    // the silent single-flighted append shared by scroll + top-up
    expect(search).toContain('appendYtPage');
    // the top-up trigger: continuation present AND first page < 20 rows
    expect(search).toContain('ytr.tracks.length < 20');
    // single-flight guard: scroll + top-up can never double-fetch
    expect(search).toContain('ytAppendRef.current');
  });
});

// ═══════════ P4b/P3 — behavioral locks (critic P1-2: no greps-only) ══════════

describe('R8-P4b behavioral — ytSearchMusic reconcile wiring (setYtFetch)', () => {
  /** artist-first filtered rows with NESTED credit lists (the reconcile
   *  pass is the ONLY thing that can collapse these — keys differ). */
  const nestedCreditsBody = (rows: [string, string, string][]) => ({
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
                        contents: rows.map(([vid, title, subtitle]) => ytItem(vid, title, subtitle)),
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
  });

  test('two catalog entities with NESTED credits collapse to one row (reconcile is wired)', async () => {
    // kept row keys "kesariya|arijitsingh", fresh row keys "kesariya|pritam"
    // (composer-first credit) — DIFFERENT keys, so only the credit-set
    // reconciliation can collapse the pair; the 2-artist subset also
    // stays clear of the singleton guard. (Round-2 critic: the previous
    // fixture led with the same primary in both rows — the KEY pass
    // already dropped it and the lock proved nothing.)
    const body = nestedCreditsBody([
      ['kesariyaA11', 'Kesariya', 'Arijit Singh, Pritam • Brahmastra • 4:29'],
      ['kesariyaB22', 'Kesariya', 'Pritam, Arijit Singh, Amitabh Bhattacharya • Brahmastra (Original Motion Picture Soundtrack) • 4:31'],
    ]);
    const f = makeFetch([(_u, _b) => ({ status: 200, json: body })]);
    setYtFetch(f.impl);
    const res = await ytSearchMusic('kesariya');
    const k = res.tracks.filter((t) => t.title === 'Kesariya');
    expect(k).toHaveLength(1);
    expect(k[0].youtubeId).toBe('kesariyaA11'); // rank-1 entity wins
  });

  test('the featured artist\'s own same-titled track SURVIVES (singleton guard, live-probed adversarial)', async () => {
    // "Kar Gayi Chull (feat. Badshah)" by Fazilpuria vs a solo
    // "Kar Gayi Chull" by Badshah — feat is title noise (same bucket),
    // but Badshah is only a SECONDARY credit of the first row
    const body = nestedCreditsBody([
      ['chullA11111', 'Kar Gayi Chull (feat. Badshah)', 'Fazilpuria, Badshah • Kapoor & Sons • 2:52'],
      ['chullB22222', 'Kar Gayi Chull', 'Badshah • Singles • 2:51'],
    ]);
    const f = makeFetch([(_u, _b) => ({ status: 200, json: body })]);
    setYtFetch(f.impl);
    const res = await ytSearchMusic('kar gayi chull');
    expect(res.tracks.filter((t) => /chull/i.test(t.title))).toHaveLength(2);
  });

  test('ytSearchMusicMore marks TRANSPORT failure with error (token stays retryable — gauntlet P1-1)', async () => {
    const impl = ((_url: any, init?: any) => {
      let body: any = null;
      try {
        body = init?.body ? JSON.parse(init.body) : null;
      } catch {
        body = null;
      }
      if (bodyContinuation(body)) return Promise.reject(new Error('network down'));
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;
    setYtFetch(impl);
    const more = await ytSearchMusicMore('CONT_TOKEN_PAGE1');
    expect(more.error).toBe(true);
    expect(more.tracks).toHaveLength(0);
    // no continuation reported — the CALLER keeps its token and retries
    expect(more.continuation).toBeUndefined();
  });
});

describe('R8-P4b behavioral — getTrending gates on POST-dedup rows', () => {
  /** minimal JioSaavn song row (mapSaavnSong needs id + encrypted url +
   *  artistMap for the credit set). */
  const saavnRow = (id: string, title: string, artists: string[]) => ({
    id,
    title,
    more_info: {
      encrypted_media_url: `ENC_${id}`,
      artistMap: {
        primary_artists: artists.map((name) => ({ name })),
        featured_artists: [],
      },
    },
  });

  const PRISTINE = globalThis.fetch;
  afterAll(() => {
    globalThis.fetch = PRISTINE;
  });

  test('a degenerate chart (5 re-lists + 1) is SKIPPED, not rendered as a 2-row shelf', async () => {
    const chart1 = {
      id: 'c1',
      title: 'Degenerate chart',
      image: 'https://img.example/x.jpg',
      count: 6,
      more_info: { firstname: 'JioSaavn' },
    };
    const chart2 = {
      id: 'c2',
      title: 'Good chart',
      image: 'https://img.example/y.jpg',
      count: 7,
      more_info: { firstname: 'JioSaavn' },
    };
    globalThis.fetch = (async (url: any) => {
      const u = String(url);
      if (u.includes('__call=content.getCharts')) {
        return new Response(JSON.stringify([chart1, chart2]), { status: 200 });
      }
      if (u.includes('__call=playlist.getDetails')) {
        const list = u.includes('listid=c1')
          ? [ // 5 re-lists of one recording + 1 distinct → dedupes to 2 (< gate)
              saavnRow('d1', 'Zalima', ['Pritam', 'Arijit Singh']),
              saavnRow('d2', 'Zalima', ['Pritam', 'Arijit Singh']),
              saavnRow('d3', 'Zalima', ['Pritam', 'Arijit Singh']),
              saavnRow('d4', 'Zalima', ['Arijit Singh', 'Pritam']),
              saavnRow('d5', 'Zalima', ['Arijit Singh', 'Pritam', 'Harshdeep Kaur']),
              saavnRow('d6', 'One Real Song', ['Some Artist']),
            ]
          : [ // healthy chart: 6 distinct + 1 re-list → dedupes to 7… 6 distinct + 1 = 7 ≥ gate
              saavnRow('g1', 'Song One', ['Artist One']),
              saavnRow('g2', 'Song Two', ['Artist Two']),
              saavnRow('g3', 'Song Three', ['Artist Three']),
              saavnRow('g4', 'Song Four', ['Artist Four']),
              saavnRow('g5', 'Song Five', ['Artist Five']),
              saavnRow('g6', 'Zalima', ['Pritam', 'Arijit Singh']),
              saavnRow('g7', 'Zalima', ['Arijit Singh', 'Pritam']), // re-list — collapses
            ];
        return new Response(JSON.stringify({ list }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const trending = await getTrending(14);
    // chart1 was skipped (would have been a 2-row shelf pre-gate-fix);
    // chart2 answers with 6 rows, ONE Zalima
    expect(trending).toHaveLength(6);
    expect(trending.filter((t) => t.title === 'Zalima')).toHaveLength(1);
    expect(trending.every((t) => !t.id.startsWith('saavn-d'))).toBe(true);
  });
});

// ═════════════ R8-P3 — YtAppendController (behavioral, round-2 NEW-9) ════════

describe('R8-P3 behavioral — YtAppendController state machine', () => {
  interface Harness {
    ctrl: YtAppendController;
    fetches: string[];
    cont: string | null;
    rows: Track[];
    state: { hasMore: boolean; endNote: string | null };
    busy: boolean[];
    gen: { current: number };
  }

  function makeHarness(
    page: (cont: string) => Promise<YtAppendPage>,
    opts?: { initialCont?: string | null; gen?: number },
  ): Harness {
    const h: Harness = {
      fetches: [],
      cont: opts?.initialCont ?? 'CONT_1',
      rows: [mkTrack({ id: 'r1', title: 'Row One', artist: 'A' })],
      state: { hasMore: true, endNote: null },
      busy: [],
      gen: { current: opts?.gen ?? 1 },
    };
    h.ctrl = new YtAppendController({
      fetchMore: async (cont) => {
        h.fetches.push(cont);
        return page(cont);
      },
      getCont: () => h.cont,
      setCont: (c) => {
        h.cont = c;
      },
      getRows: () => h.rows,
      publishRows: (rows) => {
        h.rows = rows;
      },
      publishState: (s) => {
        h.state = s;
      },
      isCurrentGen: (gen) => gen === h.gen.current,
      getSignal: () => undefined,
      setBusy: (b) => h.busy.push(b),
    });
    return h;
  }

  const pageTrack = (n: number) => mkTrack({ id: `p${n}`, title: `Page Track ${n}`, artist: `Artist ${n}` });

  test('single-flight: concurrent scroll + eager top-up produce ONE fetch', async () => {
    let release: (() => void) | undefined;
    const h = makeHarness(() =>
      new Promise<YtAppendPage>((res) => {
        release = () => res({ tracks: [pageTrack(1)], continuation: 'CONT_2' });
      }),
    );
    const p1 = h.ctrl.append(1);
    const p2 = h.ctrl.append(1, { silent: true }); // the eager top-up racing the scroll
    release!();
    await Promise.all([p1, p2]);
    expect(h.fetches).toHaveLength(1);
    expect(h.rows).toHaveLength(2); // base + one page merged ONCE
  });

  test('a productive append advances the token, merges, clears the stale note', async () => {
    const h = makeHarness(async () => ({ tracks: [pageTrack(2)], continuation: 'CONT_2' }));
    h.state = { hasMore: true, endNote: "Couldn't load more — check your connection" }; // stale error note
    await h.ctrl.append(1);
    expect(h.cont).toBe('CONT_2');
    expect(h.rows.map((t) => t.id)).toEqual(['r1', 'p2']);
    expect(h.state).toEqual({ hasMore: true, endNote: null }); // round-2 NEW-10
  });

  test('end of catalog is honest (no token → hasMore false + end note)', async () => {
    const h = makeHarness(async () => ({ tracks: [pageTrack(3)] })); // no continuation
    await h.ctrl.append(1);
    expect(h.cont).toBeNull();
    expect(h.state.hasMore).toBe(false);
    expect(h.state.endNote).toBe("That's everything YouTube found");
  });

  test('transport failure KEEPS the token and stays retryable (gauntlet P1-1)', async () => {
    let fail = true;
    const h = makeHarness(async () =>
      fail ? { tracks: [], error: true } : { tracks: [pageTrack(4)], continuation: 'CONT_2' },
    );
    await h.ctrl.append(1);
    expect(h.cont).toBe('CONT_1'); // token survived
    expect(h.state.hasMore).toBe(true); // retry on next scroll
    expect(h.state.endNote).toBe("Couldn't load more — check your connection");
    // the retry succeeds → rows merge, note clears
    fail = false;
    await h.ctrl.append(1);
    expect(h.rows.map((t) => t.id)).toEqual(['r1', 'p4']);
    expect(h.state.endNote).toBeNull();
  });

  test('a stale generation publishes NOTHING (late page for a left query)', async () => {
    const h = makeHarness(async () => ({ tracks: [pageTrack(5)], continuation: 'CONT_2' }));
    const p = h.ctrl.append(1);
    h.gen.current = 2; // user typed a new query while the page was in flight
    await p;
    expect(h.rows).toHaveLength(1); // base only
    expect(h.cont).toBe('CONT_1'); // token untouched
    expect(h.state).toEqual({ hasMore: true, endNote: null }); // state untouched
  });

  test('the busy spinner runs only on non-silent appends', async () => {
    const h1 = makeHarness(async () => ({ tracks: [pageTrack(6)] }));
    await h1.ctrl.append(1);
    expect(h1.busy).toEqual([true, false]);
    const h2 = makeHarness(async () => ({ tracks: [pageTrack(7)] }));
    await h2.ctrl.append(1, { silent: true });
    expect(h2.busy).toEqual([]);
  });

  test('a NEW generation never queues behind a doomed one (round-3 NEW-7)', async () => {
    let releaseGen1: (() => void) | undefined;
    let calls = 0;
    const h = makeHarness(() => {
      calls += 1;
      if (calls === 1) {
        // the gen-1 walk's fetch — hangs until released
        return new Promise<YtAppendPage>((res) => {
          releaseGen1 = () => res({ tracks: [pageTrack(8)], continuation: 'CONT_X' });
        });
      }
      // the gen-2 walk's fetch — resolves immediately
      return Promise.resolve({ tracks: [pageTrack(9)], continuation: 'CONT_3' });
    });
    const doomed = h.ctrl.append(1); // gen-1 walk, hanging
    h.gen.current = 2; // the user typed a new query
    await h.ctrl.append(2, { silent: true }); // fires IMMEDIATELY, not queued
    expect(h.cont).toBe('CONT_3'); // gen-2's walk completed
    expect(h.rows.map((t) => t.id)).toEqual(['r1', 'p9']); // only gen-2's page merged
    releaseGen1!();
    await doomed; // gen-1 lands late — stale-swallowed
    expect(h.rows.map((t) => t.id)).toEqual(['r1', 'p9']); // unchanged
    expect(h.cont).toBe('CONT_3'); // token untouched by the late gen-1 walk
  });
});
