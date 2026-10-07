/**
 * CINEMA (MAGNUM OPUS F4) — the shared-element-ish flight of a row's
 * album art into the player's hero slot. Pure-JS Animated (the repo has
 * NO react-native-reanimated dependency and potato rule ⑯ forbids
 * adding one for a single transition — the mission provides for the
 * fallback).
 *
 * MODEL:
 *   TrackRow tap        → armFlight(uri, rowArtRect)   (measureInWindow)
 *   PlayerScreen mount  → consumeFlight() → CinemaTransition overlay
 *   overlay             → paints the image at the TARGET rect, driven
 *                         back to the FROM rect by transform only
 *                         (translate+scale+opacity, native driver —
 *                         zero layout, zero JS per frame)
 *
 * HONEST SCOPE: this is a flight overlay, not a true shared-element
 * framework — the navigator still runs its own screen transition
 * underneath. Guards: double-tap suppression (miniModel.isDoubleTap),
 * arm TTL (a stale arm is skipped, never replayed), reduce-motion
 * (no flight at all), unloadable art (no flight).
 *
 * Determinism: the plan math is pure; zero Math.random.
 */

import { CINEMA } from '../ai/core/constants';
import { isDoubleTap } from './miniModel';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CinemaFlight {
  uri: string;
  from: Rect;
  armedAt: number;
}

/** The flight transform the overlay interpolates from (t=0) to identity
 *  (t=1). The overlay renders the image AT THE TARGET RECT and uses
 *  RN's center-origin transform, so the offsets are CENTER-to-center:
 *  at t=0 the rendered rect lands EXACTLY on `from`. */
export interface FlightPlan {
  dx0: number;
  dy0: number;
  scale0: number;
}

export function planCinemaFlight(from: Rect, to: Rect): FlightPlan {
  const scale0 = from.width / Math.max(1, to.width);
  return {
    dx0: from.x + from.width / 2 - (to.x + to.width / 2),
    dy0: from.y + from.height / 2 - (to.y + to.height / 2),
    scale0,
  };
}

/** Pure guard — every gate must pass for a flight to run. */
export function shouldFly(opts: {
  hasFlight: boolean;
  expired: boolean;
  reducedMotion: boolean;
  artworkLoaded: boolean;
}): boolean {
  if (!opts.hasFlight) return false;
  if (opts.expired) return false;
  if (opts.reducedMotion) return false;
  if (!opts.artworkLoaded) return false;
  return true;
}

/**
 * The overlay's mount-effect DECISION TABLE (blind-critic P0-1 fix).
 * The component's effect re-runs on [loaded, failed, reduced]; the bug
 * class it eliminates: the first run happens UNLOADED, so a naive
 * shouldFly() gate would self-skip and unmount before onLoad ever
 * re-runs the effect — the flight could never start. WAIT is the
 * honest third state: neither skip nor start, hold for onLoad (bounded
 * by CINEMA.loadWaitMs in the component).
 */
export type FlightAction = 'start' | 'wait' | 'skip';

export function flightStartDecision(o: {
  loaded: boolean;
  failed: boolean;
  reducedMotion: boolean;
  expired: boolean;
}): FlightAction {
  if (o.failed) return 'skip';
  if (o.expired) return 'skip';
  if (o.reducedMotion) return 'skip';
  if (!o.loaded) return 'wait';
  return 'start';
}

// ── RUNTIME STORE (tiny, sync, window ≤ 1 armed flight) ─────────────────

let armed: CinemaFlight | null = null;
let lastArmAt = 0;

/** TrackRow taps call this (after measureInWindow resolves). A tap
 *  inside miniModel's double-tap window never re-arms — one gesture,
 *  one flight. */
export function armFlight(uri: string, from: Rect, now: number = Date.now()): void {
  if (!uri || from.width <= 0 || from.height <= 0) return; // nothing honest to fly
  if (isDoubleTap(now, lastArmAt)) return;
  lastArmAt = now;
  armed = { uri, from, armedAt: now };
}

/** PlayerScreen consumes on mount (once, plus a single retry). Returns
 *  null when nothing is armed or the arm has gone stale. */
export function consumeFlight(now: number = Date.now()): CinemaFlight | null {
  const f = armed;
  armed = null; // consumed — never replayed
  if (!f) return null;
  if (now - f.armedAt > CINEMA.armTtlMs) return null; // stale gesture
  return f;
}

export function resetCinemaForTests(): void {
  armed = null;
  lastArmAt = 0;
}
