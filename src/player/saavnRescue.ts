/**
 * THE TEN F4 — the by-id SAAVN RESCUE (the playback rung that makes the
 * smart crates playable).
 *
 * The smart crates (and stats' top tracks) reconstruct rows from the
 * Event Ledger, which stores NO stream URLs. A URL-less saavn row gets
 * ONE by-id rescue (provider song.getDetails) before being dropped —
 * the same honest contract as the YouTube retry ladder. Failures are
 * negative-cached for the session (capped) so a crate of un-enriched
 * rows never probes the same dead id twice (the YT ladder's LRU idea).
 *
 * Pure and injectable: `fetchById` is a parameter, so the locks drive
 * this with a scripted double — no network in tests, no theatre.
 */

import { resolveStreamUrl } from '../api/saavn';
import type { Track } from '../types';

export type FetchSongById = (songId: string) => Promise<Track | null>;

/** Session cap on remembered dead ids (potato rule ⑧ — bounded memory). */
const FAILED_CAP = 200;
const failedIds = new Set<string>();

/**
 * The provider id a ledger-reconstructed saavn row can be refreshed by.
 * YouTube/itunes rows never rescue (null, and the fetcher is never
 * called); 'saavn-123' strips to '123'; rows with no id at all are
 * unrescuable.
 */
export function saavnRescueId(t: Track): string | null {
  if (t.source !== 'saavn') return null;
  const rawId = (t.saavnId ?? t.id.replace(/^saavn-/, '')).trim();
  return rawId || null;
}

/**
 * Fetch the row's provider copy by id (or null). Negative results are
 * remembered for the SESSION (bounded, cleared on restart) — a dead id
 * is never re-probed, so a crate full of gone tracks costs at most one
 * probe per row, ever, per session.
 */
export async function resolveSaavnRow(t: Track, fetchById: FetchSongById): Promise<Track | null> {
  const rawId = saavnRescueId(t);
  if (!rawId) return null;
  if (failedIds.has(rawId)) return null;
  const fresh = await fetchById(rawId).catch(() => null);
  if (!fresh) {
    failedIds.add(rawId);
    if (failedIds.size > FAILED_CAP) {
      const oldest = failedIds.values().next().value;
      if (oldest !== undefined) failedIds.delete(oldest);
    }
    return null;
  }
  return fresh;
}

/** Test/lab reset — drops the negative cache (no network). */
export function resetSaavnRescueForTests(): void {
  failedIds.clear();
}
