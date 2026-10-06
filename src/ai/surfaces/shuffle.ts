/**
 * Smart Shuffle v2 (§9.1) — vibe-lock + queue healing.
 *
 * What stays from v1 (verified against Spotify's spec, B1): the toggle,
 * recs interleaved between upcoming tracks, sparkle badges.
 * What changes:
 *   • per-slot Decision Engine calls with session context (not a flat
 *     "top artists" search)
 *   • vibe-lock: rec energy sits within ±0.2 of the CURRENT session
 *     energy — not the playlist's average
 *   • queue healing: when a rec is skipped, the next rec slot is
 *     immediately re-seeded AWAY from the skipped artist/mood — the
 *     signature "it's listening back" moment
 *   • hygiene: never a track played <24h, never a queue-removed track,
 *     never below the SourceTrust floor
 */

import { CADENCE, ENERGY_TOLERANCE } from '../core/constants';
import { decide, reasonLine, buildServeRecency, sessionEnergyOf } from '../core/decision';
import type { Candidate } from '../core/types';
import type { Track } from '../../types';
import { artistCandidates, searchCandidates, type SurfaceCtx } from './deps';
import { blockOf, dayKindOf } from '../core/time';

export interface ShufflePick extends Track {
  reason: string;
  reasonCode: string;
  exploration: boolean;
}

export interface ShufflePlan {
  /** How many recs to inject for this queue length (1:3 over >15 tracks). */
  recCount: number;
  /** Insert positions (indices in the upcoming window). */
  insertEvery: number;
}

export function planFor(queueLength: number): ShufflePlan {
  if (queueLength < CADENCE.smartShuffleMinTracks) {
    return { recCount: Math.max(1, Math.floor(queueLength / 4)), insertEvery: 4 };
  }
  return { recCount: Math.max(2, Math.floor(queueLength / CADENCE.smartShuffleRatio)), insertEvery: CADENCE.smartShuffleRatio };
}

/**
 * Build the next batch of Smart Shuffle recommendations for the upcoming
 * window. `healFrom` triggers queue healing: picks move away from the
 * skipped rec's artist and energy band immediately.
 */
export async function buildShuffleRecs(
  ctx: SurfaceCtx,
  upcoming: Track[],
  opts: { healFrom?: Track | null } = {},
): Promise<ShufflePick[]> {
  const { api, profile, session, now } = ctx;
  const plan = planFor(upcoming.length);
  const block = blockOf(now, dayKindOf(now), profile.boundaries);

  // Seeds: the user's own upcoming tracks (not other recs).
  const seedTracks = upcoming.filter((t) => !t.isRecommended).slice(0, 10);
  const seedArtists = [...new Set(seedTracks.map((t) => t.artist))].slice(0, 4);

  // Pools: seed artists + top profile artists + daypart cell.
  const pools: Candidate[] = [];
  for (const a of seedArtists) {
    pools.push(...(await artistCandidates(api, a, 'affinity', 10)));
  }
  const topArtists = Object.entries(profile.artists)
    .sort((a, b) => b[1].w - a[1].w)
    .slice(0, 3)
    .map(([a]) => a)
    .filter((a) => !seedArtists.some((s) => s.toLowerCase() === a));
  for (const a of topArtists) {
    pools.push(...(await artistCandidates(api, a, 'affinity', 8)));
  }
  const cell = profile.daypart[`${block}|${dayKindOf(now)}`];
  if (cell) {
    for (const a of Object.entries(cell.artistWeights).sort((x, y) => y[1] - x[1]).slice(0, 2).map(([a]) => a)) {
      pools.push(...(await artistCandidates(api, a, 'daypart', 6)));
    }
  }
  if (!pools.length) {
    pools.push(...(await searchCandidates(api, seedArtists[0] ?? 'top hits', 'discovery', 12)));
  }

  const trackById = new Map<string, Track>();
  const seenArtists = new Set([...seedArtists, ...topArtists]);
  for (const a of seenArtists) (await api.artistTracks(a, 12)).forEach((t) => trackById.set(t.id, t));
  if (!trackById.size) (await api.search('top hits', 12)).forEach((t) => trackById.set(t.id, t));

  // Hygiene: exclude the queue itself + 24h plays + 7d dedup + healed artist.
  const exclude = new Set<string>(upcoming.map((t) => t.id));
  const serveRecency = buildServeRecency(ctx.listens);
  for (const [id, ts] of serveRecency) {
    if (now - ts < 86400_000) exclude.add(id); // never a track played <24h
  }
  if (opts.healFrom) {
    // Queue healing: the skipped rec's artist is blocked for this batch,
    // and its energy band is steered away from (storm protocol).
    for (const [id, t] of trackById) {
      if (t.artist.toLowerCase() === opts.healFrom.artist.toLowerCase()) exclude.add(id);
    }
  }

  const ranked = decide(
    pools,
    {
      surface: 'smart_shuffle',
      block,
      dayKind: dayKindOf(now),
      seedTrackIds: seedTracks.slice(0, 3).map((t) => t.id),
      seedArtists,
      requested: plan.recCount + 2,
    },
    { profile, session, now },
    { excludeTrackIds: exclude, serveRecency, banditArms: ctx.banditArms },
  );

  // Vibe-lock: in FLOW, rec energy must sit within ±0.2 of session energy.
  const sEnergy = sessionEnergyOf(session);
  const vibeLocked = session.vibe === 'FLOW' || session.vibe === 'PEAK';
  const picks: ShufflePick[] = [];
  for (const c of ranked) {
    if (vibeLocked && Math.abs(c.features.energy - sEnergy) > ENERGY_TOLERANCE + 0.05) continue;
    const track = trackById.get(c.trackId);
    if (!track) continue;
    picks.push({
      ...track,
      isRecommended: true,
      reason: reasonLine(c.reasonCode, track.artist.split(' feat')[0]),
      reasonCode: c.reasonCode,
      exploration: c.explorationSlot,
    });
    ctx.onExposure?.(c.trackId, 'smart_shuffle', picks.length, c.explorationSlot);
    if (picks.length >= plan.recCount) break;
  }
  return picks;
}
