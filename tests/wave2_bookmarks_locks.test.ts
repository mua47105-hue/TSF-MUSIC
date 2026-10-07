/**
 * MAGNUM OPUS WAVE 2 · F7 — AUDIO BOOKMARKS LOCKS.
 *
 * The bar: pure functions (gesture classifier, snapping, ids) over
 * fixture stores; keyed by recordingKey (portable across providers);
 * jump/delete semantics honest; caps enforced (50/track, 500 total —
 * LITERALS, never a constant checked against itself); the existing
 * scrub gesture is untouched (verdict 'scrub' for everything the old
 * bar treated as scrub).
 */

import { describe, expect, test } from 'bun:test';
import {
  bookmarkIdOf,
  classifyPress,
  createBookmarks,
  sanitizeBookmarkNote,
  snapBookmarkPosition,
  type Bookmark,
  type BookmarksStore,
} from '../src/player/bookmarks';

function fixtureStore(): BookmarksStore & { rows: Map<string, Bookmark> } {
  const rows = new Map<string, Bookmark>();
  return {
    rows,
    async forTrack(recordingKey) {
      return [...rows.values()].filter((b) => b.recordingKey === recordingKey);
    },
    async all() {
      return [...rows.values()];
    },
    async put(b) {
      rows.set(b.id, { ...b });
    },
    async del(id) {
      rows.delete(id);
    },
  };
}

describe('F7 · classifyPress — the gesture contract (pure)', () => {
  test('quick tap and drag = scrub (the pre-F7 behavior, byte-identical)', () => {
    expect(classifyPress(0, 0)).toBe('scrub'); // instant
    expect(classifyPress(120, 0)).toBe('scrub'); // a fast tap
    expect(classifyPress(300, 80)).toBe('scrub'); // a drag, however long
    expect(classifyPress(549, 0)).toBe('scrub'); // one ms short of the hold
  });
  test('still-and-held ≥550ms with ≤10px travel = bookmark save', () => {
    expect(classifyPress(550, 0)).toBe('bookmark'); // exactly the hold
    expect(classifyPress(1200, 3)).toBe('bookmark'); // a confident hold
    expect(classifyPress(550, 10)).toBe('bookmark'); // travel boundary holds
  });
  test('a slow drift is a scrub, not a bookmark (travel gate wins)', () => {
    expect(classifyPress(900, 11)).toBe('scrub'); // 11px of drift = scrubbing
    expect(classifyPress(5000, 400)).toBe('scrub');
  });
  test('literal bridge: the constants are the documented numbers', () => {
    // bridges the behavior locks above to the documented rationale —
    // if either side drifts, one of the two laws fails
    const { BOOKMARKS } = require('../src/ai/core/constants');
    expect(BOOKMARKS.longPressMs).toBe(550);
    expect(BOOKMARKS.moveTolerancePx).toBe(10);
    expect(BOOKMARKS.perTrackCap).toBe(50);
    expect(BOOKMARKS.totalCap).toBe(500);
    expect(BOOKMARKS.snapMs).toBe(1000);
    expect(BOOKMARKS.maxNoteChars).toBe(120);
  });
});

describe('F7 · pure helpers (ids, snapping, notes)', () => {
  test('bookmark ids are deterministic: one per second per recording', () => {
    expect(bookmarkIdOf('tum hi ho::arijit singh', 65432)).toBe('tum hi ho::arijit singh:65');
    expect(bookmarkIdOf('tum hi ho::arijit singh', 65100)).toBe('tum hi ho::arijit singh:65'); // same second
    expect(bookmarkIdOf('channa mereya::arijit singh', 65432)).toBe('channa mereya::arijit singh:65');
  });
  test('positions snap to whole seconds and clamp at zero', () => {
    expect(snapBookmarkPosition(65432)).toBe(65000);
    expect(snapBookmarkPosition(65001)).toBe(65000); // 500ms rounds up at half
    expect(snapBookmarkPosition(-40)).toBe(0);
  });
  test('notes: control chars stripped, 120-char cap enforced', () => {
    expect(sanitizeBookmarkNote('  chorus drop \u0007here ')).toBe('chorus drop here');
    expect(sanitizeBookmarkNote('x'.repeat(300)).length).toBe(120);
  });
});

describe('F7 · service over a fixture store (CRUD + caps)', () => {
  test('add → list round-trip: position sorted, keyed by recordingKey', async () => {
    const svc = createBookmarks(fixtureStore());
    await svc.add('song::artist', 90000, 'the drop', 1000);
    await svc.add('song::artist', 30000, '', 1001);
    await svc.add('other::artist', 10000, '', 1002);
    const mine = await svc.list('song::artist');
    expect(mine.map((b) => b.positionMs)).toEqual([30000, 90000]); // sorted
    expect(await svc.list('nothing::here')).toEqual([]); // honest empty
    expect(await svc.count()).toBe(3);
  });
  test('re-saving the same second UPDATES the note, keeps createdAt', async () => {
    const svc = createBookmarks(fixtureStore());
    await svc.add('song::artist', 65000, 'first', 1000);
    const again = await svc.add('song::artist', 65400, 'second', 9000);
    expect(again?.note).toBe('second');
    expect(again?.createdAt).toBe(1000); // creation survives the update
    expect(await svc.count()).toBe(1); // no duplicate row
  });
  test('invalid input is an honest null (no row, no crash)', async () => {
    const svc = createBookmarks(fixtureStore());
    expect(await svc.add('', 1000, '', 1000)).toBeNull();
    expect(await svc.add('song::artist', -5, '', 1000)).toBeNull();
    expect(await svc.count()).toBe(0);
  });
  test('per-track cap 50 (literal): the 51st saves, the oldest evicts', async () => {
    const store = fixtureStore();
    const svc = createBookmarks(store);
    for (let i = 0; i < 51; i++) await svc.add('song::artist', i * 10000, `n${i}`, 1000 + i);
    const mine = await svc.list('song::artist');
    expect(mine.length).toBe(50);
    expect(await svc.count()).toBe(50);
    expect(mine.find((b) => b.note === 'n0')).toBeUndefined(); // oldest gone
    expect(mine.find((b) => b.note === 'n50')).toBeDefined(); // newest stays
  });
  test('global cap 500 (literal): overflow evicts oldest across recordings', async () => {
    const svc = createBookmarks(fixtureStore());
    for (let i = 0; i < 495; i++) await svc.add(`trackA${i}::x`, 1000, '', 1000 + i);
    for (let i = 0; i < 10; i++) await svc.add(`trackB${i}::x`, 1000, '', 2000 + i);
    expect(await svc.count()).toBe(500); // 505 adds → 500 survive
    // the earliest trackA rows are the global FIFO victims
    expect(await svc.list('trackA0::x')).toEqual([]);
    expect(await svc.list('trackA4::x')).toEqual([]); // 1000..1004 evicted
    expect((await svc.list('trackA5::x')).length).toBe(1); // 1005 survives
    expect((await svc.list('trackB9::x')).length).toBe(1); // newest survives
  });
  test('remove: deletes the row, honest false when absent', async () => {
    const svc = createBookmarks(fixtureStore());
    const bm = await svc.add('song::artist', 65000, '', 1000);
    expect(await svc.remove(bm!.id)).toBeTrue();
    expect(await svc.remove(bm!.id)).toBeFalse(); // already gone — no lie
    expect(await svc.list('song::artist')).toEqual([]);
  });
});
