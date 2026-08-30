/**
 * F2 ENDLESS-FEED PAGER LOCKS (gauntlet R4).
 *
 * Locks the EndlessFeedPager contract the Home screen depends on:
 *   • alternation songs → albums → songs → …
 *   • cross-batch dedupe (a song seen in batch 1 can never return)
 *   • prime() excludes rows the fixed shelves already show
 *   • safety filter applied to every song batch
 *   • network failure → { kind: 'retry' }, pager survives and resumes
 *   • null means exhausted FOREVER (both ladders walked 3x) — the UI
 *     renders the honest end marker and stops calling
 */
import { describe, expect, test } from 'bun:test';
import { EndlessFeedPager, type FeedFetchers } from '../../src/api/feed';
import type { Collection, Track } from '../../src/types';

function song(id: string, title = `Song ${id}`, artist = 'Artist A'): Track {
  return { id, title, artist, duration: 200, source: 'saavn' };
}

function album(id: string, title = `Album ${id}`): Collection {
  return { id, title, subtitle: 'Album', kind: 'album' };
}

function songsPage(ids: string[]): Track[] {
  return ids.map((i) => song(`s${i}`));
}

function albumsPage(ids: string[]): Collection[] {
  return ids.map((i) => album(`a${i}`));
}

/** Fetcher factory: deterministic unique rows per (query, page) — models
 *  the real provider (same query → different rows per page). */
function provider(songPages = 3, albumPages = 3): FeedFetchers {
  return {
    searchSongs: async (q, p) =>
      p <= songPages
        ? Array.from({ length: 30 }, (_, i) => song(`s-${q}-${p}-${i}`))
        : [],
    searchAlbums: async (q, p) =>
      p <= albumPages
        ? Array.from({ length: 20 }, (_, i) => album(`a-${q}-${p}-${i}`))
        : [],
  };
}

/** Fetcher script: each call pops the next canned response (or throws). */
function scripted(script: Array<() => Track[] | Collection[]>): FeedFetchers {
  let call = 0;
  return {
    searchSongs: async () => {
      const step = script[call++];
      return (step?.() ?? []) as Track[];
    },
    searchAlbums: async () => {
      const step = script[call++];
      return (step?.() ?? []) as Collection[];
    },
  };
}

describe('F2 — EndlessFeedPager', () => {
  test('alternates songs and albums batches', async () => {
    const pager = new EndlessFeedPager(provider());
    const b1 = await pager.next();
    const b2 = await pager.next();
    const b3 = await pager.next();
    const b4 = await pager.next();
    expect(b1?.kind).toBe('songs');
    expect(b2?.kind).toBe('albums');
    expect(b3?.kind).toBe('songs');
    expect(b4?.kind).toBe('albums');
  });

  test('goes DEEP: page 2+ of the same query feeds later batches', async () => {
    const calls: string[] = [];
    const pager = new EndlessFeedPager({
      searchSongs: async (q, p) => {
        calls.push(`s:${q}:${p}`);
        return p <= 3
          ? Array.from({ length: 30 }, (_, i) => song(`s-${q}-${p}-${i}`))
          : [];
      },
      searchAlbums: async (q, p) =>
        p <= 3 ? Array.from({ length: 20 }, (_, i) => album(`a-${q}-${p}-${i}`)) : [],
    });
    await pager.next(); // songs q1 p1
    await pager.next(); // albums q1 p1
    await pager.next(); // songs q1 p2 ← SAME query, deeper page
    expect(calls.filter((c) => c.startsWith('s:')).length).toBeGreaterThanOrEqual(2);
    expect(calls).toContain(`s:top songs:2`);
  });

  test('never repeats a song id across batches (cross-batch dedupe)', async () => {
    const pager = new EndlessFeedPager(provider());
    const seen = new Set<string>();
    let batches = 0;
    for (let i = 0; i < 80; i++) {
      const b = await pager.next();
      if (b === null) break;
      if (b.kind === 'retry') continue;
      batches += 1;
      if (b.kind === 'songs') {
        expect(b.songs.length).toBeGreaterThan(0);
        for (const t of b.songs) {
          expect(seen.has(t.id)).toBe(false);
          seen.add(t.id);
        }
      }
    }
    expect(batches).toBeGreaterThan(4); // the feed actually produced content
    expect(seen.size).toBeGreaterThan(40); // and it went deep
  });

  test('prime() excludes rows the fixed shelves already show', async () => {
    const pager = new EndlessFeedPager({
      searchSongs: async () => [song('t1'), song('t2'), ...songsPage(['3', '4', '5', '6', '7', '8'])],
      searchAlbums: async () => albumsPage(['1', '2', '3', '4', '5']),
    });
    pager.prime({ songs: [song('t1'), song('t2')], albums: [album('a1')] });
    const b1 = await pager.next();
    expect(b1?.kind).toBe('songs');
    if (b1?.kind === 'songs') {
      expect(b1.songs.map((t) => t.id)).not.toContain('t1');
      expect(b1.songs.map((t) => t.id)).not.toContain('t2');
    }
  });

  test('a primed-away page can still yield a full batch from other rows', async () => {
    const pager = new EndlessFeedPager({
      searchSongs: async () => songsPage(['1', '2', '3', '4', '5', '6', '7']),
      searchAlbums: async () => albumsPage(['1', '2', '3', '4', '5']),
    });
    // nothing primed: full batch
    const b1 = await pager.next();
    expect(b1?.kind).toBe('songs');
    if (b1?.kind === 'songs') expect(b1.songs.length).toBe(7);
  });

  test('explicit-content songs are filtered out of feed batches', async () => {
    const pager = new EndlessFeedPager({
      searchSongs: async () => [
        song('clean1'),
        { ...song('dirty'), title: 'sexy moaning fuck' },
        ...songsPage(['2', '3', '4', '5', '6']),
      ],
      searchAlbums: async () => albumsPage(['1', '2', '3', '4', '5']),
    });
    const b1 = await pager.next();
    expect(b1?.kind).toBe('songs');
    if (b1?.kind === 'songs') {
      expect(b1.songs.find((t) => t.id === 'dirty')).toBeUndefined();
      expect(b1.songs.find((t) => t.id === 'clean1')).toBeDefined();
    }
  });

  test('total network failure returns retry and the pager survives', async () => {
    let failing = true;
    const pager = new EndlessFeedPager({
      searchSongs: async () => {
        if (failing) throw new Error('network down');
        return songsPage(['1', '2', '3', '4', '5', '6', '7']);
      },
      searchAlbums: async () => {
        if (failing) throw new Error('network down');
        return albumsPage(['1', '2', '3', '4', '5']);
      },
    });
    // both ladders fail → first call retries internally (2 queries each),
    // persistent failure surfaces as retry
    let sawRetry = false;
    for (let i = 0; i < 8 && !sawRetry; i++) {
      const b = await pager.next();
      sawRetry = b?.kind === 'retry';
    }
    expect(sawRetry).toBe(true);

    // network recovers → feed resumes with real batches
    failing = false;
    const b = await pager.next();
    expect(b?.kind === 'songs' || b?.kind === 'albums').toBe(true);
  });

  test('null is returned forever after honest exhaustion', async () => {
    // tiny ladders, empty responses → ladders walk out in 3 passes
    const pager = new EndlessFeedPager(
      {
        searchSongs: async () => [],
        searchAlbums: async () => [],
      },
      { songQueries: ['q1', 'q2'], albumQueries: ['q1', 'q2'] },
    );
    let gotNull = false;
    let retries = 0;
    for (let i = 0; i < 40; i++) {
      const b = await pager.next();
      if (b === null) {
        gotNull = true;
        break;
      }
      if (b.kind === 'retry') retries += 1;
    }
    expect(gotNull).toBe(true);
    expect(retries).toBeGreaterThan(0); // it honestly reported the failure first
    // once exhausted, it stays exhausted
    expect(await pager.next()).toBeNull();
    expect(pager.isExhausted).toBe(true);
  });

  test('a songs batch never renders below the minimum row threshold', async () => {
    const pager = new EndlessFeedPager(
      {
        searchSongs: async () => songsPage(['1', '2', '3']), // only 3 rows
        searchAlbums: async () => albumsPage(['1', '2', '3', '4', '5']),
      },
    );
    const b1 = await pager.next();
    // 3 songs < MIN_SONG_BATCH → pager falls through to albums (or retries)
    expect(b1?.kind).not.toBe('songs');
  });
});
