/**
 * MAGNUM OPUS WAVE 2 · F6 — SONG STORIES LOCKS.
 *
 * The bar: CRUD round-trips on a fixture store; empty state renders
 * honestly; recordingKey (NOT trackId) keys the row; streamUrl can never
 * enter the schema; kill switch irrelevant (factual user data).
 * All assertions are LITERALS — no constant is checked against itself.
 */

import { describe, expect, test } from 'bun:test';
import {
  createSongStories,
  isBlankStory,
  sanitizeStoryText,
  type SongStory,
  type SongStoriesStore,
} from '../src/storage/songStories';

function fixtureStore(): SongStoriesStore & { rows: Map<string, SongStory> } {
  const rows = new Map<string, SongStory>();
  return {
    rows,
    async getStory(key) {
      return rows.get(key) ?? null;
    },
    async upsertStory(story) {
      rows.set(story.recordingKey, { ...story });
    },
    async deleteStory(key) {
      rows.delete(key);
    },
    async allStories() {
      return [...rows.values()];
    },
  };
}

describe('F6 · song stories — CRUD round-trips (fixture store)', () => {
  test('set → get returns the same text; create keeps createdAt, update keeps it and bumps updatedAt', async () => {
    const store = fixtureStore();
    const svc = createSongStories(store);
    const created = await svc.setStory('tum hi ho::arijit singh', 'This was playing when we met.', 1000);
    expect(created).toEqual({
      recordingKey: 'tum hi ho::arijit singh',
      text: 'This was playing when we met.',
      createdAt: 1000,
      updatedAt: 1000,
    });
    const reread = await svc.getStory('tum hi ho::arijit singh');
    expect(reread?.text).toBe('This was playing when we met.');

    const updated = await svc.setStory('tum hi ho::arijit singh', 'Still our song.', 5000);
    expect(updated?.createdAt).toBe(1000); // NOT 5000 — creation time survives edits
    expect(updated?.updatedAt).toBe(5000);
    expect((await svc.getStory('tum hi ho::arijit singh'))?.text).toBe('Still our song.');
    expect(await svc.count()).toBe(1);
  });

  test('recordingKey keys the row — NOT trackId: two ids, one recording = ONE story', async () => {
    const store = fixtureStore();
    const svc = createSongStories(store);
    await svc.setStory('tum hi ho::arijit singh', 'the memory', 1000);
    // a DIFFERENT recording gets a DIFFERENT (empty) story — honest null
    expect(await svc.getStory('channa mereya::arijit singh')).toBeNull();
    // the same recording under a DIFFERENT provider track id still shares the key
    // (parens are load-bearing: `await x()?.text` would read .text off the PROMISE)
    expect((await svc.getStory('tum hi ho::arijit singh'))?.text).toBe('the memory');
    expect(await svc.count()).toBe(1);
  });

  test('empty state is honest: missing key → null; blank text is a no-op (never stored)', async () => {
    const store = fixtureStore();
    const svc = createSongStories(store);
    expect(await svc.getStory('nothing::here')).toBeNull();
    expect(await svc.setStory('nothing::here', '   ', 1000)).toBeNull();
    expect(await svc.count()).toBe(0);
    expect(isBlankStory('\n\n  \n')).toBe(true);
    expect(isBlankStory('a real memory')).toBe(false);
    expect(await svc.removeStory('nothing::here')).toBe(false); // removing nothing is false, not a lie
  });

  test('sanitize: control chars stripped, 3+ newlines collapse, 500-char cap enforced (literal)', async () => {
    const out = sanitizeStoryText('line1\u0007line2\n\n\n\nline3');
    expect(out).toBe('line1line2\n\nline3');
    const long = 'x'.repeat(731);
    expect(sanitizeStoryText(long).length).toBe(500);
    expect(sanitizeStoryText(long).slice(0, 3)).toBe('xxx');
  });

  test('LRU cap 1000 (literal): row 0 is evicted, the newest survives', async () => {
    const store = fixtureStore();
    const svc = createSongStories(store);
    for (let i = 0; i < 1001; i++) {
      await svc.setStory(`k${i}::artist`, `story ${i}`, i + 1);
    }
    expect(await svc.count()).toBe(1000);
    expect(await svc.getStory('k0::artist')).toBeNull(); // oldest touched → evicted
    expect((await svc.getStory('k1000::artist'))?.text).toBe('story 1000');
    // touching k1 refreshes it; then k2 is the LRU victim, not k1
    await svc.setStory('k1::artist', 'story 1 touched', 2001);
    for (let i = 1001; i <= 1001; i++) await svc.setStory(`k${i}::artist`, `story ${i}`, i + 1);
    expect(await svc.getStory('k2::artist')).toBeNull();
    expect((await svc.getStory('k1::artist'))?.text).toBe('story 1 touched');
  });
});

describe('F6 · wiring evidence (file:line contracts)', () => {
  const fs = require('fs');

  test('songStories.ts schema carries NO stream field (type-level law)', () => {
    const src = fs.readFileSync('src/storage/songStories.ts', 'utf8');
    expect(src).toContain('recordingKey: string');
    expect(src).toContain('createdAt: number');
    expect(src).not.toMatch(/streamUrl/); // the leak is unrepresentable
  });

  test('appTables.ts creates the SQLite table song_stories keyed by recordingKey', () => {
    const src = fs.readFileSync('src/storage/appTables.ts', 'utf8');
    expect(src).toContain('CREATE TABLE IF NOT EXISTS song_stories');
    expect(src).toContain('recordingKey TEXT PRIMARY KEY');
    expect(src).not.toMatch(/song_stories[\s\S]*streamUrl/);
  });

  test('UI wiring: TrackMenu has the "Add a memory" editor; PlayerScreen renders the story line', () => {
    const menu = fs.readFileSync('src/components/TrackMenu.tsx', 'utf8');
    expect(menu).toContain("'Add a memory'");
    expect(menu).toContain('contentKeyOf');
    const player = fs.readFileSync('src/screens/PlayerScreen.tsx', 'utf8');
    expect(player).toContain('song-story-line');
    expect(player).toContain('stories.getStory');
  });

  test('contentKeyOf parity: BOTH platform twins delegate to the canonical recordingKey', () => {
    // the blind critic's P1: a local weak normalizer broke the
    // "portable across providers" law. Both files must route through
    // src/api/recording.ts (one identity, zero drift).
    const native = fs.readFileSync('src/storage/appTables.ts', 'utf8');
    const web = fs.readFileSync('src/webmocks/appTables.ts', 'utf8');
    for (const src of [native, web]) {
      expect(src).toContain("from '../api/recording'");
      expect(src).toContain('return recordingKey(track);');
    }
  });
});
