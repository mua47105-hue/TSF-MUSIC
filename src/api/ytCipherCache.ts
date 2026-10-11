/**
 * YT CIPHER CACHE (WAVE A · A2) — the parsed decipher program survives
 * cold boots, so the DAILY cold boot skips the ~300KB base.js fetch and
 * the regex/brace parse and goes straight to `new Function` construction.
 *
 * Mission sketch vs shipped reality, stated honestly: the sketch named a
 * youtube-dl-style `{sts, ops[]}` tuple. THIS codebase's decipherer
 * (src/api/youtube.ts getDecipherer) assembles a SELF-CONTAINED JS
 * program — helper object decl + the decipher fn verbatim + the return
 * line — and hands it to `new Function('s', body)`. There are no
 * sts/ops to extract (that is a different extractor design), so the
 * cached artifact is the assembled program BODY: the exact string the
 * `new Function` call consumes. Same work saved, honestly described.
 *
 * LAWS:
 *  - Injectable deps (getRaw/setRaw/now) — the pure core is testable
 *    with in-memory maps; production injects AsyncStorage.
 *  - Production deps LAZY-require AsyncStorage inside the factory: the
 *    api layer must not open a second SQLite handle to mindbeat.db (its
 *    single owner is mindbeat), and AsyncStorage must never enter the
 *    youtube.ts import chain (suite + cold-path hygiene).
 *  - Every failure degrades to the fetch: a miss, an expired entry, a
 *    corrupt payload, or a body that refuses to eval can only cost the
 *    old path, never become a new failure mode.
 *  - Deterministic keying: FNV-1a over the player-JS path — same path
 *    ⇒ same key across boots, no Math.random, no Date in the key.
 *
 * Web parity (house rule 15): the pure functions are re-exported by
 * src/webmocks/ytCipherCache.ts (in-memory KV) so the export surfaces
 * stay identical; the web harness never decipheres (fixture URLs).
 */

import { YT_CIPHER } from '../ai/core/constants';

export interface CipherCacheEntry {
  /** The player-JS path the program was parsed from (e.g. /s/player/<build>/base.js). */
  jsPath: string;
  /** The assembled program body — exactly what `new Function('s', body)` receives. */
  body: string;
  /** Absolute expiry (deps.now() + TTL at save time). */
  expiresAt: number;
}

export interface CipherCacheDeps {
  getRaw(key: string): Promise<string | null>;
  setRaw(key: string, value: string): Promise<void>;
  now(): number;
}

export const CIPHER_CACHE_TTL_MS = YT_CIPHER.ttlMs;

/** FNV-1a (32-bit) — tiny, deterministic, stable across boots/runtimes. */
function hashPath(jsPath: string): string {
  let h = 2166136261;
  for (let i = 0; i < jsPath.length; i += 1) {
    h ^= jsPath.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

/** The KV key for one player-JS path — "URL path hash", per the bar. */
export function cipherCacheKey(jsPath: string): string {
  return `tsf.ytCipher.${hashPath(jsPath)}`;
}

/** Persist the parsed program (6h TTL). Empty inputs are an honest no-op. */
export async function saveCipherCache(
  deps: CipherCacheDeps,
  jsPath: string,
  body: string,
): Promise<void> {
  if (!jsPath || !body) return;
  const entry: CipherCacheEntry = {
    jsPath,
    body,
    expiresAt: deps.now() + CIPHER_CACHE_TTL_MS,
  };
  await deps.setRaw(cipherCacheKey(jsPath), JSON.stringify(entry));
}

/**
 * Load the cached program for one path — null on miss, expiry, corrupt
 * JSON, shape mismatch, or a storage read failure. The caller fetches
 * fresh on null; nothing here can throw.
 */
export async function loadCipherCache(
  deps: CipherCacheDeps,
  jsPath: string,
): Promise<CipherCacheEntry | null> {
  let raw: string | null = null;
  try {
    raw = await deps.getRaw(cipherCacheKey(jsPath));
  } catch {
    return null;
  }
  if (!raw) return null;
  let entry: CipherCacheEntry | null = null;
  try {
    entry = JSON.parse(raw) as CipherCacheEntry;
  } catch {
    return null; // corrupt payload → the fetch path answers
  }
  if (!entry || typeof entry.body !== 'string' || !entry.body) return null;
  if (entry.jsPath !== jsPath) return null; // a program is only valid for ITS build
  if (!(typeof entry.expiresAt === 'number') || deps.now() >= entry.expiresAt) {
    return null; // expired → a fresh fetch, exactly the bar
  }
  return entry;
}

/** Production deps — AsyncStorage, required LAZILY (never on the module
 *  graph of a suite that does not decipher; never at boot). */
export function makeAsyncStorageDeps(): CipherCacheDeps {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AsyncStorage = require('@react-native-async-storage/async-storage').default;
  return {
    getRaw: (key) => AsyncStorage.getItem(key),
    setRaw: (key, value) => AsyncStorage.setItem(key, value),
    now: () => Date.now(),
  };
}
