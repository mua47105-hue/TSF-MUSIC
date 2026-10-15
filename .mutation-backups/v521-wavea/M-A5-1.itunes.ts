/**
 * iTunes Search provider — on-device fallback for international catalog
 * gaps. Apple's public search API needs no key and returns 30-second
 * AAC previews plus high-res artwork. Used only when JioSaavn comes
 * back thin (network/geo issues) so the user always gets results.
 */

import type { Track } from '../types';
import { fetchWithTimeout } from './fetchWithTimeout';

const ITUNES = 'https://itunes.apple.com/search';

interface ITunesResult {
  trackId: number;
  trackName: string;
  artistName: string;
  collectionName?: string;
  previewUrl?: string;
  artworkUrl100?: string;
  trackTimeMillis?: number;
  /** Free cultural signal (Phase 1): Apple's normalized genre tag. */
  primaryGenreName?: string;
}

export async function searchItunes(
  query: string,
  limit = 20,
  signal?: AbortSignal,
): Promise<Track[]> {
  const qs = new URLSearchParams({
    term: query,
    media: 'music',
    limit: String(limit),
  });
  // v5.2.1 FIX-A5: the signal is now HONORED end-to-end (it used to be
  // accepted as `_signal` and silently dropped — a typed lie), and the
  // request is bounded by the 10s provider ceiling (FIX-A4).
  const res = await fetchWithTimeout(`${ITUNES}?${qs.toString()}`, { signal });
  if (!res.ok) return [];
  const data: { results?: ITunesResult[] } = await res.json();
  return (data.results ?? [])
    .filter((r) => !!r.previewUrl)
    .map((r) => ({
      id: `itunes-${r.trackId}`,
      title: r.trackName,
      artist: r.artistName,
      album: r.collectionName,
      artwork: (r.artworkUrl100 ?? '').replace('100x100bb', '600x600bb'),
      // Only the 30s preview actually plays — advertise the truth.
      duration: 30,
      source: 'itunes' as const,
      previewUrl: r.previewUrl,
      previewOnly: true,
      genre: r.primaryGenreName?.trim() || undefined,
    }));
}
