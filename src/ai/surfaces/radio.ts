/**
 * Autoplay Radio v2 (§9.2) — multi-seed, drift-controlled, dedup-aware.
 *
 * v1 seeded from one artist + title words. v2:
 *   • multi-seed: last non-rec track + its artist + session window + the
 *     current daypart cell
 *   • drift control: every 5th slot leaves the seed mood for an adjacent
 *     mood cell inside the same artist cluster (the "radio that breathes")
 *   • dedup memory: last 100 serves (7-day TTL) are a hard blocklist
 *   • every track carries a truthful reason line
 *   • endless + background: the PlaybackQueueEnded extension in service.ts
 *     keeps working — this function just makes the picks smarter.
 */

import { CADENCE } from '../core/constants';
import { decide, reasonLine, buildServeRecency } from '../core/decision';
import type { Candidate } from '../core/types';
import type { Track } from '../../types';
import { artistCandidates, searchCandidates, type SurfaceCtx } from './deps';
import { blockOf, dayKindOf } from '../core/time';

export interface RadioPick extends Track {
  reason: string;
  reasonCode: string;
  exploration: boolean;
}

export async function buildRadioV2(
  ctx: SurfaceCtx,
  seed: Track,
  count = 12,
): Promise<RadioPick[]> {
  const { api, profile, session, now } = ctx;

  // ── Candidate pools (always ≥3× the requested size, §8.2) ─────────────
  const pools: Candidate[] = [];
  const block = blockOf(now, dayKindOf(now), profile.boundaries);

  // 1. Seed artist (affinity pool).
  pools.push(...(await artistCandidates(api, seed.artist, 'affinity', 14)));

  // 2. Session window artists (session-true neighborhood).
  const sessionArtists = session.sessionArtists
    ? [...session.sessionArtists.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a]) => a)
    : [];
  for (const a of sessionArtists) {
    if (a.toLowerCase() === seed.artist.toLowerCase()) continue;
    pools.push(...(await artistCandidates(api, a, 'neighborhood', 8)));
  }

  // 3. Daypart cell artists (time-true).
  const cell = profile.daypart[`${block}|${dayKindOf(now)}`];
  if (cell) {
    const cellArtists = Object.entries(cell.artistWeights)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([a]) => a);
    for (const a of cellArtists) {
      pools.push(...(await artistCandidates(api, a, 'daypart', 8)));
    }
  }

  // 4. Discovery: title-word search (v1's trick, kept as a drift source).
  const titleWords = seed.title.replace(/[(\[].*?[)\]]/g, '').split(/\s+/).filter((w) => w.length > 3).slice(0, 2);
  if (titleWords.length) {
    pools.push(...(await searchCandidates(api, titleWords.join(' '), 'discovery', 10)));
  }

  // Map candidates back to their Track objects.
  const trackById = new Map<string, Track>();
  const collect = (t: Track) => trackById.set(t.id, t);
  (await api.artistTracks(seed.artist, 14)).forEach(collect);
  for (const a of sessionArtists) (await api.artistTracks(a, 8)).forEach(collect);
  if (titleWords.length) (await api.search(titleWords.join(' '), 10)).forEach(collect);

  // ── Dedup memory: 7-day hard blocklist (§7.1 dedupSet + listens) ──────
  const serveRecency = buildServeRecency(ctx.listens);
  const exclude = new Set<string>([seed.id]);
  for (const [id, ts] of session.dedupSet) {
    if (now - ts < CADENCE.radioDedupTtlDays * 86400_000) exclude.add(id);
  }
  for (const [id, ts] of serveRecency) {
    if (now - ts < CADENCE.radioDedupTtlDays * 86400_000) exclude.add(id);
  }

  // ── Decide ─────────────────────────────────────────────────────────────
  const ranked = decide(
    pools,
    {
      surface: 'radio',
      block,
      dayKind: dayKindOf(now),
      seedTrackIds: [seed.id],
      seedArtists: [seed.artist, ...sessionArtists],
      requested: count,
    },
    { profile, session, now },
    { excludeTrackIds: exclude, serveRecency, banditArms: ctx.banditArms },
  );

  // ── Drift: every 5th slot swaps toward an adjacent mood cell (§9.2) ────
  const picks: RadioPick[] = [];
  ranked.forEach((c, i) => {
    const track = trackById.get(c.trackId);
    if (!track) return;
    let code = c.reasonCode;
    if ((i + 1) % CADENCE.radioDriftEvery === 0 && i > 0) {
      // Drift slot: prefer the adjacent-mood candidate further down the list.
      const alt = ranked.find(
        (x, j) =>
          j > i &&
          Math.abs(x.features.energy - c.features.energy) >= 0.2 &&
          trackById.has(x.trackId) &&
          !picks.some((p) => p.id === x.trackId),
      );
      if (alt) {
        const altTrack = trackById.get(alt.trackId)!;
        picks.push(withReason(altTrack, 'FITS_BLOCK', alt.explorationSlot));
        ctx.onExposure?.(alt.trackId, 'radio', i + 1, alt.explorationSlot);
        return;
      }
      code = 'FITS_BLOCK';
    }
    picks.push(withReason(track, code, c.explorationSlot));
    ctx.onExposure?.(c.trackId, 'radio', i + 1, c.explorationSlot);
  });

  return picks.slice(0, count);
}

function withReason(track: Track, code: Candidate['reasonCode'] | undefined, exploration: boolean): RadioPick {
  const safeCode = code ?? 'FRESH_FIND';
  return {
    ...track,
    isRecommended: true,
    reason: reasonLine(safeCode, track.artist.split(' feat')[0]),
    reasonCode: safeCode,
    exploration,
  };
}

/** STATION_ENDED bookkeeping for the service (§5.1). */
export function stationEndedPayload(tracksServed: number, avgListenRatio: number) {
  return { tracksServed, avgListenRatio: Math.round(avgListenRatio * 100) / 100 };
}
