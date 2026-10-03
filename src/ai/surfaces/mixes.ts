/**
 * Daily Mixes v2 (§9.5) — two-axis + same-day drift.
 *
 * v1 = one mix per top-3 artists, refreshed daily. v2:
 *   • mixes are cluster crosses: artist-cluster × dominant mood-cell
 *     (§6.5) — that's what makes them feel different from each other
 *   • 60/25/15 core/bridge/fresh split: core = the cluster's own tracks,
 *     bridge = co-play neighbors, fresh = never-played exploration
 *   • re-ranked nightly AND after every 3rd session — today's obsession
 *     reaches tonight's mix ("the v2.1 killer fixed")
 *   • ≤30% repeat from yesterday (anti-staleness)
 */

import { CADENCE } from '../core/constants';
import { decide, reasonLine, buildServeRecency, artistAffinity } from '../core/decision';
import type { Candidate, TasteProfile } from '../core/types';
import type { Track, DailyMix } from '../../types';
import { artistCandidates, type SurfaceCtx } from './deps';
import { blockOf, dayKindOf } from '../core/time';
import { estimateFeatures } from '../core/features';

export interface MixPick extends Track {
  reason: string;
  reasonCode: string;
  exploration: boolean;
}

export interface DailyMixV2 extends DailyMix {
  clusterLabel: string;
  moodLabel: string;
  tracks: MixPick[];
}

/** Cluster crosses available for this profile (§6.5 → mixes). */
export function mixAxes(profile: TasteProfile): Array<{ cluster: string; clusterArtists: string[]; mood: string; moodEnergy: number; moodValence: number }> {
  const out: Array<{ cluster: string; clusterArtists: string[]; mood: string; moodEnergy: number; moodValence: number }> = [];
  const clusters = profile.clusters.artistClusters.slice(0, 4);
  const moods = profile.clusters.moodCells.slice(0, 4);
  for (const c of clusters) {
    const mood = moods[0];
    if (!mood) break;
    out.push({
      cluster: c.label,
      clusterArtists: c.artistIds.slice(0, 6),
      mood: mood.label,
      moodEnergy: mood.energyCenter,
      moodValence: mood.valenceCenter,
    });
    const alt = moods.length > 1 ? moods[c.artistIds.length % moods.length] : null;
    if (alt && alt.id !== mood.id) {
      out.push({
        cluster: c.label,
        clusterArtists: c.artistIds.slice(0, 6),
        mood: alt.label,
        moodEnergy: alt.energyCenter,
        moodValence: alt.valenceCenter,
      });
    }
  }
  return out.slice(0, CADENCE.mixesMax);
}

export async function buildDailyMixesV2(
  ctx: SurfaceCtx,
  yesterdayIds: Set<string>,
): Promise<DailyMixV2[]> {
  const { api, profile, session, now } = ctx;
  const axes = mixAxes(profile);
  if (!axes.length) return [];

  const serveRecency = buildServeRecency(ctx.listens);
  const block = blockOf(now, dayKindOf(now), profile.boundaries);
  const mixes: DailyMixV2[] = [];

  for (const axis of axes) {
    // Track objects by id — filled as pools are fetched.
    const trackById = new Map<string, Track>();
    const keep = (t: Track) => trackById.set(t.id, t);

    // Core pool: the cluster's artists (60%).
    const coreCandidates: Candidate[] = [];
    for (const a of axis.clusterArtists.slice(0, 4)) {
      const tracks = await api.artistTracks(a, 8);
      tracks.forEach(keep);
      coreCandidates.push(...tracks.map((t) => ({ trackId: t.id, artist: t.artist, artistId: t.artistId, language: t.language, features: featOf(t), pool: 'affinity' as const })));
    }
    // Bridge pool: co-play artist neighbors (25%).
    const bridgeCandidates: Candidate[] = [];
    const neighborArtists: string[] = [];
    for (const a of axis.clusterArtists.slice(0, 3)) {
      for (const [n] of Object.entries(profile.coplayArtists[a] ?? {}).sort((x, y) => y[1] - x[1]).slice(0, 2)) {
        if (!neighborArtists.includes(n)) neighborArtists.push(n);
      }
    }
    for (const a of neighborArtists.slice(0, 3)) {
      const tracks = await api.artistTracks(a, 6);
      tracks.forEach(keep);
      bridgeCandidates.push(...tracks.map((t) => ({ trackId: t.id, artist: t.artist, artistId: t.artistId, language: t.language, features: featOf(t), pool: 'neighborhood' as const })));
    }
    // Fresh pool: never-heard exploratory search (15%).
    const freshCandidates: Candidate[] = [];
    if (axis.clusterArtists[0]) {
      try {
        const tracks = await api.search(`${axis.clusterArtists[0]} songs`, 10);
        tracks.forEach(keep);
        const unheard = tracks.filter((t) => !serveRecency.has(t.id));
        freshCandidates.push(...unheard.map((t) => ({ trackId: t.id, artist: t.artist, artistId: t.artistId, language: t.language, features: featOf(t), pool: 'discovery' as const })));
      } catch {
        /* offline — core+bridge carry the mix */
      }
    }

    const all = [...coreCandidates, ...bridgeCandidates, ...freshCandidates];
    if (all.length < 6) continue;

    const ranked = decide(
      all,
      {
        surface: 'daily_mix',
        block,
        dayKind: dayKindOf(now),
        seedTrackIds: [],
        seedArtists: axis.clusterArtists.slice(0, 3),
        requested: 12,
      },
      { profile, session, now },
      { excludeTrackIds: new Set(), serveRecency },
    );

    // Assemble the 60/25/15 split with ≤30% yesterday repeat.
    const [coreShare, bridgeShare] = CADENCE.mixCoreBridgeFresh;
    const total = Math.min(10, ranked.length);
    const coreN = Math.round(total * coreShare);
    const bridgeN = Math.round(total * bridgeShare);

    const picks: MixPick[] = [];
    let yesterdayCount = 0;
    const maxYesterday = Math.ceil(total * CADENCE.mixMaxRepeatFromYesterday);

    const take = (n: number, pools: Array<Candidate['pool']>) => {
      for (const c of ranked) {
        if (n <= 0 || picks.length >= total) break;
        if (picks.some((p) => p.id === c.trackId)) continue;
        if (!pools.includes(c.pool)) continue;
        const track = trackById.get(c.trackId);
        if (!track) continue;
        const isYesterday = yesterdayIds.has(c.trackId);
        if (isYesterday && yesterdayCount >= maxYesterday) continue;
        if (isYesterday) yesterdayCount += 1;
        picks.push({
          ...track,
          isRecommended: true, // mixes ARE recommendations — their reasons must render
          reason: reasonLine(c.reasonCode, track.artist.split(' feat')[0]),
          reasonCode: c.reasonCode,
          exploration: c.explorationSlot,
        });
        ctx.onExposure?.(c.trackId, 'daily_mix', picks.length, c.explorationSlot);
        n -= 1;
      }
    };
    take(coreN, ['affinity']);
    take(bridgeN, ['neighborhood']);
    take(total - picks.length, ['affinity', 'neighborhood', 'daypart', 'cultural', 'discovery']);

    if (picks.length < 4) continue;

    mixes.push({
      id: `mix-${axis.cluster.toLowerCase().replace(/\s+/g, '-')}-${axis.mood}`,
      title: `${axis.cluster} Mix`,
      subtitle: `${axis.mood} · ${picks.length} songs`,
      artwork: picks[0].artwork ?? '',
      tracks: picks,
      clusterLabel: axis.cluster,
      moodLabel: axis.mood,
    });
  }

  // Rank mixes by strongest cluster affinity.
  return mixes
    .map((m) => ({
      mix: m,
      strength: Math.max(0, ...m.tracks.slice(0, 3).map((t) => artistAffinity(profile, t.artist, now))),
    }))
    .sort((a, b) => b.strength - a.strength)
    .slice(0, Math.max(CADENCE.mixesMin, Math.min(mixes.length, CADENCE.mixesMax)))
    .map((x) => x.mix);
}

function featOf(t: Track): Candidate['features'] {
  return estimateFeatures({ artist: t.artist, title: t.title, album: t.album });
}

/** Mixes refresh cadence: nightly + after every 3rd session (§9.5). */
export function shouldRefreshMixes(lastBuildTs: number, sessionsSinceBuild: number, now: number): boolean {
  const dayChanged = new Date(lastBuildTs).toDateString() !== new Date(now).toDateString();
  return dayChanged || sessionsSinceBuild >= CADENCE.refreshAfterSessions;
}
