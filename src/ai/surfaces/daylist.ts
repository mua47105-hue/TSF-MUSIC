/**
 * Daylist — "Now Sound" (§9.4) — time intelligence, surfaced.
 *
 * The Heggli five-block × weekday/weekend model (§6.3) as a living
 * playlist: the CURRENT block's cell decides who plays. Microgenre names
 * in the verified daylist pattern (descriptor + microgenre + context):
 * "Midnight Riyaz", "Monsoon Ghazals", "Gym-time Bhangra"…
 */

import { decide, reasonLine, buildServeRecency } from '../core/decision';
import type { BlockName } from '../core/constants';
import type { Track } from '../../types';
import { artistCandidates, type SurfaceCtx } from './deps';
import { blockOf, dayKindOf } from '../core/time';
import { estimateFeatures } from '../core/features';

export interface NowSoundCard {
  id: string;
  title: string;
  subtitle: string;
  block: BlockName;
  tracks: Array<Track & { reason: string; reasonCode: string; exploration: boolean }>;
}

const BLOCK_LABEL: Record<BlockName, string> = {
  morning: 'Morning',
  afternoon: 'Afternoon',
  evening: 'Evening',
  night: 'Night',
  lateNight: 'Late Night',
};

/** Microgenre name bank (§15) — descriptor × block × language flavor. */
const NAME_PARTS: Record<BlockName, string[]> = {
  morning: ['Riyaz', 'Sunrise', 'Uthne ka Time', 'Fresh Chai'],
  afternoon: ['Siesta', 'Workday', 'Daftar Beats', 'Afternoon Acoustic'],
  evening: ['Sunset', 'Golden Hour', 'Shaam-e-'],
  night: ['Midnight', 'Neon', 'Raat Ki'],
  lateNight: ['3 AM', 'Moonlight', 'Soyi Hui Duniya'],
};

function microgenreName(block: BlockName, moodLabel: string, language?: string): string {
  const parts = NAME_PARTS[block];
  const pick = parts[Math.abs(hashLite(moodLabel + block)) % parts.length];
  const lang = language && language !== 'unknown' ? ` ${titleCase(language)}` : '';
  return `${pick}${lang} ${titleCase(moodLabel)}`;
}

function hashLite(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function buildNowSound(ctx: SurfaceCtx, count = 12): Promise<NowSoundCard | null> {
  const { api, profile, session, now } = ctx;
  const block = blockOf(now, dayKindOf(now), profile.boundaries);
  const dayKind = dayKindOf(now);
  const cell = profile.daypart[`${block}|${dayKind}`];

  const daypartArtists = cell
    ? Object.entries(cell.artistWeights).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a]) => a)
    : [];
  const fallbackArtists = Object.entries(profile.artists)
    .sort((a, b) => b[1].w - a[1].w)
    .slice(0, 2)
    .map(([a]) => a);
  const artists = [...new Set([...daypartArtists, ...fallbackArtists])].slice(0, 3);
  if (!artists.length) return null;

  const trackById = new Map<string, Track>();
  const pools = [];
  for (const a of artists) {
    const tracks = await api.artistTracks(a, 8);
    tracks.forEach((t) => trackById.set(t.id, t));
    pools.push(
      ...tracks.map((t) => ({
        trackId: t.id,
        artist: t.artist,
        artistId: t.artistId,
        language: t.language,
        features: estimateFeatures({ artist: t.artist, title: t.title, album: t.album }),
        pool: cell && daypartArtists.includes(a) ? ('daypart' as const) : ('affinity' as const),
      })),
    );
  }
  if (!pools.length) return null;

  const serveRecency = buildServeRecency(ctx.listens);
  const ranked = decide(
    pools,
    {
      surface: 'daylist',
      block,
      dayKind,
      seedTrackIds: [],
      seedArtists: artists,
      requested: count,
    },
    { profile, session, now },
    { excludeTrackIds: new Set(), serveRecency, banditArms: ctx.banditArms },
  );

  const picks = ranked
    .map((c) => {
      const track = trackById.get(c.trackId);
      if (!track) return null;
      return {
        ...track,
        reason: reasonLine(c.reasonCode, track.artist.split(' feat')[0]),
        reasonCode: c.reasonCode,
        exploration: c.explorationSlot,
      };
    })
    .filter(Boolean) as NowSoundCard['tracks'];

  if (!picks.length) return null;

  const moodLabel = profile.clusters.moodCells[0]?.label ?? 'Vibe';
  const topLanguage = Object.entries(profile.languages).sort((a, b) => b[1].w - a[1].w)[0]?.[0];
  const name = microgenreName(block, moodLabel, topLanguage);

  return {
    id: `now-sound-${block}-${new Date(now).toDateString().toLowerCase().replace(/\s+/g, '-')}`,
    title: name,
    subtitle: `${BLOCK_LABEL[block]} · updates with your day`,
    block,
    tracks: picks,
  };
}
