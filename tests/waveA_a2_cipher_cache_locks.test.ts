/**
 * WAVE A · A2 — the cold-boot YouTube cipher cache locks.
 *
 * Three evidence classes:
 *
 *  1. PURE round-trip over injected in-memory deps: save → load returns
 *     the same body; expiry returns null; corrupt JSON returns null; a
 *     foreign jsPath never answers for another build; the key is a
 *     deterministic function of the path (FNV-1a oracle recomputed
 *     independently in this file).
 *
 *  2. REAL END-TO-END over the module's own fetch seam (setYtFetch):
 *     a signatureCipher player fixture + a real decipherable base.js —
 *     the first resolution fetches base.js ONCE and persists the parsed
 *     program; after clearYtCaches() (the cold-boot simulation: RAM
 *     drained, KV survives) the second resolution answers from the
 *     cache — base.js is STILL fetched exactly once, and the deciphered
 *     URL is byte-identical. This is the mission bar verbatim: "Cold
 *     boot with valid cache skips the base.js fetch entirely."
 *
 *  3. WIRING locks: the RAM→KV→fetch order in getDecipherer, the
 *     best-effort save, and clearYtCaches draining the RAM decipher
 *     (a cold-boot simulation, not a full wipe).
 *
 * Mutations proven RED (worklog):
 *  M-A2-1  the KV load block removed from getDecipherer → test 2 fails
 *          (second resolution re-fetches base.js);
 *  M-A2-2  the TTL check removed from loadCipherCache → the expiry test
 *          fails (a stale program would ride forever);
 *  M-A2-3  the save call removed → the persistence round-trip fails.
 */

import { describe, expect, test, beforeEach, afterAll, mock } from 'bun:test';

// The e2e path uses the PRODUCTION deps — makeAsyncStorageDeps()
// lazy-requires AsyncStorage at decipher time. The mock (the established
// pattern) backs that package with the SAME in-memory map the pure tests
// use, so the whole ladder — save → cold boot → load — runs for real.
const memKv = new Map<string, string>();
mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => memKv.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      memKv.set(k, v);
    },
    removeItem: async (k: string) => {
      memKv.delete(k);
    },
  },
}));
const deps = {
  getRaw: async (k: string) => memKv.get(k) ?? null,
  setRaw: async (k: string, v: string) => {
    memKv.set(k, v);
  },
  now: () => NOW,
};
let NOW = 1_700_000_000_000;

const {
  cipherCacheKey,
  saveCipherCache,
  loadCipherCache,
  CIPHER_CACHE_TTL_MS,
} = await import('../src/api/ytCipherCache');

const {
  setYtFetch,
  ytResolveStream,
  clearYtCaches,
  resetYtKillSwitch,
} = await import('../src/api/youtube');

// R7 hygiene — restore the default seam when this file ends.
afterAll(() => setYtFetch(null));

beforeEach(() => {
  NOW = 1_700_000_000_000;
  memKv.clear();
  resetYtKillSwitch();
  clearYtCaches();
});

// ── 1. the pure round-trip ──────────────────────────────────────────────

describe('WAVE A · A2 — cipher cache: the pure round-trip', () => {
  test('save → load returns the same body for the same path', async () => {
    await saveCipherCache(deps, '/s/player/v1/base.js', 'var h={};f=function(a){return a};');
    const entry = await loadCipherCache(deps, '/s/player/v1/base.js');
    expect(entry).not.toBeNull();
    expect(entry!.jsPath).toBe('/s/player/v1/base.js');
    expect(entry!.body).toBe('var h={};f=function(a){return a};');
    expect(entry!.expiresAt).toBe(NOW + CIPHER_CACHE_TTL_MS);
  });

  test('an expired entry (6h TTL) returns null — the fetch path answers', async () => {
    await saveCipherCache(deps, '/s/player/v1/base.js', 'BODY');
    NOW += 6 * 60 * 60 * 1000; // exactly at the edge — expiry is >=
    expect(await loadCipherCache(deps, '/s/player/v1/base.js')).toBeNull();
  });

  test('a corrupt payload returns null — never throws, the fetch answers', async () => {
    const key = cipherCacheKey('/s/player/v1/base.js');
    memKv.set(key, '{not json at all');
    expect(await loadCipherCache(deps, '/s/player/v1/base.js')).toBeNull();
    memKv.set(key, 'null');
    expect(await loadCipherCache(deps, '/s/player/v1/base.js')).toBeNull();
  });

  test('a program is only valid for ITS build (foreign jsPath → null)', async () => {
    await saveCipherCache(deps, '/s/player/v1/base.js', 'BODY-V1');
    expect(await loadCipherCache(deps, '/s/player/v2/base.js')).toBeNull();
  });

  test('the key is a deterministic function of the path (FNV-1a oracle)', () => {
    const fnv1a = (s: string): string => {
      let h = 2166136261;
      for (let i = 0; i < s.length; i += 1) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0).toString(16);
    };
    const p1 = '/s/player/4a5b6c7d/base.js';
    const p2 = '/s/player/8e9f0a1b/base.js';
    expect(cipherCacheKey(p1)).toBe(`tsf.ytCipher.${fnv1a(p1)}`);
    expect(cipherCacheKey(p1)).toBe(cipherCacheKey(p1)); // stable across calls
    expect(cipherCacheKey(p1)).not.toBe(cipherCacheKey(p2)); // distinct builds never collide
  });
});

// ── 2. the real end-to-end: a cold boot skips the base.js fetch ─────────

// A REAL decipherable player JS — the regex in getDecipherer matches
// `_qWz=function(a){a=a.split("")`, the helper `_qf` is extracted, and
// the assembled program actually deciphers: s='BADCODE12' → reverse →
// splice(0,2) → 'EDOCAB'.
const BASE_JS = [
  'var _qf={reverse:function(a){a.reverse()},splice:function(a,b){a.splice(0,b)}};',
  '_qWz=function(a){a=a.split("");_qf.reverse(a,4);_qf.splice(a,2);return a.join("")};',
].join('\n');

const JS_PATH = '/s/player/v4a1b2c3/base.js';

function cipherPlayer(videoId: string) {
  // signatureCipher is a normal query string — only the base URL inside it
  // is percent-encoded (that is how the real InnerTube payload ships it).
  const sig =
    's=BADCODE12&sp=sig&url=' +
    encodeURIComponent('https://rr1.example.googlevideo.com/videoplayback?id=' + videoId);
  return {
    playabilityStatus: { status: 'OK' },
    assets: { js: JS_PATH },
    streamingData: {
      adaptiveFormats: [
        { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 129703, signatureCipher: sig },
      ],
    },
  };
}

type Route = (url: string) => { status: number; json?: any; text?: string } | undefined;

function makeFetch(routes: Route[]) {
  const calls: string[] = [];
  const impl = (url: any) => {
    const u = String(url);
    calls.push(u);
    for (const r of routes) {
      const out = r(u);
      if (out) {
        const body = out.text ?? JSON.stringify(out.json ?? {});
        return Promise.resolve(new Response(body, { status: out.status }));
      }
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

const isPlayer = (u: string) => u.includes('youtubei/v1/player');
const isBaseJs = (u: string) => u.includes('/s/player/') && u.endsWith('.js');

describe('WAVE A · A2 — cold boot with a valid cache skips the base.js fetch entirely', () => {
  test('first boot fetches base.js once; SECOND boot (RAM drained, KV alive) fetches it ZERO times', async () => {
    const f = makeFetch([
      (u) => (isPlayer(u) ? { status: 200, json: cipherPlayer('q1') } : undefined),
      (u) => (isBaseJs(u) ? { status: 200, text: BASE_JS } : undefined),
    ]);
    setYtFetch(f.impl);

    // ── boot 1: cold, empty KV ──
    const r1 = await ytResolveStream('q1');
    expect(r1.ok).toBe(true);
    const baseFetches1 = f.calls.filter(isBaseJs).length;
    expect(baseFetches1).toBe(1);
    expect(r1.audio?.url).toContain('sig=EDOCDAB'); // the decipher really deciphered (BADCODE12 → reverse → splice(0,2))
    // the parsed program rode into the KV
    expect(memKv.get(cipherCacheKey(JS_PATH))).toBeTruthy();

    // ── boot 2: the cold-boot simulation — RAM caches drained (the hook
    // now drains the decipher too), the persisted KV survives ──
    clearYtCaches();
    const callsAfterBoot1 = f.calls.length;
    const r2 = await ytResolveStream('q1');
    expect(r2.ok).toBe(true);
    expect(r2.audio?.url).toContain('sig=EDOCDAB'); // byte-identical answer
    const newBaseFetches = f.calls.slice(callsAfterBoot1).filter(isBaseJs).length;
    expect(newBaseFetches).toBe(0); // ← THE BAR: the fetch is skipped entirely
  });

  test('an expired cache entry triggers a FRESH fetch (6h TTL is real)', async () => {
    const f = makeFetch([
      (u) => (isPlayer(u) ? { status: 200, json: cipherPlayer('q2') } : undefined),
      (u) => (isBaseJs(u) ? { status: 200, text: BASE_JS } : undefined),
    ]);
    setYtFetch(f.impl);

    await ytResolveStream('q2');
    clearYtCaches();
    // age the persisted entry past the TTL
    const key = cipherCacheKey(JS_PATH);
    const entry = JSON.parse(memKv.get(key)!);
    entry.expiresAt = Date.now() - 1;
    memKv.set(key, JSON.stringify(entry));

    const before = f.calls.filter(isBaseJs).length;
    const r = await ytResolveStream('q2');
    expect(r.ok).toBe(true);
    expect(f.calls.filter(isBaseJs).length).toBe(before + 1); // fresh fetch happened
  });
});

// ── 3. the wiring is the ordered ladder RAM → KV → fetch ────────────────

describe('WAVE A · A2 — wiring locks (getDecipherer + the cold-boot hook)', () => {
  const fs = require('fs');
  const src = fs.readFileSync('src/api/youtube.ts', 'utf8');

  test('the cache check sits BETWEEN the RAM cache and the fetch', () => {
    const fnStart = src.indexOf('async function getDecipherer');
    const fnEnd = src.indexOf('/** Resolve signatureCipher');
    const fnBody = src.slice(fnStart, fnEnd);
    expect(fnBody).toContain('loadCipherCache');
    expect(fnBody.indexOf('decipherCache && decipherCache.jsPath === jsPath')).toBeLessThan(fnBody.indexOf('loadCipherCache'));
    const fetchAt = fnBody.indexOf('fetchWithTimeout(`https://www.youtube.com${jsPath}`'); // v5.2.1 FIX-A4: the fetch rides the bounded seam now
    expect(fetchAt).toBeGreaterThan(-1); // the bounded expression is still the fetch marker
    expect(fnBody.indexOf('loadCipherCache')).toBeLessThan(fetchAt); // the ORDER the lock pins: RAM → KV → fetch
    expect(fnBody).toContain('saveCipherCache'); // save lives in the same fn (after the parse)
  });

  test('the save is best-effort (wrapped, never blocks resolution)', () => {
    const fnBody = src.slice(src.indexOf('async function getDecipherer'), src.indexOf('/** Resolve signatureCipher'));
    const saveAt = fnBody.indexOf('await saveCipherCache');
    const tryAt = fnBody.lastIndexOf('try {', saveAt);
    expect(tryAt).toBeGreaterThan(-1);
    expect(fnBody.slice(saveAt)).toContain('best-effort persistence');
  });

  test('clearYtCaches drains the RAM decipher — a cold-boot simulation (KV survives by design)', () => {
    const hook = src.slice(src.indexOf('export function clearYtCaches'));
    expect(hook).toContain('decipherCache = null');
  });

  test('the tuning number lives in constants (law ④), not inline', () => {
    expect(require('fs').readFileSync('src/api/ytCipherCache.ts', 'utf8')).toContain('YT_CIPHER.ttlMs');
  });
});
