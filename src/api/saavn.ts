/**
 * JioSaavn provider — runs 100% on-device. No server, no proxy.
 *
 * React Native has no CORS restrictions, so the app talks to JioSaavn's
 * public web API directly, decrypts stream URLs locally (DES-ECB, pure-JS
 * crypto-js) and hands the resulting 320 kbps AAC CDN URL to the native
 * player.
 */

import CryptoJS from 'crypto-js';
import type { Collection, Track } from '../types';
import { filterClean, isClean } from '../safety';
import { recordingKey, reconcileRecordings } from './recording';

const API = 'https://www.jiosaavn.com/api.php';
const DES_KEY = CryptoJS.enc.Utf8.parse('38346591');
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
  Accept: 'application/json, text/plain, */*',
};

/** Every provider GET gets a hard ceiling — a hung fetch on a flaky
 *  mobile network used to spin shelves forever (user-reported: playlists
 *  and charts "sometimes not loading"). Overridable for tests. */
export const SAAVN_TIMEOUT_MS = 10_000;

/** Compose the caller's signal (if any) with our own timeout/abort source. */
function linkedSignal(signal: AbortSignal | undefined, ms: number): { sig: AbortSignal; done: () => void } {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('saavn: timeout')), ms);
  const onOuter = () => ctl.abort(new Error('saavn: caller aborted'));
  if (signal) {
    if (signal.aborted) ctl.abort(signal.reason);
    else signal.addEventListener('abort', onOuter, { once: true });
  }
  return {
    sig: ctl.signal,
    done: () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onOuter);
    },
  };
}

export async function saavnGet(
  params: Record<string, string>,
  signal?: AbortSignal,
  timeoutMs: number = SAAVN_TIMEOUT_MS,
): Promise<any> {
  const qs = new URLSearchParams({
    _format: 'json',
    _marker: '0',
    api_version: '4',
    ctx: 'web6dot0',
    ...params,
  });
  // ONE honest retry: a dropped packet should not blank a shelf. Caller
  // aborts are never retried (the user navigated away — respect that).
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw new Error('saavn: aborted');
    const link = linkedSignal(signal, timeoutMs);
    try {
      const res = await fetch(`${API}?${qs.toString()}`, {
        headers: BROWSER_HEADERS,
        signal: link.sig,
      });
      if (!res.ok) {
        // 5xx = provider blip → retry once; 4xx = our request is wrong → fail now
        if (res.status >= 500 && attempt === 0) {
          lastErr = new Error(`saavn ${res.status}`);
          continue;
        }
        throw new Error(`saavn ${res.status}`);
      }
      const text = await res.text();
      // JioSaavn occasionally prefixes junk before the JSON body.
      const start = text.indexOf('{');
      const arr = text.indexOf('[');
      const from = start === -1 ? arr : arr === -1 ? start : Math.min(start, arr);
      if (from === -1) throw new Error('saavn: no json');
      return JSON.parse(text.slice(from));
    } catch (e) {
      lastErr = e;
      const msg = String((e as any)?.message ?? e);
      const callerAborted = !!signal?.aborted;
      const ourTimeout = msg.includes('saavn: timeout');
      const network = e instanceof TypeError || msg.includes('NetworkService') || msg.includes('Failed to fetch');
      if (callerAborted) throw e;
      if (attempt === 0 && (ourTimeout || network)) continue; // one honest retry
      throw e;
    } finally {
      link.done();
    }
  }
  throw lastErr ?? new Error('saavn: unreachable');
}

/** DES-ECB decrypt a JioSaavn encrypted_media_url into a playable CDN url. */
export function decryptMediaUrl(encrypted?: string): string | null {
  if (!encrypted) return null;
  try {
    const bytes = CryptoJS.DES.decrypt(
      { ciphertext: CryptoJS.enc.Base64.parse(encrypted) } as any,
      DES_KEY,
      { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 },
    );
    const url = bytes.toString(CryptoJS.enc.Utf8);
    return url && url.startsWith('http') ? url : null;
  } catch {
    return null;
  }
}

/** Resolve the highest-quality playable URL for a track. */
export function resolveStreamUrl(track: Track): string | null {
  if (track.localUri) return track.localUri;
  const base = decryptMediaUrl(track.encryptedUrl) ?? track.previewUrl ?? null;
  if (!base) return null;
  // Upgrade to 320 kbps only when the provider says it exists.
  if (track.has320 === false) return base;
  return base.replace('_96.mp4', '_320.mp4').replace('_160.mp4', '_320.mp4');
}

/** Ask JioSaavn for a fresh encrypted url (used to recover expired streams). */
export async function refreshStreamUrl(track: Track): Promise<string | null> {
  if (!track.saavnId) return null;
  try {
    const data = await saavnGet({ __call: 'song.getDetails', pids: track.saavnId });
    const songs = Array.isArray(data?.songs) ? data.songs : data ? [data] : [];
    const song = songs[0];
    const enc = song?.more_info?.encrypted_media_url ?? song?.encrypted_media_url;
    const fresh = decryptMediaUrl(enc);
    if (!fresh) return null;
    const has320 = song?.more_info?.['320kbps'] === 'true' || song?.['320kbps'] === 'true';
    if (!has320) return fresh;
    return fresh.replace('_96.mp4', '_320.mp4').replace('_160.mp4', '_320.mp4');
  } catch {
    /* fall through */
  }
  return null;
}

/** Upgrade 150x150 artwork to 500x500 CDN variants. */
function art500(image?: string): string {
  if (!image) return '';
  return image
    .replace('150x150', '500x500')
    .replace('50x50', '500x500')
    .replace(/^http:/, 'https:');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function truthyExplicit(v: unknown): boolean {
  return v === '1' || v === 1 || v === true || v === 'true';
}

function mapSaavnSong(raw: any): Track | null {
  const mi = raw?.more_info ?? raw ?? {};
  const id = raw?.id ?? mi?.id;
  const enc = mi?.encrypted_media_url ?? raw?.encrypted_media_url;
  if (!id || !enc) return null;
  const artistMap = mi?.artistMap ?? {};
  const primaryList: any[] = Array.isArray(artistMap.primary_artists)
    ? artistMap.primary_artists
    : [];
  const featuredList: any[] = Array.isArray(artistMap.featured_artists)
    ? artistMap.featured_artists
    : [];
  // v2 display fix: the FULL primary list is the artist string — fixes
  // "Apna Bana Le" showing only its lyricist. Fallback chain keeps v1
  // behavior for rows without artistMap.
  const artistsFull = primaryList
    .map((a) => (typeof a?.name === 'string' ? decodeEntities(a.name) : ''))
    .filter(Boolean);
  const primaryArtist = primaryList[0];
  const artist =
    artistsFull.length > 0
      ? artistsFull.join(', ')
      : primaryArtist?.name ||
        mi?.primary_artists ||
        raw?.subtitle ||
        'Unknown artist';
  return {
    id: `saavn-${id}`,
    title: decodeEntities(raw?.title ?? mi?.title ?? 'Unknown'),
    artist: decodeEntities(String(artist)),
    artistsFull: artistsFull.length ? artistsFull : undefined,
    featuredArtists: featuredList
      .map((a) => (typeof a?.name === 'string' ? decodeEntities(a.name) : ''))
      .filter(Boolean),
    hasLyrics: truthyExplicit(mi?.has_lyrics) || undefined,
    lyricsSnippet:
      typeof mi?.lyrics_snippet === 'string' && mi.lyrics_snippet
        ? decodeEntities(mi.lyrics_snippet)
        : undefined,
    album: mi?.album ?? raw?.album ?? undefined,
    albumId: String(mi?.album_id ?? raw?.album_id ?? '') || undefined,
    artistId: primaryArtist?.id ? String(primaryArtist.id) : undefined,
    artwork: art500(mi?.image ?? raw?.image),
    duration: parseInt(mi?.duration ?? raw?.duration ?? '0', 10) || 0,
    source: 'saavn',
    saavnId: String(id),
    encryptedUrl: enc,
    previewOnly: false,
    has320: mi?.['320kbps'] === 'true' || raw?.['320kbps'] === 'true' || undefined,
    explicit: truthyExplicit(mi?.explicit_content ?? raw?.explicit_content),
    language: String(mi?.language ?? raw?.language ?? '').toLowerCase() || undefined,
    year: parseInt(mi?.year ?? raw?.year ?? '0', 10) || undefined,
    playCount: Number(raw?.play_count ?? mi?.play_count ?? 0) || undefined,
    releaseDate:
      typeof (mi?.release_date ?? raw?.release_date) === 'string'
        ? (mi?.release_date ?? raw?.release_date)
        : undefined,
  };
}

export async function searchSaavn(
  query: string,
  limit = 30,
  signal?: AbortSignal,
  page = 1,
): Promise<Track[]> {
  const data = await saavnGet(
    {
      __call: 'search.getResults',
      q: query,
      p: String(page),
      n: String(limit),
    },
    signal,
  );
  const results = Array.isArray(data?.results) ? data.results : [];
  // R8-P4: a raw JioSaavn page re-lists the SAME recording under many
  // ids (movie album + compilations + regional presses — the "Zalima
  // 5-6 times in one Top Songs list" bug). Collapse by id AND by
  // recording key, keep the provider's order.
  return dedupeRecordings(results.map(mapSaavnSong).filter(Boolean) as Track[]);
}

/** Collapse rows that share a recording key (normalized title + primary
 *  artist), keeping first occurrence and the input order — then the
 *  R8-P4b reconciliation pass collapses same-title rows whose CREDIT
 *  SETS nest (the re-ordered/truncated re-credit re-lists). Pure —
 *  locked in tests/ai/search_paging_locks + feed_pager + r8_locks. */
export function dedupeRecordings(tracks: Track[]): Track[] {
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  const keyPass: Track[] = [];
  for (const t of tracks) {
    if (seenIds.has(t.id)) continue;
    const key = recordingKey(t);
    if (seenKeys.has(key)) continue;
    seenIds.add(t.id);
    seenKeys.add(key);
    keyPass.push(t);
  }
  return reconcileRecordings(keyPass);
}

/**
 * Merge a fetched page into an existing result list, dropping rows whose
 * id is already present — including duplicates that arrive INSIDE one
 * page (JioSaavn pages overlap ~7%) — and rows that are the SAME
 * RECORDING under a different id or a re-ordered credit list
 * (compilation re-lists, R8-P4/P4b). Order-preserving. Pure —
 * unit-tested (F1).
 */
export function mergeUniqueTracks(prev: Track[], next: Track[]): Track[] {
  const seen = new Set(prev.map((t) => t.id));
  const seenKeys = new Set(prev.map((t) => recordingKey(t)));
  const fresh: Track[] = [];
  for (const t of next) {
    if (seen.has(t.id)) continue;
    const key = recordingKey(t);
    if (seenKeys.has(key)) continue;
    seen.add(t.id);
    seenKeys.add(key);
    fresh.push(t);
  }
  if (!fresh.length) return prev;
  // P4b: a page-2 row can re-credit a KEPT row ("Tum Hi Ho | Mithoon,
  // Arijit" after "… | Arijit, Mithoon") — reconcile the whole merged
  // list (prev is already reconciled → only prev-vs-fresh and
  // intra-fresh pairs can drop; idempotent).
  return reconcileRecordings([...prev, ...fresh]);
}

/**
 * Search pagination stop rule (F1): stop when a page comes back empty,
 * or when under a quarter of its rows are new (the provider is echoing
 * the same tail back). Pure — unit-tested.
 */
export function searchHasMore(received: number, fresh: number): boolean {
  if (received <= 0) return false;
  return fresh >= Math.ceil(received / 4);
}

/** Search that keeps explicit items (user intent) — used by the Search tab. */
export async function searchSaavnRaw(query: string, limit = 30): Promise<Track[]> {
  return searchSaavn(query, limit);
}

/** Search with the safety filter applied — used by AI/algorithmic surfaces. */
export async function searchSaavnClean(query: string, limit = 30): Promise<Track[]> {
  const tracks = await searchSaavn(query, limit);
  return filterClean(tracks);
}

export async function getCharts(): Promise<Collection[]> {
  const data = await saavnGet({ __call: 'content.getCharts' });
  if (!Array.isArray(data)) return [];
  return data.slice(0, 6).map((c: any) => ({
    id: String(c.id),
    title: decodeEntities(c.title ?? ''),
    subtitle: c.more_info?.firstname ?? 'JioSaavn Chart',
    artwork: art500(c.image),
    trackCount: c.count ?? undefined,
    kind: 'chart' as const,
  }));
}

/**
 * Editorial home feed (v3.2) — JioSaavn's own homepage modules: fresh
 * albums + featured playlists. This is what makes Home scroll DEEP like
 * Spotify instead of 2-3 rows: 30 new releases + 30 curated playlists,
 * every one a real openable collection with artwork.
 */
export interface HomepageFeed {
  newAlbums: Collection[];
  featured: Collection[];
}

let feedMemo: HomepageFeed | null = null;

export async function getHomepageFeed(): Promise<HomepageFeed> {
  if (feedMemo) return feedMemo;
  const data = await saavnGet({ __call: 'content.getHomepageData' });
  const mapAlbum = (a: any): Collection => ({
    id: String(a?.id ?? ''),
    title: decodeEntities(a?.title ?? ''),
    subtitle: a?.subtitle ?? a?.more_info?.music ?? 'Album',
    artwork: art500(a?.image),
    trackCount: a?.more_info?.song_count ?? undefined,
    kind: 'album' as const,
  });
  const mapPlaylist = (p: any): Collection => ({
    id: String(p?.listid ?? p?.id ?? ''),
    title: decodeEntities(p?.title ?? ''),
    subtitle: p?.subtitle ?? 'Playlist',
    artwork: art500(p?.image),
    trackCount: p?.count ?? undefined,
    kind: 'chart' as const,
  });
  const feed: HomepageFeed = {
    newAlbums: (Array.isArray(data?.new_albums) ? data.new_albums : []).map(mapAlbum).filter((c: Collection) => c.id && c.title),
    featured: (Array.isArray(data?.featured_playlists) ? data.featured_playlists : []).map(mapPlaylist).filter((c: Collection) => c.id && c.title),
  };
  feedMemo = feed;
  return feed;
}

export async function getCollectionTracks(collectionId: string): Promise<Track[]> {
  const data = await saavnGet({ __call: 'playlist.getDetails', listid: collectionId });
  const list = Array.isArray(data?.list) ? data.list : [];
  return list.map(mapSaavnSong).filter(Boolean) as Track[];
}

/** Full album tracklist — powers "go to album" from the player. */
/**
 * Album search (SIG rescue R2) — the typed album endpoint the app never
 * used before (research round 4 verified: search.getAlbumResults works
 * and carries id/title/music for getAlbumTracks).
 */
export async function searchAlbumResults(
  query: string,
  limit = 5,
  signal?: AbortSignal,
  page = 1,
): Promise<Array<{ id: string; title: string; music?: string }>> {
  try {
    const data = await saavnGet(
      { __call: 'search.getAlbumResults', q: query, p: String(page), n: String(limit) },
      signal,
    );
    const results = Array.isArray(data?.results) ? data.results : [];
    return results
      .filter((r: any) => r?.id)
      .map((r: any) => ({ id: String(r.id), title: String(r.title ?? ''), music: r.music }));
  } catch {
    return [];
  }
}

/**
 * Paged album search mapped to tappable Collection cards (F2 — endless
 * home feed). Rows carry id/title/subtitle(artists)/image/song_count.
 */
export async function searchAlbumCollections(
  query: string,
  page: number,
  limit = 20,
  signal?: AbortSignal,
): Promise<Collection[]> {
  try {
    const data = await saavnGet(
      { __call: 'search.getAlbumResults', q: query, p: String(page), n: String(limit) },
      signal,
    );
    const results = Array.isArray(data?.results) ? data.results : [];
    return results
      .filter((r: any) => r?.id && r?.title)
      .map(
        (r: any): Collection => ({
          id: String(r.id),
          title: decodeEntities(String(r.title)),
          subtitle: r.subtitle ? decodeEntities(String(r.subtitle)) : 'Album',
          artwork: art500(r.image ?? ''),
          trackCount: r.song_count ? Number(r.song_count) || undefined : undefined,
          kind: 'album' as const,
        }),
      )
      .filter((c: Collection) => collectionIsClean(c));
  } catch {
    return [];
  }
}

const SAMPLE_TRAILER_RE = /sample trailer/i;

/**
 * Full album tracklist — powers album pages and "go to album".
 *
 * USER-REPORTED BUG (v4.0.4, P-A "album songs are not playing"): the
 * homepage's new_albums rail lists PRE-RELEASE single stubs whose
 * content.getAlbumDetails returns NO rows, or worse a literal
 * "This is a sample trailer - testing" placeholder row (no encrypted
 * url → mapSaavnSong drops it → 0 playable rows → taps do nothing).
 * Live probe: the REAL song lives under a DIFFERENT album id that
 * search.getAlbumResults finds (e.g. homepage stub 3E8fNHiW → real
 * 81197164). Ladder:
 *   1. getAlbumDetails(albumId) — works for normal albums (probe: 7/7).
 *   2. getAlbumDetails on search.getAlbumResults(title) candidates.
 *   3. search.getResults(title) rows whose album_id matches, or whose
 *      album name matches the requested title (stub re-press case).
 * Pass the album TITLE (CollectionScreen has it) — the ladder needs it.
 */
export async function getAlbumTracks(albumId: string, title?: string): Promise<Track[]> {
  const usable = async (id: string): Promise<Track[]> => {
    try {
      const data = await saavnGet({ __call: 'content.getAlbumDetails', albumid: id });
      const list = Array.isArray(data?.list)
        ? data.list
        : Array.isArray(data?.songs)
          ? data.songs
          : [];
      // the trailer placeholder row carries an id but no encrypted url —
      // mapSaavnSong already drops it; the explicit name check is the belt
      // to that brace (a future API could attach an enc to the trailer).
      return (list as any[])
        .filter((it) => !SAMPLE_TRAILER_RE.test(String(it?.title ?? '')))
        .map(mapSaavnSong)
        .filter(Boolean) as Track[];
    } catch {
      return [];
    }
  };

  // 1) the direct hit
  const direct = await usable(albumId);
  if (direct.length) return dedupeRecordings(direct);

  // 2) real-album candidates by title (pre-release stub re-press case)
  if (title && title.trim()) {
    const candidates = await searchAlbumResults(title, 5).catch(() => [] as Array<{ id: string; title: string; music?: string }>);
    for (const cand of candidates.slice(0, 3)) {
      if (!cand?.id || String(cand.id) === String(albumId)) continue;
      const alt = await usable(String(cand.id));
      if (alt.length) return dedupeRecordings(alt);
    }

    // 3) song search filtered to the album's name — the stub's songs are
    //    re-pressed under a different album id, but the ALBUM NAME on the
    //    song rows still equals the stub's title
    try {
      const data = await saavnGet({
        __call: 'search.getResults',
        q: title,
        p: '1',
        n: '30',
      });
      const rows = Array.isArray(data?.results) ? data.results : [];
      const want = title.toLowerCase().replace(/\s+/g, ' ').trim();
      const matches = (rows as any[])
        .filter((it) => {
          const mi = it?.more_info ?? {};
          if (String(mi.album_id ?? '') === String(albumId)) return true;
          const albumName = String(mi.album ?? it?.album ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
          return !!albumName && (albumName === want || want.startsWith(albumName) || albumName.startsWith(want));
        })
        .map(mapSaavnSong)
        .filter(Boolean) as Track[];
      if (matches.length) return dedupeRecordings(matches);
    } catch {
      /* fall through to honest empty */
    }
  }
  return [];
}

/**
 * Artist top-tracks — the backbone of song radio / "because you listened".
 * Searches the artist name and keeps results whose artist matches.
 */
export async function getArtistTracks(artistName: string, limit = 14): Promise<Track[]> {
  const tracks = await searchSaavn(artistName, Math.max(20, limit * 2));
  const needle = artistName.toLowerCase().trim();
  const matched = tracks.filter((t) => {
    const a = t.artist.toLowerCase();
    return a.includes(needle) || needle.includes(a.split(' feat')[0]);
  });
  const pool = matched.length >= 3 ? matched : tracks;
  return pool.slice(0, limit);
}

// ── ARTIST CATALOG (v4.0.4, P-D "artists have less songs") ──────────────

export interface ArtistCatalog {
  tracks: Track[];
  albums: Collection[];
  artistId?: string;
}

/**
 * The REAL artist page, not a capped name-search.
 *
 * USER-REPORTED BUG: artist pages were `searchSaavnClean(name, 40)` —
 * ≤40 name-matched rows, no albums, no ordering truth. The provider's
 * artist page (artist.getArtistPageDetails) carries topSongs (real rows
 * with encrypted urls), topAlbums (real album ids the album ladder can
 * open) and a dedicated editorial playlist (25+ rows for a-listers).
 *
 * Merge order = artist-first truth: topSongs → dedicated playlist →
 * name-matched search rows, deduped by recording key. Every step
 * degrades honestly — a tiny artist with no page still gets the old
 * search behavior, never worse than v4.0.3.
 */
export async function getArtistCatalog(name: string, limit = 60): Promise<ArtistCatalog> {
  // resolve the artist id + seed search rows in one call
  const seed = await searchSaavn(name, 40).catch(() => [] as Track[]);
  const needle = name.toLowerCase().trim();
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const matched = seed.filter((t) => {
    const a = t.artist.toLowerCase();
    return a.includes(needle) || needle.includes(a.split(' feat')[0]);
  });
  let artistId: string | undefined;
  try {
    const data = await saavnGet({ __call: 'search.getResults', q: name, p: '1', n: '10' });
    const rows = Array.isArray(data?.results) ? data.results : [];
    for (const row of rows as any[]) {
      const primary: any[] = row?.more_info?.artistMap?.primary_artists ?? [];
      const hit = primary.find((a) => norm(String(a?.name ?? '')) === needle);
      if (hit?.id) {
        artistId = String(hit.id);
        break;
      }
    }
  } catch {
    /* id stays undefined → search-only fallback below */
  }

  if (!artistId) {
    // honest fallback: exactly the v4.0.3 behavior
    const pool = matched.length >= 3 ? matched : seed;
    return { tracks: pool.slice(0, limit), albums: [] };
  }

  const page = await saavnGet({
    __call: 'artist.getArtistPageDetails',
    artistId,
  }).catch(() => null);

  // topSongs — the provider's own ordering, real playable rows
  const topRaw = Array.isArray(page?.topSongs) ? page.topSongs : [];
  const topSongs = topRaw
    .filter((it: any) => !SAMPLE_TRAILER_RE.test(String(it?.title ?? '')))
    .map(mapSaavnSong)
    .filter(Boolean) as Track[];

  // topAlbums — tappable cards; ids feed getAlbumTracks (ladder-safe)
  const albRaw = Array.isArray(page?.topAlbums) ? page.topAlbums : [];
  const albums: Collection[] = albRaw
    .map((a: any): Collection => ({
      id: String(a?.id ?? ''),
      title: decodeEntities(String(a?.title ?? '')),
      subtitle: a?.subtitle ? decodeEntities(String(a.subtitle)) : 'Album',
      artwork: art500(a?.image),
      trackCount: a?.more_info?.song_count ? Number(a.more_info.song_count) || undefined : undefined,
      kind: 'album' as const,
    }))
    .filter((c: Collection) => c.id && c.title && collectionIsClean(c))
    .slice(0, 12);

  // dedicated editorial playlist — the deep catalog rows
  const dp = Array.isArray(page?.dedicated_artist_playlist) ? page.dedicated_artist_playlist : [];
  const dedicatedId = dp[0]?.id ? String(dp[0].id) : null;
  const dedicated = dedicatedId
    ? await getCollectionTracks(dedicatedId).catch(() => [] as Track[])
    : [];

  const merged = dedupeRecordings(filterClean([...topSongs, ...dedicated, ...matched]));
  return {
    tracks: merged.slice(0, limit),
    albums,
    artistId,
  };
}

/** Trending songs for home — always safety-filtered, always deduped
 *  (chart collections re-list the same recording too, R8-P4/P4b).
 *  The ≥5 gate measures POST-dedup rows (gauntlet P2-4: a degenerate
 *  chart of 5 re-lists must not pass and render a 2-row shelf). */
export async function getTrending(limit = 14): Promise<Track[]> {
  const charts = await getCharts();
  for (const chart of charts) {
    try {
      const tracks = await getCollectionTracks(chart.id);
      const clean = dedupeRecordings(filterClean(tracks));
      if (clean.length >= 5) return clean.slice(0, limit);
    } catch {
      /* try next chart */
    }
  }
  return [];
}

/** Clean-collection check for chart shelves on home. */
export function collectionIsClean(c: Collection): boolean {
  return isClean({ title: c.title, artist: c.subtitle });
}

// ── SEARCH V2 additions (§5.2 of the refactor plan) ────────────────────

export interface SuggRow {
  id: string;
  title: string;
  subtitle?: string;
  image?: string;
  type: string;
}

export interface AutocompleteBundle {
  songs: SuggRow[];
  albums: SuggRow[];
  artists: SuggRow[];
  playlists: SuggRow[];
  topQuery?: SuggRow;
}

function mapSugg(rows: any): SuggRow[] {
  const list = Array.isArray(rows?.data) ? rows.data : [];
  return list
    .filter((r: any) => r?.title && r?.type)
    .map((r: any) => ({
      id: String(r.id ?? ''),
      title: decodeEntities(String(r.title)),
      subtitle: r.subtitle ? decodeEntities(String(r.subtitle)) : undefined,
      image: r.image ? art500(r.image) : undefined,
      type: String(r.type ?? ''),
    }))
    .filter((r: SuggRow) => r.id);
}

/**
 * Provider typeahead (autocomplete.get — note `query=`, not `q=`).
 * Opportunistic by design: every section failure degrades to [].
 */
export async function getAutocomplete(
  query: string,
  signal?: AbortSignal,
): Promise<AutocompleteBundle> {
  const data = await saavnGet(
    { __call: 'autocomplete.get', query },
    signal,
  );
  const topQ = mapSugg(data?.topquery);
  return {
    songs: mapSugg(data?.songs).slice(0, 6),
    albums: mapSugg(data?.albums).slice(0, 4),
    artists: mapSugg(data?.artists).slice(0, 4),
    playlists: mapSugg(data?.playlists).slice(0, 4),
    topQuery: topQ[0],
  };
}

/** Resolve an autocomplete/topquery song id into a playable Track. */
export async function getSongById(songId: string, signal?: AbortSignal): Promise<Track | null> {
  try {
    const data = await saavnGet({ __call: 'song.getDetails', pids: songId }, signal);
    const songs = Array.isArray(data?.songs) ? data.songs : data ? [data] : [];
    return mapSaavnSong(songs[0]);
  } catch {
    return null;
  }
}
