/**
 * Surface layer shared context — dependency-injected catalog access.
 *
 * Surfaces never import the saavn API directly: they receive a CatalogApi.
 * The app injects the real JioSaavn adapter; replay tests inject fixture
 * fakes. That keeps the whole surface layer runnable in Node (§11.1).
 */

import type { Track } from '../../types';
import { estimateFeatures } from '../core/features';
import type { BanditArms } from '../core/bandit';
import type { Candidate, SessionState, SourceSurface, TasteProfile } from '../core/types';
import type { ListenRecord } from '../core/types';

export interface CatalogApi {
  search(query: string, limit?: number): Promise<Track[]>;
  artistTracks(artist: string, limit?: number): Promise<Track[]>;
  trending(limit?: number): Promise<Track[]>;
}

export interface SurfaceCtx {
  api: CatalogApi;
  profile: TasteProfile;
  session: SessionState;
  now: number;
  /** Recent graded listens (7–180d) for dedup + trust stats. */
  listens: ListenRecord[];
  /** Emit REC_EXPOSURE for every served recommendation (survivorship-safe §5.1). */
  onExposure?: (trackId: string, surface: SourceSurface, rankInPool: number, exploration: boolean) => void;
  /** GENIUS P3 — bandit arms (kv-backed, capped). Absent → the engine's
   *  bandit term is 0 for every candidate (byte-identical legacy scoring). */
  banditArms?: BanditArms;
}

/** Track → engine candidate (proxy features attached). */
export function toCandidate(track: Track, pool: Candidate['pool']): Candidate {
  return {
    trackId: track.id,
    artist: track.artist,
    artistId: track.artistId,
    language: track.language,
    // GENIUS P1: captured genre rides into scoring (0.4 × genreAffinity
    // term) — was hardcoded `undefined` and threw the free evidence away.
    genre: track.genre,
    features: estimateFeatures({
      artist: track.artist,
      title: track.title,
      album: track.album,
      genres: track.genre ? [track.genre] : undefined,
    }),
    pool,
  };
}

/** Safety-filtered, playable, non-preview candidates from a search. */
export async function searchCandidates(
  api: CatalogApi,
  query: string,
  pool: Candidate['pool'],
  limit = 20,
): Promise<Candidate[]> {
  try {
    const tracks = await api.search(query, limit);
    return tracks.map((t) => toCandidate(t, pool));
  } catch {
    return [];
  }
}

export async function artistCandidates(
  api: CatalogApi,
  artist: string,
  pool: Candidate['pool'],
  limit = 14,
): Promise<Candidate[]> {
  try {
    const tracks = await api.artistTracks(artist, limit);
    return tracks.map((t) => toCandidate(t, pool));
  } catch {
    return [];
  }
}

/** Distinct (artist, title) filter applied to final track outputs. */
export function distinctTracks<T extends { id: string }>(tracks: T[]): T[] {
  const seen = new Set<string>();
  return tracks.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}
