/**
 * MAGNUM OPUS WAVE 1 · F4 — CINEMA TRANSITION LOCKS.
 *
 * The bar (mission): the transition plan is pure and exact (at t=0 the
 * rendered rect lands EXACTLY on the tapped row's art, at t=1 on the
 * player hero), the flight is skipped honestly (stale arm, reduce
 * motion, unloaded art, no art), double-taps arm at most once, and the
 * consume is single-use with a TTL.
 */

import { describe, expect, test, beforeEach } from 'bun:test';

import {
  planCinemaFlight,
  shouldFly,
  flightStartDecision,
  armFlight,
  consumeFlight,
  resetCinemaForTests,
  type Rect,
} from '../src/player/cinema';
import { CINEMA } from '../src/ai/core/constants';

const from: Rect = { x: 18, y: 100, width: 44, height: 44 };
const to: Rect = { x: 100, y: 200, width: 300, height: 300 };

beforeEach(() => {
  resetCinemaForTests();
});

describe('F4 · planCinemaFlight (pure, center-origin math)', () => {
  test('at t=0 the center-origin transform lands exactly on `from`', () => {
    const p = planCinemaFlight(from, to);
    expect(p.scale0).toBeCloseTo(44 / 300, 10);
    // center-to-center offsets: (18+22)-(100+150) = -210, (100+22)-(200+150) = -228
    expect(p.dx0).toBeCloseTo(-210, 10);
    expect(p.dy0).toBeCloseTo(-228, 10);
    // rendered t=0 rect: center (40,122) scaled by 44/300 around itself
    const cx = to.x + to.width / 2 + p.dx0;
    const cy = to.y + to.height / 2 + p.dy0;
    const w = to.width * p.scale0;
    expect(cx).toBeCloseTo(from.x + from.width / 2, 10);
    expect(cy).toBeCloseTo(from.y + from.height / 2, 10);
    expect(w).toBeCloseTo(from.width, 10);
  });

  test('identity rects → identity plan', () => {
    const same: Rect = { x: 10, y: 10, width: 200, height: 200 };
    const p = planCinemaFlight(same, same);
    expect(p.dx0).toBe(0);
    expect(p.dy0).toBe(0);
    expect(p.scale0).toBe(1);
  });
});

describe('F4 · shouldFly (honest skips)', () => {
  const ok = { hasFlight: true, expired: false, reducedMotion: false, artworkLoaded: true };
  test('all gates pass → fly', () => {
    expect(shouldFly(ok)).toBe(true);
  });
  test('each gate alone skips the flight', () => {
    expect(shouldFly({ ...ok, hasFlight: false })).toBe(false);
    expect(shouldFly({ ...ok, expired: true })).toBe(false);
    expect(shouldFly({ ...ok, reducedMotion: true })).toBe(false);
    expect(shouldFly({ ...ok, artworkLoaded: false })).toBe(false);
  });
});

describe('F4 · arm/consume lifecycle', () => {
  test('arm then consume: single-use, never replayed', () => {
    armFlight('https://art/1.jpg', from, 1000);
    const f = consumeFlight(1100);
    expect(f?.uri).toBe('https://art/1.jpg');
    expect(f?.from).toEqual(from);
    expect(consumeFlight(1200)).toBeNull(); // consumed — no replay
  });

  test('double-tap: the second arm inside the window is suppressed', () => {
    armFlight('https://art/1.jpg', from, 1000);
    armFlight('https://art/2.jpg', from, 1000 + CINEMA.doubleTapWindowMs - 50);
    const f = consumeFlight(1400);
    expect(f?.uri).toBe('https://art/1.jpg'); // one gesture, one flight
  });

  test('a genuinely second tap (outside the window) re-arms', () => {
    armFlight('https://art/1.jpg', from, 1000);
    armFlight('https://art/2.jpg', from, 1000 + CINEMA.doubleTapWindowMs + 1);
    const f = consumeFlight(1500);
    expect(f?.uri).toBe('https://art/2.jpg');
  });

  test('TTL: a stale arm is consumed to null (honest skip, never a stale flight)', () => {
    armFlight('https://art/1.jpg', from, 1000);
    expect(consumeFlight(1000 + CINEMA.armTtlMs + 1)).toBeNull();
  });

  test('nothing armed → null; empty art or degenerate rect never arms', () => {
    expect(consumeFlight(0)).toBeNull();
    armFlight('', from, 1000);
    armFlight('https://art/x.jpg', { x: 0, y: 0, width: 0, height: 0 }, 1000);
    expect(consumeFlight(1001)).toBeNull();
  });
});

describe('F4 · flightStartDecision (blind-critic P0-1 — the overlay must WAIT, not self-skip)', () => {
  const base = { loaded: false, failed: false, reducedMotion: false, expired: false };
  test('THE P0-1 LOCK: an unloaded, unfailed, unexpired flight WAITS for onLoad — never skips', () => {
    // This is the exact mount-effect state of every real flight (the
    // effect always runs once before the image loads). A mutation of
    // 'wait' → 'skip' (the P0-1 bug: overlay unmounts itself before the
    // animation can ever start) turns this RED.
    expect(flightStartDecision(base)).toBe('wait');
  });
  test('loaded and clean → start', () => {
    expect(flightStartDecision({ ...base, loaded: true })).toBe('start');
  });
  test('each skip gate holds (failed / expired / reduced motion)', () => {
    expect(flightStartDecision({ ...base, failed: true })).toBe('skip');
    expect(flightStartDecision({ ...base, expired: true })).toBe('skip');
    expect(flightStartDecision({ ...base, reducedMotion: true })).toBe('skip');
  });
  test('a load that lands past the arm TTL still skips (stale gesture)', () => {
    expect(flightStartDecision({ ...base, loaded: true, expired: true })).toBe('skip');
  });
  test('the overlay component consumes the decision table (structural lock)', () => {
    const { readFileSync } = require('node:fs');
    const overlay = readFileSync(`${import.meta.dir}/../src/components/CinemaTransition.tsx`, 'utf8');
    expect(overlay).toContain('flightStartDecision(');
    expect(overlay).toContain("action === 'wait'"); // hold for onLoad…
    expect(overlay).toContain('CINEMA.loadWaitMs'); // …bounded by an honest timeout
    expect(overlay).toContain("action === 'skip'");
    expect(overlay).not.toContain('shouldFly'); // the naive gate that caused P0-1 is gone
  });
});

describe('F4 · wiring evidence (BAR X7c)', () => {
  test('TrackRow arms on tap without gating the press; PlayerScreen consumes and renders the overlay', () => {
    const { readFileSync } = require('node:fs');
    const trackRow = readFileSync(`${import.meta.dir}/../src/components/TrackRow.tsx`, 'utf8');
    expect(trackRow).toContain('armFlight');
    expect(trackRow).toContain('measureInWindow');
    expect(trackRow).toContain('onPress?.()'); // the press is never gated by the measure
    const player = readFileSync(`${import.meta.dir}/../src/screens/PlayerScreen.tsx`, 'utf8');
    expect(player).toContain('CinemaTransition');
    expect(player).toContain('consumeFlight()');
    expect(player).toContain('measureInWindow');
  });

  test('the overlay drives transform+opacity only (native driver, zero layout)', () => {
    const { readFileSync } = require('node:fs');
    const overlay = readFileSync(`${import.meta.dir}/../src/components/CinemaTransition.tsx`, 'utf8');
    expect(overlay).toContain('useNativeDriver: true');
    expect(overlay).toContain('pointerEvents="none"');
    expect(overlay).toContain('onLoad'); // art must be loaded before the flight starts
    expect(overlay).toContain('isReduceMotionEnabled');
    expect(overlay).toContain(`duration: CINEMA.durationMs`);
    expect(CINEMA.durationMs).toBeLessThan(400); // the bar itself
  });
});
