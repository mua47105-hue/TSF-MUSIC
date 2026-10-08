/**
 * v5.0.1 FIX-B4 + FIX-B5 — THE RESOLVED COUNT AND THE CLOCK-PROOF CAP.
 *
 * FIX-B4: every surface that fires a playback toast now reports the
 * RESOLVED count (playQueue's return — rows that actually entered the
 * engine), never the candidate count; zero-resolved is an honest
 * "could not start". Locked against the shipped source text (the
 * wave1-hermes house pattern) on all four surfaces: F14 mood journey,
 * F15 resume, F16 decade radio, F19 genre tap.
 *
 * FIX-B5: stories/bookmarks cap eviction survives a backwards wall
 * clock — the counted-deletion loop never rests at cap+1.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createBookmarks, type Bookmark, type BookmarksStore } from '../src/player/bookmarks';
import { createSongStories, type SongStory, type SongStoriesStore } from '../src/storage/songStories';
import { BOOKMARKS, STORIES } from '../src/ai/core/constants';

describe('FIX-B4 · the toasts report the RESOLVED count', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['F14 mood journey', 'src/screens/MindbeatWireScreen.tsx', /const queued = await playQueue\(res\.tracks, 0\);[\s\S]{0,600}?JOURNEY · \$\{queued\} SONGS/],
    ['F15 resume', 'src/screens/StatsScreen.tsx', /const queued = await playQueue\(mix, 0\);[\s\S]{0,600}?RESUMED · \$\{queued\} SONGS/],
    ['F16 decade radio', 'src/screens/StatsScreen.tsx', /const queued = await playQueue\(res\.tracks, 0\);[\s\S]{0,800}?THE SOUND OF \$\{res\.ladder\.decadeStart\}s · \$\{queued\} SONGS/],
    ['F19 genre tap', 'src/screens/GenreExplorer.tsx', /const queued = await playQueue\(rows, 0\);[\s\S]{0,600}?\$\{bubble\.genre\.toUpperCase\(\)\} · \$\{queued\} SONGS/],
  ];
  for (const [name, file, pattern] of cases) {
    test(`${name}: awaits playQueue and toasts the resolved count`, () => {
      const src = readFileSync(file, 'utf8');
      expect(src).toMatch(pattern);
    });
  }

  test('every surface carries the honest zero-resolved state', () => {
    expect(readFileSync('src/screens/StatsScreen.tsx', 'utf8')).toContain('COULD NOT START PLAYBACK — THE SESSION DID NOT RESOLVE');
    expect(readFileSync('src/screens/StatsScreen.tsx', 'utf8')).toContain('COULD NOT START PLAYBACK — THE DECADE DID NOT RESOLVE');
    expect(readFileSync('src/screens/MindbeatWireScreen.tsx', 'utf8')).toContain('COULD NOT START PLAYBACK — THE JOURNEY DID NOT RESOLVE');
    expect(readFileSync('src/screens/GenreExplorer.tsx', 'utf8')).toContain('— NOTHING RESOLVED');
  });

  test('the old candidate-count toasts are gone from the fixed surfaces', () => {
    const stats = readFileSync('src/screens/StatsScreen.tsx', 'utf8');
    expect(stats).not.toContain('RESUMED · ${mix.length} SONGS');
    expect(stats).not.toContain('THIN CATALOG · ${res.tracks.length} SONGS');
    const wire = readFileSync('src/screens/MindbeatWireScreen.tsx', 'utf8');
    expect(wire).not.toContain('JOURNEY · ${res.tracks.length} SONGS');
    const genre = readFileSync('src/screens/GenreExplorer.tsx', 'utf8');
    expect(genre).not.toContain('${rows.length} SONGS`);');
  });
});

// ── FIX-B5 fixtures (wave2 pattern) ────────────────────────────────────

function storiesFixture(): SongStoriesStore & { rows: Map<string, SongStory> } {
  const rows = new Map<string, SongStory>();
  return {
    rows,
    async getStory(key) { return rows.get(key) ?? null; },
    async upsertStory(story) { rows.set(story.recordingKey, { ...story }); },
    async deleteStory(key) { rows.delete(key); },
    async allStories() { return [...rows.values()]; },
  };
}

function bookmarksFixture(): BookmarksStore & { rows: Map<string, Bookmark> } {
  const rows = new Map<string, Bookmark>();
  return {
    rows,
    async forTrack(recordingKey) { return [...rows.values()].filter((b) => b.recordingKey === recordingKey); },
    async all() { return [...rows.values()]; },
    async put(b) { rows.set(b.id, { ...b }); },
    async del(id) { rows.delete(id); },
  };
}

describe('FIX-B5 · the cap survives a backwards wall clock', () => {
  test('THE ROLLBACK TEST: stories at cap, the clock rolls back, the fresh row is the OLDEST — count rests at cap', async () => {
    const store = storiesFixture();
    const svc = createSongStories(store);
    // fill the cap with rows "written in the future" (clock ahead)…
    for (let i = 0; i < STORIES.cap; i++) {
      await svc.setStory(`key-${i}`, `note ${i}`, 2000 + i);
    }
    expect(store.rows.size).toBe(STORIES.cap);
    // …the clock rolls BACK: the fresh row lands OLDER than the rest.
    await svc.setStory('key-fresh', 'the memory', 1999);
    expect(store.rows.size).toBe(STORIES.cap); // cap, NOT cap+1
    expect(store.rows.has('key-fresh')).toBeTrue(); // the just-saved row is never its own victim
    expect(store.rows.has('key-0')).toBeFalse(); // the next-oldest made room
  });

  test('bookmarks per-track cap: rollback puts the fresh row among the oldest — count rests at cap', async () => {
    const store = bookmarksFixture();
    const svc = createBookmarks(store);
    const key = 'song::artist';
    for (let i = 0; i < BOOKMARKS.perTrackCap; i++) {
      await svc.add(key, (i + 1) * 1000, '', 2000 + i);
    }
    expect((await store.forTrack(key)).length).toBe(BOOKMARKS.perTrackCap);
    await svc.add(key, 99 * 1000, '', 1999); // the backwards-clock row
    expect((await store.forTrack(key)).length).toBe(BOOKMARKS.perTrackCap); // not cap+1
    expect(store.rows.has(`${key}:99`)).toBeTrue();
  });

  test('bookmarks global cap: the same rollback proof across recordings', async () => {
    const store = bookmarksFixture();
    const svc = createBookmarks(store);
    for (let i = 0; i < BOOKMARKS.totalCap; i++) {
      await svc.add(`track-${i}`, 1000, '', 2000 + i);
    }
    expect(store.rows.size).toBe(BOOKMARKS.totalCap);
    await svc.add('track-fresh', 1000, '', 1999);
    expect(store.rows.size).toBe(BOOKMARKS.totalCap); // not cap+1
    expect(store.rows.has('track-fresh:1')).toBeTrue();
  });

  test('the forward clock still evicts FIFO (the normal path is unchanged)', async () => {
    const store = storiesFixture();
    const svc = createSongStories(store);
    for (let i = 0; i < STORIES.cap; i++) await svc.setStory(`key-${i}`, `note ${i}`, 1000 + i);
    await svc.setStory('key-fresh', 'newest', 99999);
    expect(store.rows.size).toBe(STORIES.cap);
    expect(store.rows.has('key-fresh')).toBeTrue();
    expect(store.rows.has('key-0')).toBeFalse(); // the oldest still made room
  });
});
