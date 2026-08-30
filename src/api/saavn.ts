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

const API = 'https://www.jiosaavn.com/api.php';
const DES_KEY = CryptoJS.enc.Utf8.parse('38346591');
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
  Accept: 'application/json, text/plain, */*',
};

export async function saavnGet(
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<any> {
  const qs = new URLSearchParams({
    _format: 'json',
    _marker: '0',
    api_version: '4',
    ctx: 'web6dot0',
    ...params,
  });
  const res = await fetch(`${API}?${qs.toString()}`, {
    headers: BROWSER_HEADERS,
    signal,
  });
  if (!res.ok) throw new Error(`saavn ${res.status}`);
  const text = await res.text();
  // JioSaavn occasionally prefixes junk before the JSON body.
  const start = text.indexOf('{');
  const arr = text.indexOf('[');
  const from = start === -1 ? arr : arr === -1 ? start : Math.min(start, arr);
  if (from === -1) throw new Error('saavn: no json');
  return JSON.parse(text.slice(from));
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
): Promise<Track[]> {
  const data = await saavnGet(
    {
      __call: 'search.getResults',
      q: query,
      p: '1',
      n: String(limit),
    },
    signal,
  );
  const results = Array.isArray(data?.results) ? data.results : [];
  return results.map(mapSaavnSong).filter(Boolean) as Track[];
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
): Promise<Array<{ id: string; title: string; music?: string }>> {
  try {
    const data = await saavnGet(
      { __call: 'search.getAlbumResults', q: query, p: '1', n: String(limit) },
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

export async function getAlbumTracks(albumId: string): Promise<Track[]> {
  try {
    const data = await saavnGet({ __call: 'content.getAlbumDetails', albumid: albumId });
    const list = Array.isArray(data?.list)
      ? data.list
      : Array.isArray(data?.songs)
        ? data.songs
        : [];
    return list.map(mapSaavnSong).filter(Boolean) as Track[];
  } catch {
    return [];
  }
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

/** Trending songs for home — always safety-filtered. */
export async function getTrending(limit = 14): Promise<Track[]> {
  const charts = await getCharts();
  for (const chart of charts) {
    try {
      const tracks = await getCollectionTracks(chart.id);
      const clean = filterClean(tracks);
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
