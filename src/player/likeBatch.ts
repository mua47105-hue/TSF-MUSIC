/**
 * CRATE LIKE BATCH (v5.2.1 FIX-A2) — the pure core behind CollectionScreen's
 * heart button.
 *
 * THE BUG (forensic audit, honesty violation): the button fired
 * "ADDED TO YOUR CRATES" and wrote nothing. In an app whose brand is
 * "never fabricate", a fake action is unforgivable.
 *
 * THE FIX: the screen now batch-likes every not-yet-favorited track through
 * the REAL PlayerProvider.toggleLike (store write + ledger evidence + UI
 * state), and the summary toast only fires AFTER the last write succeeds.
 * This module is the honest decision core the screen leans on: which rows
 * actually need writing (never re-liking a favorited row — toggle semantics
 * would UN-like it), deduped by id (charts repeat rows), order preserved.
 * Pure — no React, no RN, no storage — locked in tests/fix_v521_waveA_locks.
 */

import type { Track } from '../types';

export function pickUnfavorited(tracks: Track[], favoriteIds: ReadonlySet<string>): Track[] {
  const seen = new Set<string>();
  const fresh: Track[] = [];
  for (const t of tracks) {
    if (!t?.id) continue;
    if (favoriteIds.has(t.id)) continue;
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    fresh.push(t);
  }
  return fresh;
}
