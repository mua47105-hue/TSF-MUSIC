/**
 * SEARCH V2 · LRCLIB client — free/open lyrics lookup for S2 V2
 * lyric verification (https://lrclib.net).
 *
 * Contract (plan §8): single export `fetchPlainLyrics(title, artist)`;
 * LRU-100 + in-flight dedupe; 5 s timeout; NEVER throws (null on any
 * failure). The caller's AbortSignal is honored end-to-end (P0-3 fix):
 * aborted generations cancel in-flight fetches immediately and never
 * write the cache. Privacy: only candidate title+artist leave the
 * device — never the user's query, ledger or profile (same class as
 * the catalog call itself).
 */

const LRU_MAX = 100;
const NULL_TTL_MS = 60 * 1000; // failures tombstone briefly (P1-8 fix)
const HIT_TTL_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 5000;
const UA = 'TSF-Music/3.3 (https://github.com/mua47105-hue/TSF-MUSIC)';

interface CacheEntry {
  at: number;
  lyrics: string | null;
  /** raw synced LRC ([mm:ss.xx] line) — null when the row carries none */
  synced: string | null;
}

const cache = new Map<string, CacheEntry>(); // insertion-ordered LRU
const inFlight = new Map<string, Promise<CacheEntry>>();

function lruGet(key: string, now: number): CacheEntry | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  const hasAny = hit.lyrics != null || hit.synced != null;
  const ttl = hasAny ? HIT_TTL_MS : NULL_TTL_MS;
  if (now - hit.at >= ttl) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, hit); // refresh recency
  return hit;
}

function lruSet(key: string, entry: CacheEntry): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, entry);
  if (cache.size > LRU_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Link the caller's signal to our timeout controller. */
function linkAbort(external: AbortSignal | undefined, ctrl: AbortController): void {
  if (!external) return;
  if (external.aborted) {
    ctrl.abort();
    return;
  }
  const onAbort = () => ctrl.abort();
  external.addEventListener('abort', onAbort, { once: true });
  // stop listening when our own timeout fires (no leak)
  ctrl.signal.addEventListener('abort', () => external.removeEventListener('abort', onAbort), {
    once: true,
  });
}

/**
 * One catalog lookup that returns BOTH lyric shapes. The S2 pipeline and
 * the plain card read `.lyrics`; the sing-along card reads `.synced`.
 * Same two-shot search as before, same row discipline: the FIRST row is
 * the song match — plain and synced are read from that row independently
 * (never borrow synced from a different row: a cover version's timings
 * would be a lie).
 */
async function fetchBoth(title: string, artist: string, external?: AbortSignal): Promise<CacheEntry> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  linkAbort(external, ctrl);
  try {
    // two-shot: precise track/artist query first, then free-form fallback
    const qs1 = new URLSearchParams({ track_name: title, artist_name: artist });
    const qs2 = new URLSearchParams({ q: `${title} ${artist}` });
    for (const qs of [qs1, qs2]) {
      if (ctrl.signal.aborted) return { at: Date.now(), lyrics: null, synced: null };
      const res = await fetch(`https://lrclib.net/api/search?${qs.toString()}`, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: ctrl.signal,
      });
      if (!res.ok) continue;
      const rows = (await res.json()) as Array<unknown>;
      if (Array.isArray(rows) && rows.length > 0) {
        const first = rows[0] as { plainLyrics?: string; syncedLyrics?: string };
        const plain = first?.plainLyrics || first?.syncedLyrics || '';
        const synced = first?.syncedLyrics || '';
        if (plain || synced) {
          return { at: Date.now(), lyrics: plain || null, synced: synced || null };
        }
      }
    }
    return { at: Date.now(), lyrics: null, synced: null };
  } catch {
    // unreachable/blocked/timeout/aborted — silent by contract
    return { at: Date.now(), lyrics: null, synced: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch plain lyrics for a candidate track. Null on any failure.
 * Cached (LRU-100) + in-flight deduped; never rejects; honors the
 * caller's AbortSignal (aborted calls return null immediately).
 */
export function fetchPlainLyrics(
  title: string,
  artist: string,
  signal?: AbortSignal,
): Promise<string | null> {
  return resolveBoth(title, artist, signal).then((entry) => entry.lyrics);
}

/** Shared resolve path: cache → in-flight → fetchBoth (aborts never cache). */
function resolveBoth(title: string, artist: string, signal?: AbortSignal): Promise<CacheEntry> {
  if (signal?.aborted) {
    return Promise.resolve({ at: Date.now(), lyrics: null, synced: null });
  }
  const key = `${title.toLowerCase().trim()}|${artist.toLowerCase().trim()}`;
  const now = Date.now();
  const cached = lruGet(key, now);
  if (cached) return Promise.resolve(cached);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = fetchBoth(title, artist, signal).then((entry) => {
    // aborted generations never write the cache (P0-3)
    if (!signal?.aborted) lruSet(key, entry);
    return entry;
  });
  // fetchBoth never rejects, but guard anyway — and always clear the
  // in-flight slot via a tracked chain (no floating promise)
  const guarded = p.catch(() => ({ at: Date.now(), lyrics: null, synced: null }));
  void guarded.finally(() => inFlight.delete(key));
  inFlight.set(key, guarded);
  return guarded;
}

/**
 * Fetch RAW SYNCED lyrics (LRC: `[mm:ss.xx] line`) for the sing-along
 * card. Same contract as fetchPlainLyrics: null on any failure, LRU-100,
 * in-flight deduped, never rejects, honors the caller's AbortSignal.
 * Shares ONE catalog call with fetchPlainLyrics (same cache + in-flight).
 */
export function fetchSyncedLyrics(
  title: string,
  artist: string,
  signal?: AbortSignal,
): Promise<string | null> {
  return resolveBoth(title, artist, signal).then((entry) => entry.synced);
}

// ── S1 · fragment resolution ───────────────────────────────────────────

export interface LyricOrigin {
  title: string;
  artist: string;
  line: string;
}

const originCache = new Map<string, { at: number; origin: LyricOrigin | null }>();

/**
 * Resolve WHICH SONG a lyric fragment belongs to (S1): one free-form
 * LRCLIB search on the fragment, then the first result whose lyrics
 * actually CONTAIN the fragment (word membership ≥70%). Bounded,
 * silent-fail, LRU-30, lyric-mode only.
 *
 * Privacy: the fragment goes to LRCLIB exactly as it goes to JioSaavn —
 * a public catalog lookup of what the user typed. Listening history,
 * ledger and profile NEVER leave the device (README privacy section).
 */
export async function searchLyricByFragment(
  fragment: string,
  signal?: AbortSignal,
): Promise<LyricOrigin | null> {
  if (signal?.aborted || fragment.trim().length < 4) return null;
  const key = fragment.toLowerCase().trim();
  const hit = originCache.get(key);
  if (hit && Date.now() - hit.at < (hit.origin ? HIT_TTL_MS : NULL_TTL_MS)) return hit.origin;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  linkAbort(signal, ctrl);
  try {
    const qs = new URLSearchParams({ q: fragment });
    const res = await fetch(`https://lrclib.net/api/search?${qs.toString()}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{
      trackName?: string;
      artistName?: string;
      plainLyrics?: string;
      syncedLyrics?: string;
    }>;
    if (!Array.isArray(rows)) return null;
    const fragTokens = key.split(/\W+/).filter((t) => t.length >= 3);
    if (fragTokens.length === 0) return null;
    for (const row of rows.slice(0, 8)) {
      const lyrics = row.plainLyrics || row.syncedLyrics || '';
      if (!lyrics || !row.trackName || !row.artistName) continue;
      const wordSet = new Set(lyrics.toLowerCase().split(/\W+/));
      const hits = fragTokens.filter((t) => wordSet.has(t)).length;
      if (hits / fragTokens.length >= 0.7) {
        const origin: LyricOrigin = {
          title: row.trackName,
          artist: row.artistName,
          line: lyrics.split(/\r?\n/).find((l) => l.trim()) ?? '',
        };
        originCache.set(key, { at: Date.now(), origin });
        return origin;
      }
    }
    originCache.set(key, { at: Date.now(), origin: null });
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
