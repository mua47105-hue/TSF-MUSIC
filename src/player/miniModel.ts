/**
 * INSTANT TAP model (Task 29 · godmode wave 2) — pure contracts for the
 * two "the app must feel instant" behaviors.
 *
 * ── miniDisplay ────────────────────────────────────────────────────────
 * A row tap previously produced ZERO visual feedback until the stream
 * URL resolved (0.5–1s of dead air: the exact "when I click it takes
 * long" complaint). playQueue now plants an OPTIMISTIC track the moment
 * the user taps; the mini bar renders it immediately with a TUNING IN
 * state. The contract:
 *
 *   - real playback always wins: if TrackPlayer reports an active track,
 *     the optimistic plant is ignored (tuning=false),
 *   - otherwise the optimistic plant shows, flagged tuning=true,
 *   - nothing to show → shown=null (bar hidden).
 *
 * Lifecycle (enforced in PlayerProvider, mirrored here for reference):
 * planted at playQueue entry → cleared when the real track mounts, on
 * any failure path, or after 8s (stale plant = honest reset).
 *
 * ── isDoubleTap ────────────────────────────────────────────────────────
 * Two presses within `windowMs` count as a double-tap (the artwork's
 * double-tap-to-like gesture). Pure so the timing rule is locked.
 */

import type { Track } from '../types';

export interface MiniDisplay {
  shown: Track | null;
  tuning: boolean;
}

export function miniDisplay(active: Track | null, optimistic: Track | null): MiniDisplay {
  if (active) return { shown: active, tuning: false };
  if (optimistic) return { shown: optimistic, tuning: true };
  return { shown: null, tuning: false };
}

export const DOUBLE_TAP_MS = 320;

export function isDoubleTap(now: number, lastAt: number, windowMs: number = DOUBLE_TAP_MS): boolean {
  if (lastAt <= 0) return false;
  const gap = now - lastAt;
  return gap >= 0 && gap <= windowMs;
}
