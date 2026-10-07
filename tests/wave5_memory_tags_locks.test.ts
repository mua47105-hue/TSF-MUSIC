/**
 * MAGNUM OPUS WAVE 5 · F20 — MEMORY TAGS LOCKS (LITE EDITION).
 *
 * The bar: attachMemory is PURE (no store touched); rows are keyed by
 * recordingKey (portable across providers — NEVER trackId); the id is
 * a deterministic per-second stamp (re-tag the same second = UPDATE
 * that keeps the original moment); the LRU cap evicts by oldest `at`,
 * literally 500, and never the row just saved; the schema has NO field
 * a stream handle could occupy; the LITE decision is source-locked
 * (no expo-location, no expo-camera, no permission code — none is
 * captured, so none is displayed).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  attachMemory,
  memoryTagId,
  sanitizeMemoryNote,
  createMemoryTags,
  type MemoryTag,
  type MemoryTagsStore,
} from '../src/storage/memoryTags';

function fixtureStore(): MemoryTagsStore & { rows: Map<string, MemoryTag> } {
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

describe('F20 · attachMemory — the pure attacher', () => {
  test('builds the row: deterministic per-second id, LITE nulls, no streamUrl anywhere', () => {
    const tag = attachMemory('saavn|video|abc', 1_756_400_123_456, 'rooftop, rain, this exact song');
    expect(tag).not.toBeNull();
    expect(tag!.id).toBe('saavn|video|abc:1756400123'); // floor(at/1000) — the literal shape
    expect(tag!.recordingKey).toBe('saavn|video|abc');
    expect(tag!.at).toBe(1_756_400_123_456);
    expect(tag!.lat).toBeNull(); // LITE: no location is captured
    expect(tag!.lng).toBeNull();
    expect(tag!.photoUri).toBeNull();
    expect(tag!.note).toBe('rooftop, rain, this exact song');
    expect(Object.keys(tag!).sort()).toEqual(['at', 'id', 'lat', 'lng', 'note', 'photoUri', 'recordingKey']);
  });

  test('blank notes and blank keys are honest no-ops (null, never a stub row)', () => {
    expect(attachMemory('k', 1, '   ')).toBeNull();
    expect(attachMemory('k', 1, '')).toBeNull();
    expect(attachMemory('', 1, 'note')).toBeNull();
  });

  test('two tags inside the SAME second share an id (re-tag = update); one second apart does not', () => {
    expect(memoryTagId('k', 1_000_000)).toBe(memoryTagId('k', 1_000_999));
    expect(memoryTagId('k', 1_000_000)).not.toBe(memoryTagId('k', 1_001_000));
    expect(memoryTagId('k', 1_000)).toBe('k:1');
  });
});

describe('F20 · sanitizeMemoryNote — the note is tamed', () => {
  test('control chars are stripped, 3+ newlines collapse to 2, edges trimmed', () => {
    expect(sanitizeMemoryNote('a\u0007b\u001fc')).toBe('abc');
    expect(sanitizeMemoryNote('one\n\n\n\ntwo')).toBe('one\n\ntwo');
    expect(sanitizeMemoryNote('  padded  ')).toBe('padded');
  });

  test('the cap is a literal 240 chars — not a constant checked against itself', () => {
    const long = 'x'.repeat(300);
    expect(sanitizeMemoryNote(long).length).toBe(240);
  });
});

describe('F20 · the service over a fixture store', () => {
  test('attach persists; list returns newest-moment first, filtered by recordingKey', async () => {
    const store = fixtureStore();
    const svc = createMemoryTags(store);
    await svc.attach('k1', 1_000, 'first');
    await svc.attach('k1', 3_000, 'third');
    await svc.attach('k2', 2_000, 'other song');
    const all = await svc.list();
    expect(all.map((t) => t.note)).toEqual(['third', 'other song', 'first']); // newest first
    const mine = await svc.list('k1');
    expect(mine.map((t) => t.note)).toEqual(['third', 'first']);
    expect((await svc.count())).toBe(3);
  });

  test('re-tagging the same second UPDATES and keeps the ORIGINAL moment', async () => {
    const store = fixtureStore();
    const svc = createMemoryTags(store);
    await svc.attach('k', 1_000_500, 'typed in a hurry');
    await svc.attach('k', 1_000_900, 'the corrected memory');
    const rows = await svc.list('k');
    expect(rows.length).toBe(1); // one row, not two
    expect(rows[0].note).toBe('the corrected memory');
    expect(rows[0].at).toBe(1_000_500); // the ORIGINAL moment survives
  });

  test('remove: true when the row existed, false when it did not', async () => {
    const store = fixtureStore();
    const svc = createMemoryTags(store);
    const saved = await svc.attach('k', 1_000, 'gone soon');
    expect(await svc.remove(saved!.id)).toBeTrue();
    expect(await svc.remove(saved!.id)).toBeFalse();
    expect(await svc.remove('')).toBeFalse();
    expect(await svc.count()).toBe(0);
  });

  test('the LRU cap is a literal 500 — the oldest moments leave, the fresh tag NEVER does', async () => {
    const store = fixtureStore();
    const svc = createMemoryTags(store);
    for (let i = 0; i < 500; i++) {
      await svc.attach(`k${i}`, 1_000_000 + i * 1_000, `m${i}`); // at = 1.000s … 500.999s
    }
    expect(await svc.count()).toBe(500); // full, not over
    const fresh = await svc.attach('k-new', 999_999_999_999, 'the moment that matters');
    expect(fresh).not.toBeNull();
    expect(await svc.count()).toBe(500); // a cap, not a suggestion
    const newest = await svc.list();
    expect(newest[0].note).toBe('the moment that matters'); // the fresh row SURVIVED
    // the OLDEST moment (at = 1_000_000) was the eviction — verify exactly one of the two boundary rows died
    const all = await store.all();
    expect(all.find((t) => t.note === 'm0')).toBeUndefined(); // the oldest is gone
    expect(all.find((t) => t.note === 'm499')).toBeDefined(); // the newest old row still lives
  });

  test('a re-tagged OLD moment does not strand the cap at 501 (blind-critic P2 — deletions are counted)', async () => {
    const store = fixtureStore();
    const svc = createMemoryTags(store);
    for (let i = 0; i < 500; i++) {
      await svc.attach(`k${i}`, 1_000_000 + i * 1_000, `m${i}`);
    }
    // a service-level attach with an `at` OLDER than everything: the fresh
    // row IS the oldest — the skip must not consume the eviction slot
    await svc.attach('k-new', 500_000, 'older than every stored moment');
    expect(await svc.count()).toBe(500); // NOT 501 — the skip counted
    const all = await store.all();
    expect(all.find((t) => t.note === 'older than every stored moment')).toBeDefined(); // the fresh row lives
    expect(all.find((t) => t.note === 'm0')).toBeUndefined(); // the next-oldest paid the slot
  });
});

describe('F20 · source laws (schema, wiring, and the LITE honesty)', () => {
  test('the SQLite schema has exactly the 7 columns — no field a stream handle could occupy', () => {
    const native = readFileSync('src/storage/appTables.ts', 'utf8');
    expect(native).toMatch(/CREATE TABLE IF NOT EXISTS memory_tags \(\s*\n\s*id TEXT PRIMARY KEY,\s*\n\s*recordingKey TEXT NOT NULL,\s*\n\s*lat REAL,\s*\n\s*lng REAL,\s*\n\s*at INTEGER NOT NULL,\s*\n\s*photoUri TEXT,\s*\n\s*note TEXT NOT NULL DEFAULT ''\s*\n\);/);
    expect(native).not.toMatch(/memory_tags[^;]*streamUrl/i);
    expect(native).toContain('CREATE INDEX IF NOT EXISTS idx_memory_tags_track ON memory_tags(recordingKey)');
  });

  test('webmock parity: both appTables twins export the memoryTags service', () => {
    const native = readFileSync('src/storage/appTables.ts', 'utf8');
    const web = readFileSync('src/webmocks/appTables.ts', 'utf8');
    expect(native).toContain('memoryTags: createMemoryTags(');
    expect(native).toContain("from './memoryTags'");
    expect(web).toContain('memoryTags: createMemoryTags(');
    expect(web).toContain("from '../storage/memoryTags'");
  });

  test('the player wiring: recordingKey-keyed (contentKeyOf), chip only when tags exist, tag action present', () => {
    const player = readFileSync('src/screens/PlayerScreen.tsx', 'utf8');
    expect(player).toContain('testID="memory-chip"');
    expect(player).toContain('testID="memory-tag-btn"');
    expect(player).toContain('testID="memory-tag-editor"');
    expect(player).toMatch(/memoryTags\.list\(contentKeyOf\(active\)\)/);
    expect(player).toMatch(/memoryTags\.attach\(here, Date\.now\(\)/);
    expect(player).toContain('MEMORY_TAGS.maxNoteChars'); // the editor maxLength is the documented cap
  });

  test('the LITE decision is enforced in source: no expo-location, no expo-camera IMPORTS, no permission prompts', () => {
    for (const f of ['src/storage/memoryTags.ts', 'src/screens/PlayerScreen.tsx', 'src/storage/appTables.ts']) {
      const src = readFileSync(f, 'utf8');
      // scope to imports/requires/call-sites — honest comments explaining
      // the LITE decision are REQUIRED to keep naming what is absent
      expect(src).not.toMatch(/from 'expo-(location|camera)'/);
      expect(src).not.toMatch(/require\('expo-(location|camera)'\)/);
      expect(src).not.toMatch(/request(Foreground|Background)?Permissions(Async)?\(/);
    }
    const constants = readFileSync('src/ai/core/constants.ts', 'utf8');
    expect(constants).toMatch(/MEMORY_TAGS = \{/);
    expect(constants).toMatch(/cap: 500/);
    expect(constants).toMatch(/maxNoteChars: 240/);
    expect(constants).toMatch(/previewCount: 3/);
  });
});
