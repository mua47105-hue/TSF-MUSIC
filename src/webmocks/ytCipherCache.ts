/**
 * WEB MOCK of src/api/ytCipherCache.ts (house rule 15 parity — X4).
 *
 * The web harness never decipheres (webmocks/youtube.ts serves pre-signed
 * fixture URLs), so this twin exists to keep the export surfaces
 * identical and to give the harness an in-memory KV if it ever wants the
 * round-trip. The PURE functions are re-exported from the real module —
 * they are dependency-free by design (deps injected, AsyncStorage only
 * lazy-required inside the production factory, which this twin never
 * calls).
 */

export {
  CIPHER_CACHE_TTL_MS,
  cipherCacheKey,
  saveCipherCache,
  loadCipherCache,
} from '../api/ytCipherCache';
export type { CipherCacheEntry, CipherCacheDeps } from '../api/ytCipherCache';

/** The harness KV: a plain Map. Same deps shape as production. */
const mem = new Map<string, string>();

export function memoryCipherCacheDeps() {
  return {
    getRaw: async (key: string) => mem.get(key) ?? null,
    setRaw: async (key: string, value: string) => {
      mem.set(key, value);
    },
    now: () => Date.now(),
  };
}

/** Production-shaped factory for the harness (AsyncStorage-free). */
export function makeAsyncStorageDeps() {
  return memoryCipherCacheDeps();
}
