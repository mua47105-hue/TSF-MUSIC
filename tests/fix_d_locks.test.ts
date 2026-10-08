/**
 * v5.0.1 FIX-D2 + FIX-D3 + FIX-D4 — THE EDGE CASES, LOCKED.
 *
 * FIX-D2: word spans are INTEGER allocations summing exactly to the
 * line's duration — every emitted word has endMs > startMs. The old
 * round+snap could emit a ZERO-duration final word (a 100:1-char split
 * of a 2 ms line).
 *
 * FIX-D3: the genre-art probe cache records MISSES too — revisiting
 * the map never re-probes a genre the catalog already failed once.
 *
 * FIX-D4: memoryTags.attach returns the STORED row — on a re-tag the
 * persisted `at` (the original moment) is what the caller sees.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { activeWord, withWordSpans } from '../src/player/singalong';
import { cachedGenreArt, storeGenreArt } from '../src/ai/genreExplorer';
import { createMemoryTags, type MemoryTag, type MemoryTagsStore } from '../src/storage/memoryTags';

describe('FIX-D2 · every emitted word has endMs > startMs (integer spans, Σ = line duration)', () => {
  test('THE AUDITOR\u2019S DEGENERATE CASE: a 2 ms line split across words of 100:1 chars', () => {
    // OLD code: word1 took the whole 2 ms (round(100/101×2)=2), the last
    // word got startMs 2 > its snapped endMs 0 — a zero-duration span.
    const lines = [
      { tMs: 10000, text: `${'a'.repeat(100)} b` },
      { tMs: 10002, text: 'next line words' }, // the span is exactly 2 ms
    ];
    const [line] = withWordSpans(lines as never);
    expect(line.words.length).toBe(2);
    for (const w of line.words) {
      expect(w.endMs).toBeGreaterThan(w.startMs); // THE BAR
    }
    expect(line.words[0].startMs).toBe(10000);
    expect(line.words[1].endMs).toBe(10002); // Σ = the line's duration
    expect(line.words[1].endMs - line.words[1].startMs).toBe(1); // the 1 ms floor held
  });

  test('a narrow line gives every word ≥1 integer ms and sums exactly', () => {
    const lines = [
      { tMs: 5000, text: 'ab cde fghi' }, // 3 words (2/3/4 chars of 9), 5 ms span
      { tMs: 5005, text: 'next' },
    ];
    const [line] = withWordSpans(lines as never);
    // floors 1/1/2 (Σ 4), the surplus goes to the largest share (fghi): [1,1,3]
    expect(line.words.map((w) => w.endMs - w.startMs)).toEqual([1, 1, 3]);
    for (const w of line.words) expect(w.endMs).toBeGreaterThan(w.startMs);
    expect(line.words[line.words.length - 1].endMs).toBe(5005); // Σ = 5
  });

  test('THE TRIM-FLOOR GUARD (critic P2-1): a surplus-after-floors span never starves a word below 1 ms', () => {
    // lens [10,1,1,1,1] over a 5 ms span: the floors sum to 7 > 5, so
    // the trim loop must shrink the big word down to the floor. Without
    // the `durs[i] > 1` guard the wrap-around trim emits [2,0,1,1,1] —
    // a zero-duration word. Locked at the exact repro shape.
    const lines = [
      { tMs: 7000, text: `${'a'.repeat(10)} b c d e` },
      { tMs: 7005, text: 'next' },
    ];
    const [line] = withWordSpans(lines as never);
    expect(line.words.map((w) => w.endMs - w.startMs)).toEqual([1, 1, 1, 1, 1]);
    for (const w of line.words) expect(w.endMs).toBeGreaterThan(w.startMs);
    expect(line.words[line.words.length - 1].endMs).toBe(7005);
  });

  test('the normal path stays within 1ms of the old round+snap: the wave3 pins hold', () => {
    // honest scope (critic P3): the integer allocation CAN shift a
    // normal line's interior boundaries by ≤1ms vs the old round+snap
    // (e.g. "Channa mereya mereya" went [1333,1333,1334]→[1334,1333,
    // 1333]) — the wave3 pins (exact 750ms splits, chained spans, last
    // word owns the true end) are the contract, and they hold.
    const lines = [
      { tMs: 10000, text: 'Tum hi ho ab tum hi ho' }, // 16 chars, 4000 ms
      { tMs: 14000, text: 'next' },
    ];
    const [line] = withWordSpans(lines as never);
    expect(line.words[0]).toEqual({ word: 'Tum', startMs: 10000, endMs: 10750 });
    expect(line.words.map((w) => w.endMs - w.startMs)).toEqual([750, 500, 500, 500, 750, 500, 500]);
  });

  test('activeWord stays correct on re-allocated degenerate lines', () => {
    const lines = [
      { tMs: 10000, text: `${'a'.repeat(100)} b` },
      { tMs: 10002, text: 'next line words' },
    ];
    const [line] = withWordSpans(lines as never);
    expect(activeWord(line, 9999)).toBe(-1); // before the line
    expect(activeWord(line, 10000)).toBe(0); // word 1 on the mic
    expect(activeWord(line, 10001)).toBe(1); // word 2 owns the last ms
    expect(activeWord(line, 10002)).toBe(-1); // past the line
  });

  test('structural degradation is untouched (single word / zero span / too-narrow)', () => {
    expect(withWordSpans([{ tMs: 5000, text: 'one' }] as never)[0].words).toEqual([]);
    expect(withWordSpans([{ tMs: 5000, text: 'a b' }, { tMs: 5000, text: 'c d' }] as never)[0].words).toEqual([]);
    expect(withWordSpans([{ tMs: 5000, text: 'a b c d' }, { tMs: 5003, text: 'x' }] as never)[0].words).toEqual([]); // 3ms < 4 words
  });
});

describe('FIX-D3 · the art probe cache remembers misses', () => {
  test('a null probe is cached: needsProbe flips false for the module lifetime', () => {
    const cache = new Map<string, string>();
    expect(cachedGenreArt(cache, 'rock')).toEqual({ uri: '', needsProbe: true });
    storeGenreArt(cache, 'rock', null); // the probe failed / no art
    expect(cachedGenreArt(cache, 'rock')).toEqual({ uri: '', needsProbe: false }); // cached negative
    expect(cachedGenreArt(cache, 'rock').needsProbe).toBe(cachedGenreArt(cache, 'rock').needsProbe);
    expect(cache.has('rock')).toBeTrue();
  });

  test('a hit still reads back the URI (the positive path is unchanged)', () => {
    const cache = new Map<string, string>();
    storeGenreArt(cache, 'pop', 'https://art/pop.jpg');
    expect(cachedGenreArt(cache, 'pop')).toEqual({ uri: 'https://art/pop.jpg', needsProbe: false });
  });

  test('a COMPLETED probe is stored even when the component unmounted mid-flight (critic P2-2: no re-probe on remount)', () => {
    // the store is unconditional once the probe finished — the genre's
    // truth does not depend on the component that happened to ask.
    // (Only the React state write is gated on liveness.)
    const src = readFileSync('src/screens/GenreExplorer.tsx', 'utf8');
    const storeAt = src.indexOf('storeGenreArt(artCache, genre, art); // FIX-D3');
    const gateAt = src.indexOf("if (art && !cancelled) setUri(art);");
    expect(storeAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(storeAt); // store FIRST, state-write second
    expect(src).toContain("a COMPLETED probe is the genre's truth");
  });

  test('WIRING: the screen probes only on needsProbe and stores EVERY outcome (misses included)', () => {
    const src = readFileSync('src/screens/GenreExplorer.tsx', 'utf8');
    expect(src).toContain('cachedGenreArt(artCache, genre).needsProbe');
    expect(src).toContain('storeGenreArt(artCache, genre, art); // FIX-D3');
    // the store call sits OUTSIDE the try (a thrown probe is cached too)
    const storeAt = src.indexOf('storeGenreArt(artCache, genre, art);');
    const catchClose = src.indexOf('} catch {', src.indexOf('getArtistCatalog'));
    expect(storeAt).toBeGreaterThan(catchClose);
    expect(src).not.toMatch(/artCache\.set\(/); // the raw map write is gone (the contract owns it)
  });
});

// ── FIX-D4 fixture (the wave5 pattern) ─────────────────────────────────

function memoryTagsFixture(): MemoryTagsStore & { rows: Map<string, MemoryTag> } {
  const rows = new Map<string, MemoryTag>();
  return {
    rows,
    async get(id) { return rows.get(id) ?? null; },
    async all() { return [...rows.values()]; },
    async put(tag) { rows.set(tag.id, { ...tag }); },
    async del(id) { rows.delete(id); },
  };
}

describe('FIX-D4 · attach returns the STORED row', () => {
  test('a fresh tag round-trips with the persisted at', async () => {
    const svc = createMemoryTags(memoryTagsFixture());
    const tag = await svc.attach('song::artist', 5000, 'the moment');
    expect(tag?.at).toBe(5000);
    expect(tag?.note).toBe('the moment');
  });

  test('A RE-TAG (same second bucket) returns the ORIGINAL persisted moment, not the freshly-built row', async () => {
    const store = memoryTagsFixture();
    const svc = createMemoryTags(store);
    await svc.attach('song::artist', 5000, 'first');
    // the deterministic id is per-SECOND: re-tagging inside the same
    // second (5500 lives in the :5 bucket) UPDATES the row — and the
    // persisted `at` stays the ORIGINAL moment (5000), so the returned
    // row must say 5000, not the fresh 5500 (the auditor's D4).
    const retag = await svc.attach('song::artist', 5500, 'second');
    expect(retag?.at).toBe(5000);
    expect(retag?.note).toBe('second');
    expect(store.rows.get('song::artist:5')?.at).toBe(5000);
  });
});
