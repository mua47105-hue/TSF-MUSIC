/**
 * LIBRARY ORDER (v5.2.1 FIX-A3) — the pure ordering law behind the
 * Library playlists chip.
 *
 * THE BUG (forensic audit, honesty violation): PlaylistScreen showed
 * "PINNED TO YOUR CRATES" and pinned nothing — no pin concept existed
 * anywhere in the data model.
 *
 * THE FIX: Playlist carries `pinnedAt` (src/types.ts), the store persists
 * it (setPlaylistPinned — serialized, restart-proof), and this module is
 * the ordering law that surfaces it: pinned crates first (newest pin on
 * top), unpinned crates keep the caller's order (stable sort — no silent
 * reshuffle). Pure — no React, no RN, no storage — locked in
 * tests/fix_v521_waveA_locks.
 */

import type { Playlist } from '../types';

export function sortPlaylistsPinnedFirst(list: Playlist[]): Playlist[] {
  return [...list].sort((a, b) => {
    const pa = a.pinnedAt ?? 0;
    const pb = b.pinnedAt ?? 0;
    if (pa && pb) return pb - pa; // both pinned: the newest pin leads
    if (pa) return -1; // pinned before unpinned
    if (pb) return 1;
    return 0; // unpinned: keep the caller's order (stable sort)
  });
}
