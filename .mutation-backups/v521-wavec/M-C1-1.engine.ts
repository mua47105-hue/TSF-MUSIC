/**
 * TSF Intelligence — on-device music brain. No server, no LLM API.
 *
 * Spotify-style surfaces are computed locally from the user's own
 * listening graph (recents, favorites, play counts) and expanded through
 * JioSaavn search:
 *
 *   • Recommendations   — artist-seeded discovery for Smart Shuffle
 *   • Song Radio        — endless autoplay when a queue runs dry
 *   • Daily Mixes       — per-artist clusters refreshed once a day
 *   • Because You Listened — artist radios for the heaviest rotations
 *
 * Every surface passes the safety filter before it ever reaches a shelf.
 */

import type { DailyMix, Track } from '../types';
import { searchSaavnClean, getArtistTracks } from '../api/saavn';
import { filterClean } from '../safety';
import {
  getDailyMixCache,
  getFavorites,
  getPlayCounts,
  getRecents,
  setDailyMixCache,
} from '../storage/store';

function dedupe(tracks: Track[]): Track[] {
  const seen = new Set<string>();
  return tracks.filter((t) => {
    const key = t.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Collect the artists a user actually cares about, most loved first. */
export async function getTopArtists(limit = 6): Promise<string[]> {
  const [recents, favorites, counts] = await Promise.all([
    getRecents(),
    getFavorites(),
    getPlayCounts(),
  ]);
  const weight = new Map<string, number>();
  const bump = (artist: string | undefined, by: number) => {
    if (!artist || artist === 'Unknown artist') return;
    const key = artist.trim();
    weight.set(key, (weight.get(key) ?? 0) + by);
  };
  recents.forEach((t, i) => bump(t.artist, 8 - Math.min(i, 6)));
  favorites.forEach((t) => bump(t.artist, 5));
  Object.values(counts).forEach((e) => bump(e.track.artist, e.count * 2));
  return [...weight.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([artist]) => artist);
}

function dedupeArtists(items: Array<{ artist?: string }>, limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const a = item.artist?.trim();
    if (a && a !== 'Unknown artist' && !seen.has(a)) {
      seen.add(a);
      out.push(a);
    }
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Artist-seeded discovery. Blends the user's top artists with the seed
 * context, searches each, filters explicit, enforces per-artist caps and
 * interleaves for variety.
 */
export async function getRecommendations(seedTracks: Track[], count = 12): Promise<Track[]> {
  const seedArtists = dedupeArtists(seedTracks.slice(0, 12), 3);
  const userArtists = await getTopArtists(3);
  const artists = dedupeArtists(
    [...seedArtists.map((a) => ({ artist: a })), ...userArtists.map((a) => ({ artist: a }))],
    4,
  );
  const excludeIds = new Set(seedTracks.map((t) => t.id));

  const pools = await Promise.all(
    artists.map((a) => getArtistTracks(a, 10).catch(() => [] as Track[])),
  );

  // Interleave across artist pools with a max of 2 tracks per artist.
  const perArtist = new Map<string, number>();
  const out: Track[] = [];
  let added = true;
  while (out.length < count && added) {
    added = false;
    for (const pool of pools) {
      if (out.length >= count) break;
      const next = pool.find(
        (t) =>
          !excludeIds.has(t.id) &&
          !out.some((o) => o.id === t.id) &&
          (perArtist.get(t.artist) ?? 0) < 2,
      );
      if (next) {
        out.push(next);
        perArtist.set(next.artist, (perArtist.get(next.artist) ?? 0) + 1);
        added = true;
      }
    }
  }
  return filterClean(out);
}

/**
 * Song radio — the endless autoplay engine. Seeds from the track's artist
 * first, tops up with a title-word search when the artist pool runs thin.
 */
export async function getRadio(seed: Track, count = 12): Promise<Track[]> {
  const pools: Track[][] = [];
  try {
    pools.push(await getArtistTracks(seed.artist, 12));
  } catch {
    /* artist search failed — fall through */
  }
  const titleWords = seed.title
    .replace(/[(\[].*?[)\]]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 3);
  if (titleWords.length >= 2 || pools[0]?.length === 0 || pools.length === 0) {
    try {
      pools.push(await searchSaavnClean(titleWords.join(' ') || seed.title, 12));
    } catch {
      /* offline — return what we have */
    }
  }
  const merged = dedupe(pools.flat())
    .filter((t) => t.id !== seed.id && t.source === 'saavn')
    .filter((t) => !t.previewOnly);
  return filterClean(merged).slice(0, count);
}

/**
 * Daily Mixes — Spotify's signature home surface. Clusters the user's
 * heaviest artists, builds one mix per artist (that artist's hits plus
 * a light sprinkle of the other clusters for surprise). Cached per day.
 */
export async function getDailyMixes(): Promise<DailyMix[]> {
  const cached = await getDailyMixCache();
  if (cached) return cached;

  const topArtists = await getTopArtists(3);
  const usable = topArtists.filter((a) => a.length > 1).slice(0, 3);
  if (!usable.length) return [];

  const pools = await Promise.all(
    usable.map((artist) => getArtistTracks(artist, 12).catch(() => [] as Track[])),
  );

  const mixes: DailyMix[] = pools.map((pool, i) => {
    const artist = usable[i];
    const own = filterClean(pool).slice(0, 7);
    // Sprinkle: one track from each other artist cluster.
    const others = pools
      .filter((_, j) => j !== i)
      .flat()
      .filter((t) => t.artist !== artist);
    const surprise = filterClean(dedupe(others)).slice(0, 3);
    const tracks = dedupe([...own, ...surprise]);
    return {
      id: `mix-${i}-${artist.toLowerCase().replace(/\s+/g, '-')}`,
      title: `Daily Mix ${i + 1}`,
      subtitle: [artist, ...new Set(tracks.slice(7).map((t) => t.artist))].slice(0, 2).join(', '),
      artwork: tracks[0]?.artwork ?? '',
      tracks,
    };
  });

  const nonEmpty = mixes.filter((m) => m.tracks.length >= 3);
  if (nonEmpty.length) await setDailyMixCache(nonEmpty);
  return nonEmpty;
}

export interface BecauseItem {
  artist: string;
  seedTrack?: Track;
}

/** Home "Because you listened to …" — the top artists the user jams to. */
export async function getBecauseYouListened(limit = 2): Promise<BecauseItem[]> {
  const artists = await getTopArtists(limit + 2);
  const recents = await getRecents();
  return artists
    .slice(0, limit)
    .map((artist) => ({
      artist,
      seedTrack: recents.find((t) => t.artist === artist),
    }))
    .filter((item) => !!item.artist);
}
