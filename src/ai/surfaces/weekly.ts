/**
 * THE WEEKLY CRATE (§9.7) — the Discover Weekly surface, done honestly.
 *
 * One edition per ISO week. Where Daily Mixes are today's comfort
 * (60% core), the crate is the week's discovery bet: 35% core anchors /
 * 40% co-play neighborhood / 25% unheard exploration — discovery
 * outweighs every daily surface. ≤30% of last week's crate may return.
 * Every track carries an honest reason line; a crate below the minimum
 * is an embarrassment, so a thin build returns null (no filler).
 *
 * Pure week math lives here (weekKeyOf / weekMonday) so locks can pin
 * the rollover: same week → same crate, new week → new crate.
 */

import { CADENCE } from '../core/constants';
import { decide, reasonLine, buildServeRecency } from '../core/decision';
import type { Candidate } from '../core/types';
import type { Track, WeeklyCrate } from '../../types';
import { type SurfaceCtx } from './deps';
import { mixAxes, type MixPick } from './mixes';
import { blockOf, dayKindOf } from '../core/time';
import { estimateFeatures } from '../core/features';
import { filterClean } from '../../safety';

const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** ISO-8601 week key ('2026-W40'): Monday is day 1; W1 contains the first Thursday. */
export function weekKeyOf(now: number): string {
  const d = new Date(now);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() || 7; // Mon=1 … Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - dayNum); // land on this week's Thursday
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** The Monday that opens the ISO week containing `now` (epoch ms). */
export function weekMonday(now: number): number {
  const d = new Date(now);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() - (dayNum - 1));
  return t.getTime();
}

/** 'W40' → 'Week of Oct 5' — the shelf subtitle voice. */
export function weekLabel(now: number): string {
  const monday = new Date(weekMonday(now));
  return `Week of ${MONTHS[monday.getUTCMonth()]} ${monday.getUTCDate()}`;
}

function featOf(t: Track): Candidate['features'] {
  return estimateFeatures({ artist: t.artist, title: t.title, album: t.album });
}

export async function buildWeeklyCrate(
  ctx: SurfaceCtx,
  prevWeekIds: Set<string>,
): Promise<WeeklyCrate | null> {
  const { api, profile, now } = ctx;
  const axes = mixAxes(profile);
  if (!axes.length) return null;

  const serveRecency = buildServeRecency(ctx.listens);
  // "Unheard" means never-listened, not merely unserved this week —
  // a track played twenty times last month is NOT fresh discovery.
  const heardIds = new Set(ctx.listens.map((l) => l.trackId));
  // Soft language pin: the crate steers discovery toward the ear it knows.
  const topLang =
    Object.entries(profile.languages ?? {})
      .sort((a, b) => (b[1]?.w ?? 0) - (a[1]?.w ?? 0))[0]?.[0];
  const block = blockOf(now, dayKindOf(now), profile.boundaries);
  const weekKey = weekKeyOf(now);

  // Anchors: the top two cluster×mood axes, deduped, keep order.
  const anchors: string[] = [];
  for (const axis of axes.slice(0, 2)) {
    for (const a of axis.clusterArtists.slice(0, 3)) {
      if (!anchors.includes(a)) anchors.push(a);
    }
  }
  if (!anchors.length) return null;

  const trackById = new Map<string, Track>();
  const keep = (t: Track) => trackById.set(t.id, t);

  // Core pool (35%): the anchors' own catalogs.
  const coreCandidates: Candidate[] = [];
  for (const a of anchors.slice(0, 4)) {
    try {
      const tracks = await api.artistTracks(a, 10);
      tracks.forEach(keep);
      coreCandidates.push(...tracks.map((t) => ({ trackId: t.id, artist: t.artist, artistId: t.artistId, language: t.language, features: featOf(t), pool: 'affinity' as const })));
    } catch {
      /* offline — pools below carry the crate */
    }
  }

  // Neighborhood pool (40%): co-play neighbors, deeper than daily mixes
  // (4 neighbors per anchor, 2 anchors of depth).
  const bridgeCandidates: Candidate[] = [];
  const neighborArtists: string[] = [];
  for (const a of anchors.slice(0, 2)) {
    for (const [n] of Object.entries(profile.coplayArtists[a] ?? {}).sort((x, y) => y[1] - x[1]).slice(0, 4)) {
      if (!neighborArtists.includes(n) && !anchors.includes(n)) neighborArtists.push(n);
    }
  }
  for (const a of neighborArtists.slice(0, 5)) {
    try {
      const tracks = await api.artistTracks(a, 8);
      tracks.forEach(keep);
      bridgeCandidates.push(...tracks.map((t) => ({ trackId: t.id, artist: t.artist, artistId: t.artistId, language: t.language, features: featOf(t), pool: 'neighborhood' as const })));
    } catch {
      /* offline */
    }
  }

  // Discovery pool (25%): unheard finds around the anchors. Prefer
  // artists the ledger has never met — that is the crate's soul.
  const freshCandidates: Candidate[] = [];
  const knownArtists = new Set(Object.keys(profile.artists ?? {}).map((a) => a.toLowerCase()));
  for (const a of anchors.slice(0, 2)) {
    try {
      const tracks = await api.search(`${a} songs`, 12);
      tracks.forEach(keep);
      const unheard = tracks.filter((t) => !heardIds.has(t.id) && !serveRecency.has(t.id));
      unheard.sort((x, y) => {
        const xNew = knownArtists.has(x.artist.trim().toLowerCase()) ? 1 : 0;
        const yNew = knownArtists.has(y.artist.trim().toLowerCase()) ? 1 : 0;
        if (xNew !== yNew) return xNew - yNew; // unknown artists first
        if (topLang) {
          const xLang = x.language === topLang ? 0 : 1;
          const yLang = y.language === topLang ? 0 : 1;
          if (xLang !== yLang) return xLang - yLang; // the ear it knows next
        }
        return 0;
      });
      freshCandidates.push(...unheard.map((t) => ({ trackId: t.id, artist: t.artist, artistId: t.artistId, language: t.language, features: featOf(t), pool: 'discovery' as const })));
    } catch {
      /* offline — core+bridge carry the crate */
    }
  }

  const all = [...coreCandidates, ...bridgeCandidates, ...freshCandidates];
  const ranked = decide(
    all,
    {
      surface: 'weekly_crate',
      block,
      dayKind: dayKindOf(now),
      seedTrackIds: [],
      seedArtists: anchors,
      requested: CADENCE.weeklySize,
    },
    { profile, session: ctx.session, now },
    { serveRecency, banditArms: ctx.banditArms },
  );
  if (ranked.length < CADENCE.weeklyMinTracks) return null;

  // Assemble with RESERVED lanes: core 35% → bridge 40% → a RESERVED
  // discovery 25% BEFORE the all-pools fill. Without the reservation the
  // affinity leftovers outrank unheard finds and the soul of the crate
  // becomes whatever the ranker leaks (critic round: quota-after-rank ban).
  const [coreShare, bridgeShare, discShare] = CADENCE.weeklyCoreBridgeFresh;
  const total = Math.min(CADENCE.weeklySize, ranked.length);
  const coreN = Math.round(total * coreShare);
  const bridgeN = Math.round(total * bridgeShare);
  const discN = Math.round(total * discShare);

  const picks: MixPick[] = [];
  let prevCount = 0;
  const maxPrev = Math.ceil(total * CADENCE.weeklyMaxPrevRepeat);

  const take = (n: number, pools: Array<Candidate['pool']>) => {
    for (const c of ranked) {
      if (n <= 0 || picks.length >= total) break;
      if (picks.some((p) => p.id === c.trackId)) continue;
      if (!pools.includes(c.pool)) continue;
      const track = trackById.get(c.trackId);
      if (!track) continue;
      const isPrev = prevWeekIds.has(c.trackId);
      if (isPrev && prevCount >= maxPrev) continue;
      if (isPrev) prevCount += 1;
      picks.push({
        ...track,
        isRecommended: true,
        reason: reasonLine(c.reasonCode, track.artist.split(' feat')[0]),
        reasonCode: c.reasonCode,
        exploration: c.explorationSlot,
      });
      ctx.onExposure?.(c.trackId, 'weekly_crate', picks.length, c.explorationSlot);
      n -= 1;
    }
  };
  take(coreN, ['affinity']);
  take(bridgeN, ['neighborhood']);
  take(discN, ['discovery']); // reserved — the soul is not a leftover
  take(total - picks.length, ['affinity', 'neighborhood', 'discovery']);

  // Defense in depth: the crate owns its own safety contract — whatever
  // catalog impl feeds it, nothing explicit or flagged ships (critic round).
  const clean = filterClean(picks);
  if (clean.length < CADENCE.weeklyMinTracks) return null;

  return {
    id: `weekly-crate-${weekKey.toLowerCase()}`,
    title: 'The Weekly Crate',
    subtitle: `${weekLabel(now)} · ${clean.length} tracks`,
    artwork: clean[0].artwork ?? '',
    tracks: clean,
    weekKey,
  };
}
