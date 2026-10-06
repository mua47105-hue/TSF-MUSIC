/**
 * On the Rise (§9.6) — the discovery flagship.
 *
 * A rolling-7-day, 25-track playlist built ONLY from the user's own
 * exploration edges: seed-of-seed artists (neighbors of co-play
 * neighbors) whose catalogs are filtered to never-played tracks.
 * Every track's chain resolves to a reason the app can honestly print.
 */

import { decide, reasonLine, buildServeRecency } from '../core/decision';
import type { Track } from '../../types';
import { type SurfaceCtx } from './deps';
import { blockOf, dayKindOf } from '../core/time';
import { estimateFeatures } from '../core/features';

export interface RisePick extends Track {
  reason: string;
  reasonCode: string;
  exploration: boolean;
  /** The honest chain: which neighbor-of-neighbor led here. */
  viaArtist: string;
}

export interface OnTheRiseCard {
  id: string;
  title: string;
  subtitle: string;
  tracks: RisePick[];
}

export async function buildOnTheRise(ctx: SurfaceCtx, count = 25): Promise<OnTheRiseCard | null> {
  const { api, profile, session, now } = ctx;
  const serveRecency = buildServeRecency(ctx.listens);

  // Seed-of-seed: strongest co-play neighbors of the user's top artists.
  const topArtists = Object.entries(profile.artists)
    .sort((a, b) => b[1].w - a[1].w)
    .slice(0, 4)
    .map(([a]) => a);
  if (!topArtists.length) return null;

  const secondRing: Array<{ via: string; artist: string }> = [];
  for (const a of topArtists) {
    const neighbors = Object.entries(profile.coplayArtists[a] ?? {})
      .sort((x, y) => y[1] - x[1])
      .slice(0, 3);
    for (const [n, w] of neighbors) {
      if (w > 0.02 && !topArtists.includes(n)) secondRing.push({ via: a, artist: n });
    }
  }
  if (!secondRing.length) return null;

  const pools = [];
  const trackById = new Map<string, Track>();
  for (const ring of secondRing.slice(0, 6)) {
    const tracks = await api.artistTracks(ring.artist, 8);
    for (const t of tracks) {
      if (serveRecency.has(t.id)) continue; // only never-recently-played
      trackById.set(t.id, t);
      pools.push({
        trackId: t.id,
        artist: t.artist,
        artistId: t.artistId,
        language: t.language,
        features: estimateFeatures({ artist: t.artist, title: t.title, album: t.album }),
        pool: 'discovery' as const,
      });
    }
  }
  if (pools.length < 5) return null;

  const viaById = new Map<string, string>();
  for (const ring of secondRing) viaById.set(ring.artist, ring.via);

  const ranked = decide(
    pools,
    {
      surface: 'on_the_rise',
      block: blockOf(now, dayKindOf(now), profile.boundaries),
      dayKind: dayKindOf(now),
      seedTrackIds: [],
      seedArtists: topArtists,
      requested: count,
    },
    { profile, session, now, banditArms: ctx.banditArms },
    { serveRecency, forceExploration: true },
  );

  const picks: RisePick[] = [];
  for (const c of ranked) {
    const track = trackById.get(c.trackId);
    if (!track) continue;
    picks.push({
      ...track,
      reason: reasonLine('NEIGHBOR', viaArtistOf(c.artist, viaById)),
      reasonCode: 'NEIGHBOR',
      exploration: true,
      viaArtist: viaArtistOf(c.artist, viaById),
    });
    ctx.onExposure?.(c.trackId, 'on_the_rise', picks.length, true);
  }
  if (picks.length < 5) return null;

  const week = Math.floor(now / (7 * 86400_000));
  return {
    id: `on-the-rise-${week}`,
    title: 'On the Rise',
    subtitle: `New finds from around ${titleCase(topArtists[0])} · fresh every week`,
    tracks: picks.slice(0, count),
  };
}

function viaArtistOf(artist: string, viaById: Map<string, string>): string {
  return titleCase(viaById.get(artist.toLowerCase()) ?? artist);
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
