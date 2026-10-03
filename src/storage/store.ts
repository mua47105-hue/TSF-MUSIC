/**
 * On-device persistence — favorites, play history + counts, recent
 * searches, playlists, download index, home cache, settings.
 * Everything lives in AsyncStorage; downloaded audio files live in the
 * app's document directory (storage/downloads.ts).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Collection, DailyMix, ListeningStats, PlayCountEntry, Playlist, Track, WeeklyCrate } from '../types';

const KEYS = {
  favorites: 'tsf.favorites.v1',
  recents: 'tsf.recents.v1',
  searches: 'tsf.recentSearches.v1',
  downloads: 'tsf.downloads.v1',
  chartsCache: 'tsf.chartsCache.v1',
  homeFeedCache: 'tsf.homeFeedCache.v1',
  playlists: 'tsf.playlists.v1',
  playCounts: 'tsf.playCounts.v1',
  dailyMixes: 'tsf.dailyMixes.v1',
  weeklyCrate: 'tsf.weeklyCrate.v1',
  autoplay: 'tsf.autoplay.v1',
  smartShuffle: 'tsf.smartShuffle.v1',
  dataSaver: 'tsf.dataSaver.v1',
};

async function readJSON<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

async function writeJSON(key: string, value: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full — non-fatal */
  }
}

let writeChain: Promise<unknown> = Promise.resolve();

/** Serialize a storage mutation so rapid taps can't clobber each other. */
function serialized<T>(job: () => Promise<T>): Promise<T> {
  const run = writeChain.then(job, job);
  writeChain = run.catch(() => undefined);
  return run;
}

// ── Favorites ──────────────────────────────────────────────────────────

export async function getFavorites(): Promise<Track[]> {
  return readJSON<Track[]>(KEYS.favorites, []);
}

export async function toggleFavorite(track: Track): Promise<boolean> {
  return serialized(async () => {
    const list = await getFavorites();
    const idx = list.findIndex((t) => t.id === track.id);
    let nowFavorite: boolean;
    if (idx >= 0) {
      list.splice(idx, 1);
      nowFavorite = false;
    } else {
      // P2-4: rescued YT rows carry a pre-resolved googlevideo streamUrl
      // that is IP-bound and expires in ~6 h — persisting it guarantees a
      // PlaybackError on the next session's replay. Strip it; tap-time
      // resolution (buildPlayable → ytStreamUrlForTrack) re-resolves.
      const { streamUrl: _stale, ...persistable } = track as Track & { streamUrl?: string };
      list.unshift(persistable);
      nowFavorite = true;
    }
    await writeJSON(KEYS.favorites, list.slice(0, 500));
    return nowFavorite;
  });
}

export async function isFavorite(track: Track): Promise<boolean> {
  const list = await getFavorites();
  return list.some((t) => t.id === track.id);
}

// ── Play history ───────────────────────────────────────────────────────

export async function getRecents(): Promise<Track[]> {
  return readJSON<Track[]>(KEYS.recents, []);
}

export async function pushRecent(track: Track): Promise<void> {
  return serialized(async () => {
    const list = await getRecents();
    const filtered = list.filter((t) => t.id !== track.id);
    filtered.unshift(track);
    await writeJSON(KEYS.recents, filtered.slice(0, 50));
  });
}

// ── Play counts + stats ────────────────────────────────────────────────

export async function getPlayCounts(): Promise<Record<string, PlayCountEntry>> {
  return readJSON<Record<string, PlayCountEntry>>(KEYS.playCounts, {});
}

export async function incrementPlayCount(track: Track): Promise<void> {
  return serialized(async () => {
    const all = await getPlayCounts();
    const entry = all[track.id];
    if (entry) {
      entry.count += 1;
      entry.lastAt = Date.now();
    } else {
      all[track.id] = { track, count: 1, lastAt: Date.now() };
    }
    // Cap stored entries to keep AsyncStorage lean.
    const ids = Object.keys(all);
    if (ids.length > 300) {
      ids
        .sort((a, b) => (all[a]?.lastAt ?? 0) - (all[b]?.lastAt ?? 0))
        .slice(0, ids.length - 300)
        .forEach((id) => delete all[id]);
    }
    await writeJSON(KEYS.playCounts, all);
  });
}

export async function getStats(): Promise<ListeningStats> {
  const counts = await getPlayCounts();
  const entries = Object.values(counts);
  const artistAgg = new Map<string, { plays: number; artwork?: string }>();
  for (const e of entries) {
    const key = e.track.artist;
    const cur = artistAgg.get(key) ?? { plays: 0 };
    cur.plays += e.count;
    if (!cur.artwork && e.track.artwork) cur.artwork = e.track.artwork;
    artistAgg.set(key, cur);
  }
  const topArtists = [...artistAgg.entries()]
    .map(([artist, v]) => ({ artist, plays: v.plays, artwork: v.artwork }))
    .sort((a, b) => b.plays - a.plays)
    .slice(0, 8);
  const topTracks = entries
    .slice()
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  const totalPlays = entries.reduce((sum, e) => sum + e.count, 0);
  const secondsEstimate = entries.reduce(
    (sum, e) => sum + e.count * (e.track.duration || 210),
    0,
  );
  return {
    totalPlays,
    distinctTracks: entries.length,
    topArtists,
    topTracks,
    minutesEstimate: Math.round(secondsEstimate / 60),
  };
}

// ── Recent searches ────────────────────────────────────────────────────

export async function getRecentSearches(): Promise<string[]> {
  return readJSON<string[]>(KEYS.searches, []);
}

export async function pushRecentSearch(query: string): Promise<void> {
  const q = query.trim();
  if (!q) return;
  const list = await getRecentSearches();
  const filtered = list.filter((s) => s.toLowerCase() !== q.toLowerCase());
  filtered.unshift(q);
  await writeJSON(KEYS.searches, filtered.slice(0, 12));
}

export async function clearRecentSearches(): Promise<void> {
  await writeJSON(KEYS.searches, []);
}

// ── Playlists ──────────────────────────────────────────────────────────

export async function getPlaylists(): Promise<Playlist[]> {
  return readJSON<Playlist[]>(KEYS.playlists, []);
}

export async function savePlaylists(list: Playlist[]): Promise<void> {
  await writeJSON(KEYS.playlists, list);
}

export async function createPlaylist(name: string, tracks: Track[] = []): Promise<Playlist> {
  const playlist: Playlist = {
    id: `pl-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    name: name.trim() || 'New Playlist',
    createdAt: Date.now(),
    tracks,
  };
  await serialized(async () => {
    const list = await getPlaylists();
    list.unshift(playlist);
    await savePlaylists(list);
  });
  return playlist;
}

export async function renamePlaylist(id: string, name: string): Promise<void> {
  await serialized(async () => {
    const list = await getPlaylists();
    const pl = list.find((p) => p.id === id);
    if (pl) {
      pl.name = name.trim() || pl.name;
      await savePlaylists(list);
    }
  });
}

export async function deletePlaylist(id: string): Promise<void> {
  await serialized(async () => {
    const list = await getPlaylists();
    await savePlaylists(list.filter((p) => p.id !== id));
  });
}

export async function addTrackToPlaylist(playlistId: string, track: Track): Promise<boolean> {
  return serialized(async () => {
    const list = await getPlaylists();
    const pl = list.find((p) => p.id === playlistId);
    if (!pl) return false;
    if (pl.tracks.some((t) => t.id === track.id)) return true;
    pl.tracks.push(track);
    await savePlaylists(list);
    return true;
  });
}

export async function removeTrackFromPlaylist(playlistId: string, trackId: string): Promise<void> {
  await serialized(async () => {
    const list = await getPlaylists();
    const pl = list.find((p) => p.id === playlistId);
    if (pl) {
      pl.tracks = pl.tracks.filter((t) => t.id !== trackId);
      await savePlaylists(list);
    }
  });
}

// ── Downloads index (files managed by storage/downloads.ts) ────────────

export async function getDownloadIndex(): Promise<Track[]> {
  return readJSON<Track[]>(KEYS.downloads, []);
}

export async function setDownloadIndex(tracks: Track[]): Promise<void> {
  await writeJSON(KEYS.downloads, tracks);
}

export async function removeFromDownloadIndex(trackId: string): Promise<Track[]> {
  const list = await getDownloadIndex();
  const next = list.filter((t) => t.id !== trackId);
  await writeJSON(KEYS.downloads, next);
  return next;
}

// ── Home charts cache (6h TTL — charts don't move faster than that) ────

interface ChartsCache {
  at: number;
  shelves: Array<{ collection: { id: string; title: string; subtitle?: string; artwork: string; trackCount?: number }; tracks: Track[] }>;
}

export async function getChartsCache(allowStale = false) {
  const cache = await readJSON<ChartsCache | null>(KEYS.chartsCache, null);
  if (!cache) return null;
  if (!allowStale && Date.now() - cache.at > 6 * 60 * 60 * 1000) return null;
  return cache.shelves;
}

export async function setChartsCache(shelves: ChartsCache['shelves']): Promise<void> {
  await writeJSON(KEYS.chartsCache, { at: Date.now(), shelves });
}

// ── Home editorial feed cache (6h TTL — same freshness class as charts) ──

interface HomeFeedCache {
  at: number;
  feed: { newAlbums: Collection[]; featured: Collection[] };
}

export async function getHomeFeedCache(allowStale = false) {
  const cache = await readJSON<HomeFeedCache | null>(KEYS.homeFeedCache, null);
  if (!cache) return null;
  if (!allowStale && Date.now() - cache.at > 6 * 60 * 60 * 1000) return null;
  return cache.feed;
}

export async function setHomeFeedCache(feed: HomeFeedCache['feed']): Promise<void> {
  await writeJSON(KEYS.homeFeedCache, { at: Date.now(), feed });
}

// ── Daily mixes cache (regenerated once per day) ───────────────────────

interface DailyMixCache {
  date: string;
  mixes: DailyMix[];
}

export async function getDailyMixCache(): Promise<DailyMix[] | null> {
  const cache = await readJSON<DailyMixCache | null>(KEYS.dailyMixes, null);
  if (!cache) return null;
  const today = new Date().toDateString();
  return cache.date === today && cache.mixes.length ? cache.mixes : null;
}

export async function setDailyMixCache(mixes: DailyMix[]): Promise<void> {
  await writeJSON(KEYS.dailyMixes, { date: new Date().toDateString(), mixes });
}

// ── THE WEEKLY CRATE (§9.7) — persisted: an edition must survive restarts ──

interface WeeklyCrateCache {
  weekKey: string;
  crate: WeeklyCrate;
  /** The edition's own ids — next week's anti-repeat anchor. */
  prevIds: string[];
}

/**
 * The cached edition as written (any week) — the CALLER enforces week
 * freshness by comparing `weekKey` against weekKeyOf(now). Kept here so
 * the memory-mirror fallback in mindbeat can reuse even a stale anchor.
 */
export async function getWeeklyCrateCache(): Promise<WeeklyCrateCache | null> {
  const cache = await readJSON<WeeklyCrateCache | null>(KEYS.weeklyCrate, null);
  if (!cache || !cache.crate?.tracks?.length) return null;
  return cache;
}

export async function setWeeklyCrateCache(cache: WeeklyCrateCache): Promise<void> {
  await writeJSON(KEYS.weeklyCrate, cache);
}

// ── Settings ───────────────────────────────────────────────────────────

export async function getAutoplay(): Promise<boolean> {
  const v = await readJSON<boolean | null>(KEYS.autoplay, null);
  return v !== false; // default ON — endless radio like Spotify
}

export async function setAutoplay(on: boolean): Promise<void> {
  await writeJSON(KEYS.autoplay, on);
}

export async function getSmartShuffleSetting(): Promise<boolean> {
  return readJSON<boolean>(KEYS.smartShuffle, false);
}

export async function setSmartShuffleSetting(on: boolean): Promise<void> {
  await writeJSON(KEYS.smartShuffle, on);
}

/** Data saver (Task 28): stream at the catalog's native 96/160 instead of the
 * 320 upgrade — roughly a third of the mobile data per song. Default OFF so
 * the out-of-box experience stays maximally juicy. */
export async function getDataSaver(): Promise<boolean> {
  return readJSON<boolean>(KEYS.dataSaver, false);
}

export async function setDataSaver(on: boolean): Promise<void> {
  await writeJSON(KEYS.dataSaver, on);
}
