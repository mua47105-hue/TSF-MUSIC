/**
 * SEARCH SEATBELT (v5.2.1 FIX-B3) — the pure final-paint law behind
 * SearchScreen's SEATBELT block.
 *
 * THE GUARANTEE (Android E2E lab, round 8 — audit M8 survived with no
 * lock): the same generation's final paint must never regress below its
 * own early paint — a late zero (engine settling empty after page-2+
 * rows already appended) can't unsee rows the user can already read.
 *
 * THE LAW: late paint empty + early paint non-empty ⇒ keep the early
 * rows. Any other combination ⇒ the late paint wins (real zero results
 * must still be able to REPLACE stale rows from an earlier generation).
 * Pure — no React, no RN — locked in tests/fix_v521_waveB_locks; the
 * wiring is pinned by a source law on SearchScreen.tsx.
 */

import type { Track } from '../types';

export function seatbeltPaint(late: Track[], prev: Track[]): Track[] {
  if (late.length === 0 && prev.length > 0) return prev; // a late zero can't unsee rows
  return late;
}
