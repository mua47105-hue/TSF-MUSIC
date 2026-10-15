/**
 * WAVE A LOCKS — v5.2.1 FIX-A1 … FIX-A5.
 *
 * Evidence classes per fix:
 *
 *  FIX-A1 (the theatre assertion): godmode_locks.test.ts:101 accessed
 *   `.not.toHaveBeenCalled` as a PROPERTY — the sleep-timer guarantee was
 *   unprotected while appearing protected. The scan below reads EVERY
 *   test file and asserts the matcher is always INVOKED — the structure
 *   check that goes RED when the parentheses are removed again.
 *
 *  FIX-A2 (fake crate toasts): CollectionScreen fired "ADDED TO YOUR
 *   CRATES" / "DOWNLOADING CRATE…" writing nothing. Locks: the pure
 *   like-batch core (pickUnfavorited) + source laws (fake literals gone,
 *   no toast fired directly from an onPress, real handlers wired).
 *
 *  FIX-A3 (fake pin toast): PlaylistScreen fired "PINNED TO YOUR CRATES"
 *   and pinned nothing. Locks: the pin round-trip through the REAL store
 *   (setPlaylistPinned → fresh read = the restart simulation) + the pure
 *   ordering law (sortPlaylistsPinnedFirst) + the await-before-toast
 *   source law.
 *
 *  FIX-A4 (unbounded provider fetches): behavioral — a hung fetch (that
 *   even IGNORES its abort signal) settles with a clean timeout error
 *   inside the budget; source laws — no bare `await fetch(` / `await
 *   ytFetch(` remains in the provider layer.
 *
 *  FIX-A5 (itunes typed lie): behavioral — aborting mid-searchItunes
 *   cancels the request end-to-end; source law — `_signal` is gone, the
 *   signal is threaded.
 *
 * Mutations proven RED (worklog V5.2.1-WAVE-A): M-A1-1/2, M-A2-1/2,
 * M-A3-1/2/3, M-A4-1/2/3, M-A5-1/2 — every one restored byte-exact,
 * `git status --porcelain` empty after each restore.
 */

import { describe, expect, test, afterAll, mock } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { rnMockSurface } from './helpers/rnMockSurface';

// ── module mocks (rnMockSurface law + in-memory AsyncStorage) ──────────
mock.module('react-native', () => rnMockSurface());

const storeMap = new Map<string, string>();
mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => storeMap.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      storeMap.set(k, v);
    },
    removeItem: async (k: string) => {
      storeMap.delete(k);
    },
    multiRemove: async (keys: string[]) => {
      keys.forEach((k) => storeMap.delete(k));
    },
  },
}));

afterAll(() => {
  // mock hygiene (the v5.0.1/v5.2.0 leak class): leave nothing behind
  storeMap.clear();
});

const { pickUnfavorited } = await import('../src/player/likeBatch');
const { sortPlaylistsPinnedFirst } = await import('../src/storage/libraryOrder');
const { setPlaylistPinned, createPlaylist, getPlaylists } = await import('../src/storage/store');
const { fetchWithTimeout } = await import('../src/api/fetchWithTimeout');
const { searchItunes } = await import('../src/api/itunes');
const { PROVIDER_FETCH_TIMEOUT_MS } = await import('../src/ai/core/constants');

const SRC = join(import.meta.dir, '..', 'src');
const TESTS = join(import.meta.dir);

function readSrc(...p: string[]): string {
  return readFileSync(join(SRC, ...p), 'utf8');
}

/** The laws check CODE, not documentation — a comment describing the old
 *  lie must never fail a lock (and a lie hidden in a comment must never
 *  pass one as code).
 *
 *  WHY NOT A REGEX STRIPPER: saavn.ts carries the MIME literal
 *  "application/json, text/plain, star-slash-star" — whose last two
 *  chars ARE a comment-OPEN sequence, and whose middle is a comment-END.
 *  Both the one-regex stripper AND a naive line machine swallowed
 *  hundreds of real lines as "comment" there — the law read an EMPTY
 *  region and passed vacuously (proven live during M-A4-2: the mutation
 *  was invisible). This stripper is a small string-aware lexer instead:
 *  quote frames ('...", `...`, with escapes), template interpolations
 *  (a frame stack, so comments can never start inside a string), and
 *  line/block comments only fire in genuine code context. */
function stripComments(src: string): string {
  type Kind = "code" | "'" | '"' | '`' | 'interp';
  const outLines: string[] = [];
  const stack: Kind[] = ['code'];
  let inBlock = false;

  for (const line of src.split('\n')) {
    let out = '';
    let i = 0;
    let done = false;
    while (i < line.length && !done) {
      const c = line[i];
      const top = stack[stack.length - 1];

      if (inBlock) {
        const end = line.indexOf('*/', i);
        if (end === -1) {
          done = true; // block persists to the next line
          break;
        }
        inBlock = false;
        out += ' ';
        i = end + 2;
        continue;
      }

      if (top === "'" || top === '"') {
        if (c === '\\') {
          out += c + (line[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (c === top) stack.pop();
        out += c;
        i += 1;
        continue;
      }
      if (top === '`') {
        if (c === '\\') {
          out += c + (line[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (c === '`') {
          stack.pop();
          out += c;
          i += 1;
          continue;
        }
        if (c === '$' && line[i + 1] === '{') {
          stack.push('interp');
          out += '${';
          i += 2;
          continue;
        }
        out += c;
        i += 1;
        continue;
      }
      // code context ('code' or 'interp')
      if (c === '/' && line[i + 1] === '/') {
        done = true; // line comment — nothing legal after this
        break;
      }
      if (c === '/' && line[i + 1] === '*') {
        const end = line.indexOf('*/', i + 2);
        if (end === -1) {
          inBlock = true;
          out += ' ';
          done = true;
          break;
        }
        out += ' ';
        i = end + 2;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        stack.push(c as Kind);
        out += c;
        i += 1;
        continue;
      }
      if (c === '}' && top === 'interp') {
        stack.pop();
        out += '}';
        i += 1;
        continue;
      }
      out += c;
      i += 1;
    }
    outLines.push(out);
  }
  return outLines.join('\n');
}

function listTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listTestFiles(full));
    else if (name.endsWith('.test.ts') || name.endsWith('.test.tsx')) out.push(full);
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fetch that NEVER settles and NEVER honors its abort signal — the
 *  worst-possible hung socket. The bounded seam must still settle. */
const hungFetch = ((_url: any, _init: any) => new Promise<Response>(() => undefined)) as unknown as typeof fetch;

/** A bounded call with a hard deadline: if the seam fails to settle, the
 *  LOCK fails fast instead of hanging the suite. */
async function settleWithin(p: Promise<unknown>, ms = 2500): Promise<unknown> {
  let result: unknown;
  let settled = false;
  await Promise.race([
    p.then((v) => {
      settled = true;
      result = v;
    }),
    sleep(ms).then(() => {
      if (!settled) throw new Error(`lock deadline: the promise did not settle within ${ms}ms`);
    }),
  ]);
  return result;
}

// ── FIX-A1 — the theatre scan ──────────────────────────────────────────
describe('FIX-A1 — every toHaveBeenCalled matcher is INVOKED (no theatre)', () => {
  test('no test file accesses a toHaveBeenCalled* matcher as a property', () => {
    const offenders: string[] = [];
    for (const file of listTestFiles(TESTS)) {
      const src = readFileSync(file, 'utf8');
      const matches = src.match(/\.toHaveBeen[A-Za-z]*\s*;/g);
      if (matches) offenders.push(`${file}: ${matches.join(' ')}`);
    }
    expect(offenders).toEqual([]);
  });

  test('the sleep-timer cancel guarantee is a REAL assertion (invoked)', () => {
    const src = readFileSync(join(TESTS, 'ai', 'godmode_locks.test.ts'), 'utf8');
    expect(src).toContain('expect(TP.pause).not.toHaveBeenCalled();');
  });
});

// ── FIX-A2 — the honest crate actions ──────────────────────────────────
describe('FIX-A2 — like-batch pure core + source laws', () => {
  test('pickUnfavorited keeps only rows not already in the crates, deduped, in order', () => {
    const t = (id: string) => ({ id, title: id, artist: 'a', artwork: '', duration: 1, source: 'saavn' } as any);
    const favs = new Set(['b']);
    const out = pickUnfavorited([t('a'), t('b'), t('a'), t('c')], favs);
    expect(out.map((x) => x.id)).toEqual(['a', 'c']);
  });

  test('pickUnfavorited on an all-favorited list answers empty (the honest ALREADY toast path)', () => {
    const t = (id: string) => ({ id, title: id, artist: 'a', artwork: '', duration: 1, source: 'saavn' } as any);
    expect(pickUnfavorited([t('x'), t('y')], new Set(['x', 'y']))).toEqual([]);
  });

  test('source law: the fake literals are gone and no toast fires directly from an onPress', () => {
    const src = stripComments(readSrc('screens', 'CollectionScreen.tsx'));
    expect(src).not.toContain('DOWNLOADING CRATE…');
    expect(src).not.toContain("message: 'ADDED TO YOUR CRATES'");
    expect(src).not.toMatch(/onPress=\{\(\) => toast\.show\(/);
  });

  test('source law: the real handlers are wired (batch like + batch download)', () => {
    const src = stripComments(readSrc('screens', 'CollectionScreen.tsx'));
    expect(src).toContain('pickUnfavorited(tracks, favorites)');
    expect(src).toContain('void likeAll()');
    expect(src).toContain('void downloadCrate()');
    expect(src).toContain('downloadTrack(');
    expect(src).toContain('await toggleLike(t)');
  });
});

// ── FIX-A3 — REAL pinning ──────────────────────────────────────────────
describe('FIX-A3 — pin round-trip (store truth, restart-proof) + ordering law', () => {
  test('pin → fresh read (the restart) → still pinned → unpin → gone', async () => {
    const pl = await createPlaylist('Round Trip Crate');
    await setPlaylistPinned(pl.id, true);
    // a fresh getPlaylists() re-reads AsyncStorage — the restart simulation
    const after = (await getPlaylists()).find((p) => p.id === pl.id);
    expect(typeof after?.pinnedAt).toBe('number');
    // unpin: the flag is REMOVED, not zeroed
    await setPlaylistPinned(pl.id, false);
    const off = (await getPlaylists()).find((p) => p.id === pl.id);
    expect(off?.pinnedAt).toBeUndefined();
  });

  test('pinning an unknown playlist id writes nothing (honest no-op)', async () => {
    await setPlaylistPinned('pl-does-not-exist', true);
    expect((await getPlaylists()).some((p) => p.id === 'pl-does-not-exist')).toBeFalse();
  });

  test('sortPlaylistsPinnedFirst: pinned lead (newest pin first), unpinned keep order', () => {
    const pl = (id: string, pinnedAt?: number) => ({ id, name: id, createdAt: 0, tracks: [], pinnedAt });
    const list = [pl('a'), pl('b', 200), pl('c'), pl('d', 100), pl('e', 300)];
    expect(sortPlaylistsPinnedFirst(list).map((p) => p.id)).toEqual(['e', 'b', 'd', 'a', 'c']);
    // no mutation of the caller's array
    expect(list.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('source law: PlaylistScreen awaits the REAL write before the toast', () => {
    const src = stripComments(readSrc('screens', 'PlaylistScreen.tsx'));
    expect(src).toContain('await setPlaylistPinned(playlistId, next)');
    expect(src.indexOf('await setPlaylistPinned')).toBeLessThan(src.indexOf("message: next ? 'PINNED TO YOUR CRATES'"));
    expect(src).not.toMatch(/onPress=\{\(\) => toast\.show\(/);
  });

  test('source law: the Library surfaces pins (pinned-first ordering + PINNED marker)', () => {
    const src = stripComments(readSrc('screens', 'LibraryScreen.tsx'));
    expect(src).toContain('sortPlaylistsPinnedFirst(');
    expect(src).toContain("p.pinnedAt ? 'PINNED · ' : ''");
  });
});

// ── FIX-A4 — bounded provider fetches ──────────────────────────────────
describe('FIX-A4 — the bounded-fetch seam', () => {
  test('a hung fetch that ignores its abort signal settles with a clean timeout error', async () => {
    const t0 = Date.now();
    let err: Error | null = null;
    try {
      await settleWithin(fetchWithTimeout('https://hung.test/x', {}, { timeoutMs: 40, fetchImpl: hungFetch }));
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(String(err?.message)).toContain('timeout');
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test('an outer abort cancels the request the moment it fires', async () => {
    const ctrl = new AbortController();
    let err: Error | null = null;
    const t0 = Date.now();
    const p = fetchWithTimeout('https://hung.test/y', { signal: ctrl.signal }, { timeoutMs: 30_000, fetchImpl: hungFetch });
    setTimeout(() => ctrl.abort(), 20);
    try {
      await settleWithin(p);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(String(err?.message)).toContain('abort');
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test('an already-aborted signal never opens a request', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let opened = false;
    const spy = ((_u: any, _i: any) => {
      opened = true;
      return Promise.resolve(new Response('{}'));
    }) as unknown as typeof fetch;
    let err: Error | null = null;
    try {
      await fetchWithTimeout('https://x.test/z', { signal: ctrl.signal }, { fetchImpl: spy });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(opened).toBeFalse();
  });

  test('a healthy fetch resolves and the timer does not fire late', async () => {
    const quick = ((_u: any, _i: any) => Promise.resolve(new Response('{"ok":true}'))) as unknown as typeof fetch;
    const res = (await settleWithin(
      fetchWithTimeout('https://ok.test/a', {}, { timeoutMs: 5000, fetchImpl: quick }),
    )) as Response;
    expect(res.status).toBe(200);
  });

  test('source law: no bare fetch remains in the provider hot paths', () => {
    expect(stripComments(readSrc('api', 'saavn.ts'))).not.toMatch(/await fetch\(/);
    expect(stripComments(readSrc('api', 'youtube.ts'))).not.toMatch(/await ytFetch\(/);
    const yt = stripComments(readSrc('api', 'youtube.ts'));
    const bounded = yt.match(/fetchWithTimeout\(/g) ?? [];
    expect(bounded.length).toBeGreaterThanOrEqual(3); // visitor_id + innertube + player-js
    expect(stripComments(readSrc('api', 'itunes.ts'))).not.toMatch(/await fetch\(/);
  });

  test('source law: the 10s budget lives in constants.ts (house law 4) and the seam reads it', () => {
    expect(PROVIDER_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(stripComments(readSrc('api', 'fetchWithTimeout.ts'))).toContain('PROVIDER_FETCH_TIMEOUT_MS');
  });
});

// ── FIX-A5 — the itunes signal is honored end-to-end ───────────────────
describe('FIX-A5 — searchItunes aborts end-to-end (no more _signal lie)', () => {
  test('abort mid-fetch cancels the search promptly', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = hungFetch as unknown as typeof fetch;
    try {
      const ctrl = new AbortController();
      const t0 = Date.now();
      let err: Error | null = null;
      const p = searchItunes('tum hi ho', 5, ctrl.signal);
      setTimeout(() => ctrl.abort(), 20);
      try {
        await settleWithin(p);
      } catch (e) {
        err = e as Error;
      }
      expect(err).not.toBeNull();
      expect(String(err?.message)).toContain('abort');
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      globalThis.fetch = realFetch; // hygiene: the seam is restored even on RED
    }
  });

  test('source law: `_signal` is gone — the signature keeps and threads a real signal', () => {
    const src = stripComments(readSrc('api', 'itunes.ts'));
    expect(src).not.toContain('_signal');
    expect(src).toMatch(/signal\?: AbortSignal/);
    expect(src).toContain('fetchWithTimeout(');
    expect(src).toMatch(/\{ signal \}/);
  });
});
