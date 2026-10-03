/**
 * SING-ALONG LOCKS (Task 29 · godmode wave 2) — synced lyrics, locked:
 *
 *   1. parseLrc: timestamps (2- and 3-digit fractions), multi-stamp
 *      chorus lines expand, metadata/instrumental lines drop, output is
 *      sorted, empty input → [].
 *   2. activeLrcIndex: binary-search honesty — -1 before the first
 *      stamp, exact hits, mid lines, past-the-end clamps to last.
 *   3. fetchSyncedLyrics / fetchPlainLyrics: BOTH shapes come from ONE
 *      catalog call (in-flight dedupe), plain still falls back to the
 *      synced text (caller strips stamps), aborts return null and never
 *      cache, and a cache hit does not re-fetch.
 */

import { describe, expect, test } from 'bun:test';
import { activeLrcIndex, parseLrc } from '../../src/player/singalong';

describe('singalong · parseLrc', () => {
  test('parses stamps with 2- and 3-digit fractions + no fraction', () => {
    const lines = parseLrc('[00:01.5]a\n[01:02.05]b\n[02:03]c');
    expect(lines.map((l) => l.tMs)).toEqual([1500, 62050, 123000]);
    expect(lines.map((l) => l.text)).toEqual(['a', 'b', 'c']);
  });

  test('multi-stamp chorus lines expand into repeated entries', () => {
    const lines = parseLrc('[00:10.00][00:40.00]chorus\n[00:20.00]verse');
    expect(lines.map((l) => `${l.tMs}:${l.text}`)).toEqual([
      '10000:chorus',
      '20000:verse',
      '40000:chorus',
    ]);
  });

  test('metadata tags and stamp-only (instrumental) lines are dropped', () => {
    const lines = parseLrc('[ti:Song]\n[ar:Artist]\n[offset:+500]\n[00:05.00]real\n[00:15.00]');
    expect(lines).toEqual([{ tMs: 5000, text: 'real' }]);
  });

  test('empty / null input → []', () => {
    expect(parseLrc('')).toEqual([]);
    expect(parseLrc(null)).toEqual([]);
    expect(parseLrc(undefined)).toEqual([]);
    expect(parseLrc('no stamps here')).toEqual([]);
  });
});

describe('singalong · activeLrcIndex', () => {
  const lines = parseLrc('[00:10.00]a\n[00:20.00]b\n[00:30.00]c');
  test('-1 before the first stamp', () => {
    expect(activeLrcIndex(lines, 0)).toBe(-1);
    expect(activeLrcIndex(lines, 9999)).toBe(-1);
  });
  test('exact stamp and mid-line windows hit the right row', () => {
    expect(activeLrcIndex(lines, 10000)).toBe(0);
    expect(activeLrcIndex(lines, 10001)).toBe(0);
    expect(activeLrcIndex(lines, 29999)).toBe(1);
  });
  test('past the end clamps to the last line; empty → -1', () => {
    expect(activeLrcIndex(lines, 999999)).toBe(2);
    expect(activeLrcIndex([], 5000)).toBe(-1);
  });
});

// ── lrclib dual-shape contract ─────────────────────────────────────────

const calls: string[] = [];

function stubFetchOnce(row: unknown) {
  (globalThis as { fetch: unknown }).fetch = ((url: string | URL | Request) => {
    calls.push(String(url));
    return Promise.resolve(new Response(JSON.stringify([row]), { status: 200 }));
  }) as typeof fetch;
}

// unique titles per case so the module-level LRU never crosses cases
describe('singalong · lrclib dual-shape contract', () => {
  test('both shapes come from ONE call; plain falls back to synced text', async () => {
    calls.length = 0;
    stubFetchOnce({
      trackName: 'T1',
      plainLyrics: '',
      syncedLyrics: '[00:01.00]one\n[00:02.00]two',
    });
    const { fetchPlainLyrics, fetchSyncedLyrics } = await import('../../src/api/lrclib');
    const [plain, synced] = await Promise.all([
      fetchPlainLyrics('Dual Shape One', 'A'),
      fetchSyncedLyrics('Dual Shape One', 'A'),
    ]);
    expect(plain).toBe('[00:01.00]one\n[00:02.00]two'); // caller strips stamps (unchanged contract)
    expect(synced).toBe('[00:01.00]one\n[00:02.00]two');
    expect(calls.length).toBe(1); // in-flight dedupe: one catalog call
  });

  test('cache hit does not re-fetch', async () => {
    calls.length = 0;
    const { fetchSyncedLyrics } = await import('../../src/api/lrclib');
    await fetchSyncedLyrics('Dual Shape One', 'A'); // warm from prior case's cache
    expect(calls.length).toBe(0);
  });

  test('aborted signal → null, and the failure never caches', async () => {
    calls.length = 0;
    stubFetchOnce({ plainLyrics: 'x', syncedLyrics: '[00:01.00]x' });
    const { fetchSyncedLyrics } = await import('../../src/api/lrclib');
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await fetchSyncedLyrics('Aborted Song', 'A', ctrl.signal)).toBeNull();
    expect(calls.length).toBe(0); // aborted before any network call
  });
});
