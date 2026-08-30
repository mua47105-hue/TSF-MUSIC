/**
 * GAUNTLET R4 CRITIC-FIX LOCKS.
 *
 * Every finding from the R4 adversarial critic round that could be locked
 * in a unit test is locked here:
 *   • L-P1-1/P2-BURN — network errors never consume the feed ladder's
 *     exhaustion budget (critic P2-2: always-throwing fetchers used to
 *     burn all 84 query-passes and end the feed FOREVER)
 *   • L-PARITY — the web harness mock must export the same surface as the
 *     real saavn module (critic P2-3: searchAlbumResults was missing →
 *     the SIG-rescue album rung threw on web)
 *   • L-P1-2 — mergeUniqueTracks merges from whatever array it is GIVEN
 *     (the SearchScreen keeps a live resultsRef mirror — the locked
 *     property is that a merge from a flagged/reordered array preserves
 *     those flags; this pins the data contract the screen relies on)
 */
import { describe, expect, test } from 'bun:test';
import { EndlessFeedPager } from '../../src/api/feed';
import { mergeUniqueTracks } from '../../src/api/saavn';
import type { Track } from '../../src/types';

function song(id: string): Track {
  return { id, title: `Song ${id}`, artist: 'Artist A', duration: 200, source: 'saavn' };
}

describe('R4 critic locks — feed pager error discipline', () => {
  test('L-BURN: always-throwing fetchers NEVER exhaust the ladder budget', async () => {
    let calls = 0;
    const pager = new EndlessFeedPager({
      searchSongs: async () => {
        calls += 1;
        throw new Error('network down');
      },
      searchAlbums: async () => {
        calls += 1;
        throw new Error('network down');
      },
    });
    // hammer it far beyond the old budget (16+12 queries × 3 passes)
    let retries = 0;
    for (let i = 0; i < 100; i++) {
      const b = await pager.next();
      if (b === null) throw new Error('network errors must not exhaust the pager');
      if (b.kind === 'retry') retries += 1;
    }
    expect(retries).toBeGreaterThan(10); // it kept saying retry honestly
    expect(pager.isExhausted).toBe(false); // and never died
    // each next() burns at most 2 fetches per ladder — nowhere near the
    // old 84-query death spiral
    expect(calls).toBeLessThanOrEqual(100 * 4);
  });

  test('L-BURN-RESUME: after the network recovers the same cursor answers', async () => {
    let down = true;
    const pager = new EndlessFeedPager({
      searchSongs: async () => {
        if (down) throw new Error('down');
        return Array.from({ length: 30 }, (_, i) => song(`s-${i}`));
      },
      searchAlbums: async () => {
        if (down) throw new Error('down');
        return [];
      },
    });
    for (let i = 0; i < 6; i++) await pager.next(); // all retries while down
    down = false;
    const b = await pager.next();
    expect(b?.kind).toBe('songs'); // page 1 of query 1 — never skipped
    if (b?.kind === 'songs') expect(b.songs.length).toBe(14);
  });

  test('L-DRY-STILL-EXHAUSTS: genuinely dry (empty, not error) ladders end honestly', async () => {
    const pager = new EndlessFeedPager(
      {
        searchSongs: async () => [],
        searchAlbums: async () => [],
      },
      { songQueries: ['q1', 'q2'], albumQueries: ['q1', 'q2'] },
    );
    let sawNull = false;
    for (let i = 0; i < 40 && !sawNull; i++) {
      const b = await pager.next();
      sawNull = b === null;
    }
    expect(sawNull).toBe(true);
    expect(pager.isExhausted).toBe(true);
  });
});

describe('R4 critic locks — webmock export parity', () => {
  test('L-PARITY: webmocks/saavn exports every public name the real module does', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const real = require('../../src/api/saavn');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mock = require('../../src/webmocks/saavn');
    const missing = Object.keys(real).filter((k) => !(k in mock));
    expect(missing).toEqual([]);
  });
});

describe('R4 critic locks — merge preserves row identity (P1-2 contract)', () => {
  test('L-MERGE-FLAGS: merging from the CURRENT array preserves mutations made in place', () => {
    // the screen's live mirror: rows flagged + reordered by lyric
    // verification (new array objects) then a page appended
    const current = [
      { ...song('b'), lyricMatch: true },
      { ...song('a'), lyricMatch: true },
      song('c'),
    ];
    const appended = mergeUniqueTracks(current, [song('d'), song('a')]);
    expect(appended.map((t) => t.id)).toEqual(['b', 'a', 'c', 'd']);
    expect((appended[0] as any).lyricMatch).toBe(true);
    expect((appended[1] as any).lyricMatch).toBe(true);
  });
});
