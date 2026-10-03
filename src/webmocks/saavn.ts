/**
 * WEB MOCK of src/api/saavn.ts — fixture-backed, same export surface.
 * Metro redirects this only for platform=web (screenshot harness).
 */

import type { Collection, Track } from '../types';
import { isClean } from '../safety';
import { art, CHARTS, TRACKS, SEARCH_EXTRA, searchFixtures } from './fixtures';
import { recordingKey } from '../api/recording';

function filterClean(list: Track[]): Track[] {
  return list.filter((t) => isClean({ title: t.title, artist: t.artist, explicit: t.explicit }));
}

export function decryptMediaUrl(): string | null {
  return null;
}

export function resolveStreamUrl(track: Track): string | null {
  return track.encryptedUrl ?? track.previewUrl ?? null;
}

export async function refreshStreamUrl(track: Track): Promise<string | null> {
  return track.encryptedUrl ?? track.previewUrl ?? null;
}

/** Parity stub — artists.ts has its own web redirect, but the mock must
 *  export the full real-module surface (L-PARITY lock). */
export async function saavnGet(): Promise<any> {
  return {};
}

export async function searchSaavn(
  query: string,
  limit = 30,
  _signal?: AbortSignal,
  page = 1,
): Promise<Track[]> {
  await new Promise((r) => setTimeout(r, 150));
  // browse/feed queries (the endless-home-feed ladder + genre cards)
  // return a realistic full page — on the real provider these broad
  // queries always answer. Junk queries ("zzqqxx") still honestly fail.
  if (isBrowseQuery(query)) return dedupeRecordings(browsePage(query, page, limit));
  // page 1 = the real fixture rows; pages 2+ = deterministic synthetic
  // rows unique per (query, page) so pagination UI is fully exercisable;
  // pages beyond PAGE_DEPTH come back empty (honest end in the harness)
  if (page <= 1) return dedupeRecordings(searchFixtures(query, limit));
  if (page > PAGE_DEPTH) return [];
  return dedupeRecordings(syntheticPage(query, page, limit));
}

/** Mirrors src/api/feed.ts SONG_QUERIES (kept in sync for the harness). */
const BROWSE_QUERIES = new Set([
  'top songs',
  'arijit singh',
  'punjabi hits',
  'romantic songs',
  'bollywood 2024',
  'party songs',
  'atif aslam',
  'sad songs',
  'dance hits',
  'kishore kumar',
  'lofi songs',
  'workout music',
  'shreya ghoshal',
  'sufi songs',
  'english hits',
  'a r rahman',
]);

function isBrowseQuery(q: string): boolean {
  return BROWSE_QUERIES.has(q.trim().toLowerCase());
}

/** Browse pages: fixture rows first, padded with synthetic picks; 3 pages deep. */
function browsePage(query: string, page: number, limit: number): Track[] {
  if (page > 3) return [];
  const base = searchFixtures(query, limit);
  const pad = Math.max(0, 14 - base.length);
  const extras: Track[] = Array.from({ length: pad }, (_, i) => ({
    id: `saavn-feed-${page}-${slug(query)}-${i}`,
    title: `${titleSeed(query)} Pick ${page}.${i + 1}`,
    artist: PAGE_ARTISTS[(page + i) % PAGE_ARTISTS.length],
    duration: 170 + ((page * 29 + i * 11) % 110),
    source: 'saavn' as const,
    artwork: art.trending,
    previewOnly: false,
  } satisfies Track));
  return [...base, ...extras].slice(0, limit);
}

const PAGE_DEPTH = 3;
const PAGE_ARTISTS = [
  'Arijit Singh',
  'Shreya Ghoshal',
  'Diljit Dosanjh',
  'Atif Aslam',
  'Pritam',
  'A. R. Rahman',
];

/** Deterministic synthetic rows unique per (query, page). */
function syntheticPage(query: string, page: number, limit: number): Track[] {
  return Array.from({ length: Math.min(limit, 30) }, (_, i) => ({
    id: `saavn-page-${page}-${slug(query)}-${i}`,
    title: `${titleSeed(query)} — Page ${page}, Track ${i + 1}`,
    artist: PAGE_ARTISTS[(page + i) % PAGE_ARTISTS.length],
    duration: 180 + ((page * 31 + i * 7) % 120),
    source: 'saavn' as const,
    artwork: art.trending,
    previewOnly: false,
  } satisfies Track));
}

function slug(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function titleSeed(q: string): string {
  const clean = q.trim();
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/** Mirrors src/api/saavn.ts (kept in sync for the web harness) — id AND
 *  recording-key dedup (R8-P4). */
export function mergeUniqueTracks(prev: Track[], next: Track[]): Track[] {
  const seenIds = new Set(prev.map((t) => t.id));
  const seenKeys = new Set(
    prev.map((t) => recordingKey({ title: t.title, artist: t.artist, artistsFull: t.artistsFull })),
  );
  const fresh: Track[] = [];
  for (const t of next) {
    if (seenIds.has(t.id)) continue;
    const key = recordingKey({ title: t.title, artist: t.artist, artistsFull: t.artistsFull });
    if (seenKeys.has(key)) continue;
    seenIds.add(t.id);
    seenKeys.add(key);
    fresh.push(t);
  }
  return fresh.length ? [...prev, ...fresh] : prev;
}

/** Mirrors src/api/saavn.ts (R8-P4). */
export function dedupeRecordings(tracks: Track[]): Track[] {
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  const out: Track[] = [];
  for (const t of tracks) {
    if (seenIds.has(t.id)) continue;
    const key = recordingKey({ title: t.title, artist: t.artist, artistsFull: t.artistsFull });
    if (seenKeys.has(key)) continue;
    seenIds.add(t.id);
    seenKeys.add(key);
    out.push(t);
  }
  return out;
}

/** Mirrors src/api/saavn.ts. */
export function searchHasMore(received: number, fresh: number): boolean {
  if (received <= 0) return false;
  return fresh >= Math.ceil(received / 4);
}

export async function searchSaavnRaw(query: string, limit = 30): Promise<Track[]> {
  return searchSaavn(query, limit);
}

export async function searchSaavnClean(query: string, limit = 30): Promise<Track[]> {
  return filterClean(await searchSaavn(query, limit));
}

/** Paged album fixtures for the endless home feed (web harness). */
export async function searchAlbumCollections(
  query: string,
  page: number,
  limit = 20,
): Promise<Collection[]> {
  await new Promise((r) => setTimeout(r, 120));
  if (page > 3) return [];
  return Array.from({ length: Math.min(limit, 8) }, (_, i) => ({
    id: `album-page-${page}-${slug(query)}-${i}`,
    title: `${titleSeed(query)} Albums Vol. ${page}.${i + 1}`,
    subtitle: PAGE_ARTISTS[(page + i) % PAGE_ARTISTS.length],
    artwork: [art.cocktail2, art.dhurandhar, art.awarapan, art.boom, art.meera, art.hanuman][(page + i) % 6],
    kind: 'album' as const,
  }));
}

/**
 * CRITIC P2-3 fix: the SIG-rescue album rung (src/search/rescue.ts) calls
 * this on web through the metro redirect — a missing export made the whole
 * rung throw. Fixture-backed, matching the real signature.
 */
export async function searchAlbumResults(
  query: string,
  limit = 5,
): Promise<Array<{ id: string; title: string; music?: string }>> {
  await new Promise((r) => setTimeout(r, 120));
  const hits = await searchAlbumCollections(query, 1, limit);
  return hits.slice(0, limit).map((c) => ({
    id: c.id,
    title: c.title,
    music: c.subtitle,
  }));
}

export async function getCharts(): Promise<Collection[]> {
  await new Promise((r) => setTimeout(r, 100));
  return CHARTS;
}

export interface HomepageFeed {
  newAlbums: Collection[];
  featured: Collection[];
}

const NEW_ALBUMS: Collection[] = [
  { id: 'a1', title: 'Cocktail 2', subtitle: 'Pritam', artwork: art.cocktail2, kind: 'album' },
  { id: 'a2', title: 'Dhurandhar The Revenge', subtitle: 'G.V. Prakash Kumar', artwork: art.dhurandhar, kind: 'album' },
  { id: 'a4', title: 'Awarapan 2', subtitle: 'Mithoon', artwork: art.awarapan, kind: 'album' },
  { id: 'a5', title: 'Boom Shaka', subtitle: 'Dhanda Nyoliwala', artwork: art.boom, kind: 'album' },
  { id: 'a7', title: 'Meera Ke Krishna', subtitle: 'Jasleen Royal', artwork: art.meera, kind: 'album' },
  { id: 'a8', title: 'Hanuman Ansh', subtitle: 'Amit Trivedi', artwork: art.hanuman, kind: 'album' },
];

const FEATURED: Collection[] = [
  { id: 'chart-1', title: 'Now Trending', subtitle: 'JioSaavn', artwork: art.trending, kind: 'chart' },
  { id: 'chart-2', title: 'Bollywood Chartbusters', subtitle: 'JioSaavn', artwork: art.cocktail2, kind: 'chart' },
  { id: 'chart-3', title: 'Punjabi 101', subtitle: 'JioSaavn', artwork: art.boom, kind: 'chart' },
  { id: 'chart-4', title: 'Lo-Fi Beats', subtitle: 'JioSaavn', artwork: art.lofi, kind: 'chart' },
  { id: 'chart-5', title: 'Old Hindi Hits', subtitle: 'JioSaavn', artwork: art.old, kind: 'chart' },
  { id: 'fp-6', title: 'Sad Love Hits', subtitle: 'JioSaavn', artwork: art.emraan, kind: 'chart' },
  { id: 'fp-7', title: 'Romance Top 50', subtitle: 'JioSaavn', artwork: art.mashooqa, kind: 'chart' },
];

export async function getHomepageFeed(): Promise<HomepageFeed> {
  await new Promise((r) => setTimeout(r, 150));
  return { newAlbums: NEW_ALBUMS, featured: FEATURED };
}

export async function getCollectionTracks(collectionId: string): Promise<Track[]> {
  await new Promise((r) => setTimeout(r, 200));
  const idx = CHARTS.findIndex((c) => c.id === collectionId);
  if (idx === -1) return TRACKS;
  // rotate the fixture list so each "chart" looks different
  return TRACKS.slice(idx).concat(TRACKS.slice(0, idx));
}

export async function getAlbumTracks(albumId: string, _title?: string): Promise<Track[]> {
  await new Promise((r) => setTimeout(r, 120));
  return TRACKS.filter((t) => t.albumId === albumId);
}

export async function getArtistTracks(artistName: string, limit = 14): Promise<Track[]> {
  await new Promise((r) => setTimeout(r, 120));
  const pool = TRACKS.filter((t) => t.artist.includes(artistName));
  return (pool.length ? pool : TRACKS).slice(0, limit);
}

// ── v4.0.4 parity additions (L-PARITY lock) ────────────────────────────

export const SAAVN_TIMEOUT_MS = 10_000;

export interface ArtistCatalog {
  tracks: Track[];
  albums: Collection[];
  artistId?: string;
}

export async function getArtistCatalog(artistName: string, limit = 60): Promise<ArtistCatalog> {
  const tracks = await getArtistTracks(artistName, limit);
  return { tracks, albums: [], artistId: undefined };
}

export async function getTrending(limit = 14): Promise<Track[]> {
  await new Promise((r) => setTimeout(r, 250));
  return filterClean(TRACKS).slice(0, limit);
}

export function collectionIsClean(c: Collection): boolean {
  return isClean({ title: c.title, artist: c.subtitle });
}

// ── SEARCH V2 webmocks (autocomplete + topquery resolve) ────────────

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

export async function getAutocomplete(
  query: string,
  _signal?: AbortSignal,
): Promise<AutocompleteBundle> {
  await new Promise((r) => setTimeout(r, 120));
  const q = query.trim().toLowerCase();
  if (!q) {
    return { songs: [], albums: [], artists: [], playlists: [] };
  }
  const pool = [...TRACKS, ...SEARCH_EXTRA];
  const hit = (t: Track) =>
    t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q);
  const songs = pool.filter(hit).slice(0, 5);
  const artistSet = new Map<string, string>();
  for (const t of pool.filter(hit)) {
    for (const a of t.artistsFull ?? t.artist.split(', ')) {
      if (a.toLowerCase().includes(q)) artistSet.set(a, t.artwork);
    }
  }
  return {
    songs: songs.map((t) => ({
      id: t.saavnId ?? t.id,
      title: t.title,
      subtitle: t.artist,
      image: t.artwork,
      type: 'song',
    })),
    albums: [],
    artists: Array.from(artistSet.entries()).slice(0, 4).map(([name, image]) => ({
      id: name,
      title: name,
      subtitle: 'Artist',
      image,
      type: 'artist',
    })),
    playlists: [],
    topQuery: songs[0]
      ? {
          id: songs[0].saavnId ?? songs[0].id,
          title: songs[0].title,
          subtitle: songs[0].artist,
          image: songs[0].artwork,
          type: 'song',
        }
      : undefined,
  };
}

export async function getSongById(
  songId: string,
  _signal?: AbortSignal,
): Promise<Track | null> {
  const pool = [...TRACKS, ...SEARCH_EXTRA];
  return pool.find((t) => (t.saavnId ?? t.id) === songId) ?? null;
}
