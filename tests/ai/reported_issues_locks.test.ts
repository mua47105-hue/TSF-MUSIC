/**
 * REPORTED ISSUES LOCKS — v4.0.4 (the user's six reported problems).
 *
 * P-A  album songs not playing  → pre-release stub ladder in getAlbumTracks
 * P-B  "SAAVN" chip on rows     → sourceBadgeLabel returns null for saavn
 * P-C  YouTube section hangs    → InnerTube ceiling (ytSignal, 8s)
 * P-D  artist pages thin        → getArtistCatalog (topSongs + dedicated +
 *                                 matched search + real albums)
 * P-E/F playlists & charts      → saavnGet timeout + one honest retry
 *
 * Every lock mocks globalThis.fetch at the URL seam (established pattern).
 */
import { describe, test, expect, afterAll } from 'bun:test';
import {
  saavnGet,
  getAlbumTracks,
  getArtistCatalog,
  type ArtistCatalog,
} from '../../src/api/saavn';
import { sourceBadgeLabel } from '../../src/components/sourceBadge';

const PRISTINE_FETCH = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = PRISTINE_FETCH;
});

const ENC = 'ZmFrZWVuY3J5cHRlZA=='; // base64-ish — mapSaavnSong only needs presence

/** A JioSaavn-shaped raw song row with encrypted_media_url. */
function saavnRow(id: string, title: string, artists: string[], extra: Record<string, any> = {}) {
  return {
    id,
    title,
    more_info: {
      encrypted_media_url: ENC,
      '320kbps': 'true',
      duration: '200',
      language: 'hindi',
      album_id: extra.album_id,
      album: extra.album,
      artistMap: {
        primary_artists: artists.map((name) => ({ name, id: extra.artistIds?.[name] })),
        featured_artists: [],
      },
      ...(extra.more_info ?? {}),
    },
    ...(extra.top ?? {}),
  };
}

/** Install a fetch router: first matching handler wins; `once` handlers
 *  remove themselves after firing (for sequential same-endpoint replies). */
type Handler = (u: URL) => object | undefined | null;
function installFetch(handlers: Handler[]) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(typeof input === 'string' ? input : input.url));
    calls.push(`${url.pathname}${url.search}`);
    for (const h of handlers) {
      const body = h(url);
      if (body !== undefined && body !== null) {
        return new Response(JSON.stringify(body), { status: 200 });
      }
    }
    return new Response('{"__unrouted": true}', { status: 200 });
  }) as typeof fetch;
  return calls;
}

const call = (u: URL) => u.searchParams.get('__call') ?? '';
const param = (u: URL, k: string) => u.searchParams.get(k) ?? '';

// ── P-B: the SAAVN chip is gone ──────────────────────────────────────────

describe('v4.0.4 P-B — trending rows no longer stamp SAAVN on every row', () => {
  test('saavn rows render NO chip; informational sources keep theirs', () => {
    expect(sourceBadgeLabel('saavn')).toBeNull();
    expect(sourceBadgeLabel(undefined)).toBeNull();
    expect(sourceBadgeLabel('youtube')).toBe('YT');
    expect(sourceBadgeLabel('itunes')).toBe('PREVIEW');
    expect(sourceBadgeLabel('local')).toBe('SAVED');
  });
});

// ── P-E/F: saavnGet timeout + one honest retry ──────────────────────────

describe('v4.0.4 P-E/F — saavnGet has a ceiling and one honest retry', () => {
  test('a network blip is retried once and the shelf still loads', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    }) as typeof fetch;
    const data = await saavnGet({ __call: 'content.getCharts' });
    expect(data.ok).toBe(1);
    expect(attempts).toBe(2);
  });

  test('a 5xx blip is retried once; 4xx fails immediately', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return attempts === 1
        ? new Response('boom', { status: 503 })
        : new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    }) as typeof fetch;
    const data = await saavnGet({ __call: 'x' });
    expect(data.ok).toBe(1);
    expect(attempts).toBe(2);

    attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return new Response('nope', { status: 404 });
    }) as typeof fetch;
    await expect(saavnGet({ __call: 'x' })).rejects.toThrow('saavn 404');
    expect(attempts).toBe(1);
  });

  test('a hung fetch dies at the ceiling (both attempts), not forever', async () => {
    let attempts = 0;
    globalThis.fetch = (async (_url: any, init?: any) => {
      attempts += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error(init.signal.reason?.message ?? 'aborted')),
        );
      });
    }) as typeof fetch;
    const t0 = Date.now();
    await expect(
      saavnGet({ __call: 'content.getCharts' }, undefined, 25),
    ).rejects.toThrow('saavn: timeout');
    const elapsed = Date.now() - t0;
    expect(attempts).toBe(2); // ceiling fired twice, then the honest throw
    expect(elapsed).toBeLessThan(2000); // 2 × 25ms + overhead — NOT 2 × 10s
  });

  test('a caller abort is respected — no retry after the user navigated away', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    }) as typeof fetch;
    const ctl = new AbortController();
    ctl.abort();
    await expect(saavnGet({ __call: 'x' }, ctl.signal)).rejects.toThrow('aborted');
    expect(attempts).toBe(0);
  });
});

// ── P-A: the pre-release stub album ladder ──────────────────────────────

describe('v4.0.4 P-A — album pages survive the pre-release stub trap', () => {
  test('a healthy album resolves from getAlbumDetails with NO fallback calls', async () => {
    const calls = installFetch([
      (u) =>
        call(u) === 'content.getAlbumDetails'
          ? {
              id: 'alb1',
              title: 'Normal Album',
              list: [
                saavnRow('s1', 'Song One', ['Arijit Singh'], { album_id: 'alb1', album: 'Normal Album' }),
                saavnRow('s2', 'Song Two', ['Arijit Singh'], { album_id: 'alb1', album: 'Normal Album' }),
              ],
            }
          : undefined,
    ]);
    const tracks = await getAlbumTracks('alb1', 'Normal Album');
    expect(tracks).toHaveLength(2);
    expect(calls.filter((c) => c.includes('search.getAlbumResults'))).toHaveLength(0);
  });

  test('a pre-release stub (trailer placeholder) climbs to search and plays', async () => {
    const calls = installFetch([
      // the stub id answers with the literal placeholder row the probe found
      (u) =>
        call(u) === 'content.getAlbumDetails' && param(u, 'albumid') === 'stub1'
          ? {
              id: 'stub1',
              title: 'Bhootni Ka (From "Udta Teer")',
              list: [{ id: 'dsf7m88e', title: 'This is a sample trailer - testing', more_info: { '320kbps': 'false' } }],
            }
          : undefined,
      // the ladder asks album search for the real press
      (u) =>
        call(u) === 'search.getAlbumResults'
          ? {
              results: [
                { id: 'stub1', title: 'Bhootni Ka (From "Udta Teer")' }, // same id — skipped
                { id: 'real9', title: 'Bhootni Ka (From "Udta Teer")' }, // the real press
              ],
            }
          : undefined,
      // getAlbumDetails on the REAL id returns the playable row
      (u) =>
        call(u) === 'content.getAlbumDetails' && param(u, 'albumid') === 'real9'
          ? {
              id: 'real9',
              title: 'Bhootni Ka (From "Udta Teer")',
              list: [saavnRow('s9', 'Bhootni Ka', ['Arijit Singh'], { album_id: 'real9', album: 'Bhootni Ka' })],
            }
          : undefined,
    ]);
    const tracks = await getAlbumTracks('stub1', 'Bhootni Ka (From "Udta Teer")');
    expect(tracks).toHaveLength(1);
    expect(tracks[0].title).toBe('Bhootni Ka');
    expect(tracks[0].saavnId).toBe('s9');
    expect(calls.some((c) => c.includes('search.getAlbumResults'))).toBe(true);
  });

  test('a stub with no album-search hit falls back to song search by album name', async () => {
    installFetch([
      (u) =>
        call(u) === 'content.getAlbumDetails'
          ? { list: [] } // stub: nothing
          : undefined,
      (u) =>
        call(u) === 'search.getAlbumResults'
          ? { results: [] } // nothing to claw back there
          : undefined,
      (u) =>
        call(u) === 'search.getResults'
          ? {
              results: [
                saavnRow('x1', 'Afsaana Banaaya Aapne', ['Stebin Ben'], {
                  album_id: 'other9', // different id — but album NAME matches
                  album: 'Afsaana Banaaya Aapne (From "Gunmaaster G9")',
                }),
                saavnRow('x2', 'Unrelated Song', ['Someone'], { album_id: 'zz', album: 'Random' }),
              ],
            }
          : undefined,
    ]);
    const tracks = await getAlbumTracks('stub2', 'Afsaana Banaaya Aapne (From "Gunmaaster G9")');
    expect(tracks).toHaveLength(1);
    expect(tracks[0].saavnId).toBe('x1');
  });
});

// ── P-D: the real artist catalog ─────────────────────────────────────────

describe('v4.0.4 P-D — artist pages carry the REAL catalog', () => {
  test('topSongs first, dedicated playlist merged, search rows appended, albums mapped', async () => {
    const artistRow = (id: string, title: string) =>
      saavnRow(id, title, ['Arijit Singh'], { artistIds: { 'Arijit Singh': '459320' } });
    installFetch([
      // seed search (n=40): two artist rows + one unrelated
      (u) =>
        call(u) === 'search.getResults' && param(u, 'n') === '40'
          ? {
              results: [
                artistRow('seed1', 'Seed Song One'),
                artistRow('seed2', 'Seed Song Two'),
                saavnRow('noise1', 'Other Person Song', ['Neha Kakkar']),
              ],
            }
          : undefined,
      // artist-id resolution (n=10)
      (u) =>
        call(u) === 'search.getResults' && param(u, 'n') === '10'
          ? {
              results: [
                {
                  id: 'r1',
                  title: 'Tum Hi Ho',
                  more_info: {
                    artistMap: { primary_artists: [{ name: 'Arijit Singh', id: '459320' }] },
                  },
                },
              ],
            }
          : undefined,
      // the artist page itself
      (u) =>
        call(u) === 'artist.getArtistPageDetails'
          ? {
              artistId: '459320',
              name: 'Arijit Singh',
              topSongs: [artistRow('top1', 'Tum Hi Ho'), artistRow('top2', 'Channa Mereya')],
              topAlbums: [
                {
                  id: 'aashiqui',
                  title: 'Aashiqui 2',
                  image: 'https://c.saavncdn.com/x_150x150.jpg',
                  more_info: { song_count: '10' },
                },
              ],
              dedicated_artist_playlist: [
                { id: 'pl77', title: 'Arijit Singh - Sad Songs', subtitle: '25 Songs' },
              ],
            }
          : undefined,
      // the dedicated editorial playlist
      (u) =>
        call(u) === 'playlist.getDetails'
          ? {
              list: [
                artistRow('top1', 'Tum Hi Ho'), // same recording as topSongs[0] — dedupes
                artistRow('ded1', 'Deep Catalog Ballad'),
              ],
            }
          : undefined,
    ]);
    const cat: ArtistCatalog = await getArtistCatalog('Arijit Singh');
    expect(cat.artistId).toBe('459320');
    const ids = cat.tracks.map((t) => t.saavnId);
    // provider truth first, then the deep catalog, then search-only rows
    expect(ids[0]).toBe('top1');
    expect(ids).toContain('top2');
    expect(ids).toContain('ded1');
    expect(ids).toContain('seed1');
    // the duplicated recording appears exactly once
    expect(ids.filter((i) => i === 'top1')).toHaveLength(1);
    // the unrelated artist's row is filtered out (needle match)
    expect(ids).not.toContain('noise1');
    // the album card is real, 500x500, and countable
    expect(cat.albums).toHaveLength(1);
    expect(cat.albums[0].id).toBe('aashiqui');
    expect(cat.albums[0].artwork).toContain('500x500');
    expect(cat.albums[0].trackCount).toBe(10);
  });

  test('an artist with no resolvable id degrades to the v4.0.3 search behavior', async () => {
    installFetch([
      (u) =>
        call(u) === 'search.getResults'
          ? {
              results: [
                saavnRow('s1', 'Mystery Song', ['Unknown Artist'], {
                  more_info: { artistMap: { primary_artists: [{ name: 'Someone Else', id: '99' }] } },
                }),
              ],
            }
          : undefined,
    ]);
    const cat = await getArtistCatalog('Totally Obscure Name');
    expect(cat.artistId).toBeUndefined();
    expect(cat.albums).toHaveLength(0);
    expect(cat.tracks.length).toBeGreaterThan(0);
  });
});
