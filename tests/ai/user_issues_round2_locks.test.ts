/**
 * USER-ISSUES ROUND-2 LOCKS (v4.0.5 "full shelf" gauntlet)
 *
 * Bars these tests pin (user-reported issues, probe-verified root causes):
 *   L-ALBUM-LADDER  — crates/homepage albums must resolve a full
 *                     tracklist even when content.getAlbumDetails returns
 *                     a pre-release stub (empty list / "sample trailer").
 *   L-ARTIST-CAT    — artist pages use the REAL artist page (topSongs +
 *                     dedicated playlists) instead of a capped name-search;
 *                     joined credit strings ("A, B") seed by PRIMARY name.
 *   L-PRIMARY-NAME  — the joined-credits splitter can never search 0 rows
 *                     for "Bibi Babydoll, DJ FKU"-style names again.
 *   L-NO-SOURCE-CHIP— TrackRow renders no source badge (SAAVN chip gone).
 *
 * All provider traffic is intercepted at global fetch — no network.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';

// ── fetch interceptor ───────────────────────────────────────────────────

type CallHandler = (call: string, url: URL) => any | Promise<any>;
let handler: CallHandler | null = null;
const calls: string[] = [];

const realFetch = globalThis.fetch;

function songRow(id: string, title: string, artistName: string, artistId: string, album = 'Test Album', albumId = '90001') {
  return {
    id,
    title,
    more_info: {
      encrypted_media_url: `enc-${id}`,
      duration: '200',
      language: 'hindi',
      album,
      album_id: albumId,
      image: `https://c.saavncdn.com/${id}_150x150.jpg`,
      artistMap: {
        primary_artists: [{ id: artistId, name: artistName, image: '' }],
        featured_artists: [],
      },
    },
  };
}

function installFetch(fn: CallHandler) {
  handler = fn;
  (globalThis as any).fetch = (input: any) => {
    const url = new URL(String(input));
    const call = url.searchParams.get('__call') ?? '';
    calls.push(call);
    return Promise.resolve(new Response(JSON.stringify(fn(call, url)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  };
}

beforeEach(() => {
  calls.length = 0;
  handler = null;
});
afterEach(() => {
  (globalThis as any).fetch = realFetch;
  handler = null;
});

// ── L-ALBUM-LADDER ──────────────────────────────────────────────────────

describe('album ladder (crates albums resolve a full tracklist)', () => {
  test('direct hit: content.getAlbumDetails returns the tracks', async () => {
    const { getAlbumTracks } = await import('../../src/api/saavn');
    installFetch((call) => {
      if (call === 'content.getAlbumDetails') {
        return { list: [songRow('s1', 'Tum Hi Ho', 'Arijit Singh', '459320', 'Aashiqui 2', '1139549'), songRow('s2', 'Sun Raha Hai', 'Arijit Singh', '459320', 'Aashiqui 2', '1139549')] };
      }
      return {};
    });
    const tracks = await getAlbumTracks('1139549', 'Aashiqui 2');
    expect(tracks.length).toBe(2);
    expect(tracks[0]!.title).toBe('Tum Hi Ho');
    expect(calls.filter((c) => c === 'content.getAlbumDetails').length).toBe(1);
  });

  test('trailer placeholder rows are dropped, real rows kept', async () => {
    const { getAlbumTracks } = await import('../../src/api/saavn');
    installFetch((call) => {
      if (call === 'content.getAlbumDetails') {
        return {
          list: [
            { id: 'stub', title: 'This is a sample trailer - testing', more_info: { encrypted_media_url: 'enc-stub' } },
            songRow('s1', 'Real Song', 'A', '1'),
          ],
        };
      }
      return {};
    });
    const tracks = await getAlbumTracks('stub-id', 'Stub');
    expect(tracks.map((t) => t.title)).toEqual(['Real Song']);
  });

  test('stub rescue step 2: album title search finds the real album id', async () => {
    const { getAlbumTracks } = await import('../../src/api/saavn');
    let detailsCalls = 0;
    installFetch((call, url) => {
      if (call === 'content.getAlbumDetails') {
        detailsCalls += 1;
        if (url.searchParams.get('albumid') === '3E8fNHiW') return { list: [] }; // the stub
        return { list: [songRow('real1', 'The Real Song', 'A', '1', 'Real Album', '81197164')] };
      }
      if (call === 'search.getAlbumResults') {
        return { results: [{ id: '81197164', title: 'Real Album' }] };
      }
      return {};
    });
    const tracks = await getAlbumTracks('3E8fNHiW', 'Real Album');
    expect(tracks.length).toBe(1);
    expect(tracks[0]!.albumId).toBe('81197164');
    expect(detailsCalls).toBe(2);
  });

  test('stub rescue step 3: song search matched by album name', async () => {
    const { getAlbumTracks } = await import('../../src/api/saavn');
    installFetch((call) => {
      if (call === 'content.getAlbumDetails') return { list: [] };
      if (call === 'search.getAlbumResults') return { results: [] };
      if (call === 'search.getResults') {
        return {
          results: [
            songRow('m1', 'Song One', 'A', '1', 'Phonk Album', '777'),
            songRow('m2', 'Song Two', 'B', '2', 'Unrelated', '888'),
          ],
        };
      }
      return {};
    });
    const tracks = await getAlbumTracks('stub', 'Phonk Album');
    expect(tracks.map((t) => t.id)).toEqual(['saavn-m1']);
  });

  test('never throws: total provider failure → honest empty list', async () => {
    const { getAlbumTracks } = await import('../../src/api/saavn');
    (globalThis as any).fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    const tracks = await getAlbumTracks('x', 'Anything');
    expect(tracks).toEqual([]);
  });
});

// ── L-PRIMARY-NAME ──────────────────────────────────────────────────────

describe('primaryArtistName (joined credits can no longer dead-end a radio)', () => {
  test('splits commas, feat and ft. chains', async () => {
    const { primaryArtistName } = await import('../../src/api/saavn');
    expect(primaryArtistName('Bibi Babydoll, DJ FKU')).toBe('Bibi Babydoll');
    expect(primaryArtistName('Arijit Singh feat. Someone')).toBe('Arijit Singh');
    expect(primaryArtistName('X ft. Y')).toBe('X');
    expect(primaryArtistName('  Solo  ')).toBe('Solo');
    expect(primaryArtistName('A, B, C')).toBe('A');
  });
});

// ── L-ARTIST-CAT ────────────────────────────────────────────────────────

describe('artist catalog (the real artist page, not a capped search)', () => {
  function installArijit(opts: { withId?: boolean; deepRows?: number } = {}) {
    const withId = opts.withId ?? true;
    const deepRows = opts.deepRows ?? 25;
    const seedRows = Array.from({ length: 6 }, (_, i) => songRow(`seed${i}`, `Seed ${i}`, 'Arijit Singh', '459320'));
    installFetch((call, url) => {
      if (call === 'search.getResults') {
        const q = url.searchParams.get('q') ?? '';
        return {
          results: q === 'Arijit Singh'
            ? seedRows
            : [],
        };
      }
      if (call === 'artist.getArtistPageDetails') {
        return {
          image: 'https://c.saavncdn.com/artists/Arijit_Singh_500x500.jpg',
          topSongs: [songRow('top1', 'Top One', 'Arijit Singh', '459320'), songRow('top2', 'Top Two', 'Arijit Singh', '459320')],
          topAlbums: [
            { id: 'alb1', title: 'Aashiqui 2', image: 'https://c.saavncdn.com/alb1_150x150.jpg', more_info: { song_count: '10' } },
            { id: 'alb2', title: 'Sample Trailer LP', image: 'https://c.saavncdn.com/alb2_150x150.jpg' },
          ],
          dedicated_artist_playlist: [
            { id: 'dp1', title: 'Arijit Singh - Sad Songs' },
            { id: 'dp2', title: 'Arijit Singh - Romance' },
          ],
        };
      }
      if (call === 'playlist.getDetails') {
        const listid = url.searchParams.get('listid');
        const rows = Array.from({ length: deepRows }, (_, i) => songRow(`${listid}-${i}`, `Deep ${listid} ${i}`, 'Arijit Singh', '459320'));
        return { list: rows };
      }
      return {};
    });
    return { withId };
  }

  test('quick list paints topSongs + matched search; albums rail present', async () => {
    const { getArtistCatalog } = await import('../../src/api/saavn');
    installArijit();
    const cat = await getArtistCatalog('Arijit Singh');
    expect(cat.artistId).toBe('459320');
    const ids = cat.tracks.map((t) => t.id);
    expect(ids).toContain('saavn-top1');
    expect(ids).toContain('saavn-seed0');
    expect(cat.albums.length).toBe(2);
    expect(cat.albums[0]!.id).toBe('alb1');
  });

  test('expand() deepens the list and only ever GROWS it', async () => {
    const { getArtistCatalog } = await import('../../src/api/saavn');
    installArijit({ deepRows: 25 });
    const cat = await getArtistCatalog('Arijit Singh');
    const quickLen = cat.tracks.length;
    const deep = await cat.expand();
    expect(deep.length).toBeGreaterThan(quickLen);
    // unique across the merged list
    expect(new Set(deep.map((t) => t.id)).size).toBe(deep.length);
    // expand is idempotent-safe: second call returns [] (no dedicated
    // growth left) — callers can call it freely
    const again = await cat.expand();
    expect(again.length).toBe(0);
  });

  test('joined credit string seeds by PRIMARY name (Bibi radio class)', async () => {
    const { getArtistCatalog } = await import('../../src/api/saavn');
    const searchedQs: string[] = [];
    installFetch((call, url) => {
      if (call === 'search.getResults') {
        const q = url.searchParams.get('q') ?? '';
        searchedQs.push(q);
        if (q === 'Bibi Babydoll') {
          return { results: [songRow('b1', 'Phonk Song', 'Bibi Babydoll', '61001')] };
        }
        return { results: [] };
      }
      if (call === 'artist.getArtistPageDetails') {
        return { topSongs: [songRow('btop', 'Bibi Top', 'Bibi Babydoll', '61001')] };
      }
      return {};
    });
    const cat = await getArtistCatalog('Bibi Babydoll, DJ FKU');
    expect(searchedQs[0]).toBe('Bibi Babydoll'); // NEVER the joined string
    expect(cat.tracks.length).toBeGreaterThanOrEqual(2);
  });

  test('no artist id → honest search fallback (never worse than v4.0.3)', async () => {
    const { getArtistCatalog } = await import('../../src/api/saavn');
    // rows credit the artist WITHOUT an id (the Bibi Babydoll shape) —
    // the provider page can't be resolved, so the search rows ARE the answer
    installFetch((call, url) => {
      if (call === 'search.getResults') {
        const q = url.searchParams.get('q') ?? '';
        if (q === 'Arijit Singh') {
          return {
            results: [
              songRow('f1', 'F One', 'Arijit Singh', ''),
              songRow('f2', 'F Two', 'Arijit Singh', ''),
              songRow('f3', 'F Three', 'Arijit Singh', ''),
            ],
          };
        }
        return { results: [] };
      }
      return {};
    });
    const cat = await getArtistCatalog('Arijit Singh');
    expect(cat.artistId).toBeUndefined();
    expect(cat.tracks.length).toBe(3);
    expect(cat.albums).toEqual([]);
    const deep = await cat.expand();
    expect(deep).toEqual([]);
  });

  test('provider outage → matched seed rows (never throws)', async () => {
    const { getArtistCatalog } = await import('../../src/api/saavn');
    (globalThis as any).fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    const cat = await getArtistCatalog('Arijit Singh');
    expect(cat.tracks).toEqual([]);
    expect(cat.albums).toEqual([]);
  });
});

// ── L-NO-SOURCE-CHIP ────────────────────────────────────────────────────

describe('no source chip anywhere (SAAVN stamp removed)', () => {
  test('TrackRow source file no longer references SourceBadge/showSource', async () => {
    const fs = await import('fs');
    const row = fs.readFileSync('src/components/TrackRow.tsx', 'utf8');
    expect(row.includes('SourceBadge')).toBe(false);
    expect(row.includes('showSource')).toBe(false);
    for (const screen of ['src/screens/HomeScreen.tsx', 'src/screens/SearchScreen.tsx']) {
      expect(fs.readFileSync(screen, 'utf8').includes('showSource')).toBe(false);
    }
  });

  test('webmock parity: new catalog exports exist on both sides', async () => {
    const real = require('../../src/api/saavn');
    const mock = require('../../src/webmocks/saavn');
    for (const name of ['getArtistCatalog', 'primaryArtistName', 'getAlbumTracks']) {
      expect(typeof real[name]).toBe('function');
      expect(typeof mock[name]).toBe('function');
    }
  });
});
