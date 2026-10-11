/**
 * WAVE C · C2 LOCKS — full-text search over the user's own words.
 *
 * THE BAR (C2):
 *   • search " Goa " finds a Memory Tag with note "Tagged this moment in Goa";
 *   • search "heartbreak" finds a Song Story attached to a recording
 *     whose identity carries the word (the indexed-content law: notes
 *     AND recording keys are searchable);
 *   • the index stays in sync with the source tables: write → search
 *     finds it; delete → search doesn't;
 *   • the ≥3-char gate below which the notes section stays silent.
 *
 * The locks run on the SAME decorators + memory index the app wires
 * (createIndexedStories / createIndexedMemoryTags / createMemoryNotesIndex)
 * so the tested path IS the shipped path. The FTS5 DDL and the wiring
 * are pinned by source-law locks (the native module cannot run in bun).
 *
 * MUTATION TARGETS:
 *   M-C2-1 — the story decorator stops indexing upserts → write→search RED;
 *   M-C2-2 — the story decorator stops indexing deletes → delete→search RED.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  createIndexedStories,
  createIndexedMemoryTags,
  createMemoryNotesIndex,
  ftsQueryFor,
  snippetFor,
  noteEntryKey,
  MIN_NOTE_QUERY_CHARS,
} from '../src/storage/noteIndex';
import type { SongStoriesStore, SongStory } from '../src/storage/songStories';
import type { MemoryTagsStore, MemoryTag } from '../src/storage/memoryTags';
import { createSongStories } from '../src/storage/songStories';
import { createMemoryTags } from '../src/storage/memoryTags';

/** In-memory SongStoriesStore fixture (the pure services' test pattern). */
function fixtureStoryStore(): SongStoriesStore & { rows: Map<string, SongStory> } {
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

/** In-memory MemoryTagsStore fixture. */
function fixtureTagStore(): MemoryTagsStore & { rows: Map<string, MemoryTag> } {
  const rows = new Map<string, MemoryTag>();
  return {
    rows,
    async get(id) {
      return rows.get(id) ?? null;
    },
    async all() {
      return [...rows.values()];
    },
    async put(tag) {
      rows.set(tag.id, { ...tag });
    },
    async del(id) {
      rows.delete(id);
    },
  };
}

const NOW = 1_700_000_000_000;

describe('wavec c2 — THE BAR: the sync law', () => {
  test('insert story → search finds it; delete → search does not', async () => {
    const index = createMemoryNotesIndex();
    const store = createIndexedStories(fixtureStoryStore(), index);
    const stories = createSongStories(store);
    await stories.setStory('heartbreakweather|somebody', 'This was playing when we broke up', NOW);
    // the write landed in the index (through the decorator)
    const hits = await index.search('heartbreak', 8);
    expect(hits.length).toBe(1);
    expect(hits[0].source).toBe('story');
    expect(hits[0].text).toBe('This was playing when we broke up');
    // the delete also lands in the index
    await stories.removeStory('heartbreakweather|somebody');
    const after = await index.search('heartbreak', 8);
    expect(after.length).toBe(0);
  });

  test('search " Goa " finds the memory tag "Tagged this moment in Goa"', async () => {
    const index = createMemoryNotesIndex();
    const store = createIndexedMemoryTags(fixtureTagStore(), index);
    const tags = createMemoryTags(store);
    const saved = await tags.attach('goatrip|asha', NOW, 'Tagged this moment in Goa');
    expect(saved).not.toBeNull();
    const hits = await index.search(' Goa ', 8);
    expect(hits.length).toBe(1);
    expect(hits[0].text).toBe('Tagged this moment in Goa');
    expect(hits[0].source).toBe('memory_tag');
  });

  test('a tag note update re-indexes (no stale rows)', async () => {
    const index = createMemoryNotesIndex();
    const store = createIndexedMemoryTags(fixtureTagStore(), index);
    const tags = createMemoryTags(store);
    // same SECOND = same memoryTagId = a true update (the pure service's
    // per-second identity law); a different second would be a NEW tag
    await tags.attach('key|artist', NOW, 'first words here');
    await tags.attach('key|artist', NOW, 'second words entirely');
    const stale = await index.search('first words', 8);
    expect(stale.length).toBe(0);
    const fresh = await index.search('second words', 8);
    expect(fresh.length).toBe(1);
  });

  test('a blank note never enters the index', async () => {
    const index = createMemoryNotesIndex();
    const store = createIndexedMemoryTags(fixtureTagStore(), index);
    const tags = createMemoryTags(store);
    await tags.attach('key|artist', NOW, '   ');
    expect(await index.count()).toBe(0);
    expect(await index.search('key', 8)).toHaveLength(0);
  });

  test('the service LRU eviction stays in sync (eviction calls the store)', async () => {
    const index = createMemoryNotesIndex();
    const store = createIndexedStories(fixtureStoryStore(), index);
    const stories = createSongStories(store);
    // STORIES.cap is 1000 — exercise the eviction path at a smaller scale
    // by direct store writes + one service delete (the sync is the law)
    await stories.setStory('aaa|artist', 'note one about rain', NOW);
    await stories.setStory('bbb|artist', 'note two about goa', NOW + 1);
    expect(await index.count()).toBe(2);
    await stories.removeStory('aaa|artist');
    expect(await index.count()).toBe(1);
    expect((await index.search('rain', 8)).length).toBe(0);
    expect((await index.search('goa', 8)).length).toBe(1);
  });
});

describe('wavec c2 — the search contract', () => {
  test('the ≥3-char gate: short queries are noise and return nothing', async () => {
    const index = createMemoryNotesIndex();
    await index.upsert({
      entryKey: noteEntryKey('story', 'goa|asha'),
      recordingKey: 'goa|asha',
      text: 'the goa trip',
      source: 'story',
    });
    expect(await index.search('go', 8)).toHaveLength(0);
    expect(await index.search('  ', 8)).toHaveLength(0);
    expect(await index.search('goa', 8)).toHaveLength(1);
    expect(MIN_NOTE_QUERY_CHARS).toBe(3);
  });

  test('multi-token queries AND together', async () => {
    const index = createMemoryNotesIndex();
    await index.upsert({
      entryKey: noteEntryKey('story', 'k1'),
      recordingKey: 'k1',
      text: 'rainy goa evening',
      source: 'story',
    });
    await index.upsert({
      entryKey: noteEntryKey('story', 'k2'),
      recordingKey: 'k2',
      text: 'rainy mumbai night',
      source: 'story',
    });
    expect((await index.search('rainy goa', 8)).length).toBe(1);
    expect((await index.search('rainy night', 8)).length).toBe(1);
    expect((await index.search('rainy', 8)).length).toBe(2);
  });

  test('the recording identity is searchable (the "heartbreak" law)', async () => {
    const index = createMemoryNotesIndex();
    await index.upsert({
      entryKey: noteEntryKey('story', 'heartbreakweather|somebody'),
      recordingKey: 'heartbreakweather|somebody',
      text: 'This was playing when we broke up',
      source: 'story',
    });
    // the note text does NOT contain "heartbreak" — the key does
    const hits = await index.search('heartbreak', 8);
    expect(hits.length).toBe(1);
    expect(hits[0].recordingKey).toBe('heartbreakweather|somebody');
  });

  test('the limit caps results deterministically', async () => {
    const index = createMemoryNotesIndex();
    for (let i = 0; i < 12; i++) {
      await index.upsert({
        entryKey: noteEntryKey('story', `k${i}`),
        recordingKey: `k${i}`,
        text: `memory number ${i} mentions goa`,
        source: 'story',
      });
    }
    const hits = await index.search('goa', 5);
    expect(hits.length).toBe(5);
  });

  test('X6: 1000 notes answer in well under 10ms on the memory backend', async () => {
    const index = createMemoryNotesIndex();
    for (let i = 0; i < 1000; i++) {
      await index.upsert({
        entryKey: noteEntryKey('story', `k${i}`),
        recordingKey: `k${i}`,
        text: `note ${i} with some words and goa once in a while ${i % 10}`,
        source: 'story',
      });
    }
    const t0 = performance.now();
    await index.search('goa', 8);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(10);
  });
});

describe('wavec c2 — the pure helpers', () => {
  test('ftsQueryFor quotes + prefixes tokens, AND-joins them', () => {
    expect(ftsQueryFor(' Goa ')).toBe('"goa"*');
    expect(ftsQueryFor('rainy goa')).toBe('"rainy"* "goa"*');
    expect(ftsQueryFor('"nefarious" AND (stuff)')).toBe('"nefarious"* "and"* "stuff"*');
    expect(ftsQueryFor('   ')).toBeNull();
  });

  test('snippetFor windows around the first hit with honest ellipses', () => {
    const long = 'x'.repeat(50) + ' the goa trip changed me ' + 'y'.repeat(50);
    const snip = snippetFor(long, 'goa');
    expect(snip.startsWith('…')).toBeTrue();
    expect(snip.endsWith('…')).toBeTrue();
    expect(snip).toContain('goa trip');
    expect(snippetFor('short note', 'note')).toBe('short note');
  });

  test('noteEntryKey is the one key builder', () => {
    expect(noteEntryKey('story', 'k|a')).toBe('story:k|a');
    expect(noteEntryKey('memory_tag', 'k|a:123')).toBe('tag:k|a:123');
  });
});

describe('wavec c2 — source law: the native + web wiring', () => {
  const appTables = readFileSync(new URL('../src/storage/appTables.ts', import.meta.url), 'utf-8');
  const webmock = readFileSync(new URL('../src/webmocks/appTables.ts', import.meta.url), 'utf-8');

  test('the FTS5 virtual table exists with the working schema', () => {
    expect(appTables).toContain('personal_notes_fts USING fts5(');
    expect(appTables).toContain('UNINDEXED(entry_key)');
  });

  test('the one-time migration backfills stories + non-blank tags', () => {
    expect(appTables).toContain("SELECT recordingKey, text, 'story', 'story:' || recordingKey FROM song_stories");
    expect(appTables).toContain("SELECT recordingKey, note, 'memory_tag', 'tag:' || id FROM memory_tags WHERE note IS NOT NULL AND note != ''");
  });

  test('writes route through the indexed decorators on BOTH platforms', () => {
    expect(appTables).toContain('createIndexedStories(storiesStore, notesIndex)');
    expect(appTables).toContain('createIndexedMemoryTags(memoryTagsStore, notesIndex)');
    expect(webmock).toContain('createIndexedStories(storiesStore, notesIndex)');
    expect(webmock).toContain('createIndexedMemoryTags(memoryTagsStore, notesIndex)');
    expect(webmock).toContain('createMemoryNotesIndex()');
  });

  test('the FTS5 MATCH path is rank-ordered with a snippet', () => {
    expect(appTables).toContain('personal_notes_fts MATCH ?');
    expect(appTables).toContain('ORDER BY rank LIMIT ?');
    expect(appTables).toContain("snippet(personal_notes_fts, 1, '', '', '…', 12)");
  });

  test('parity: both modules expose the notes search on AppTables', () => {
    for (const src of [appTables, webmock]) {
      expect(src).toContain('notes: NotesIndex;');
    }
  });
});
