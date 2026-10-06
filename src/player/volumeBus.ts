/**
 * VOLUME BUS (THE TEN · wave 1) — the single writer of
 * TrackPlayer.setVolume.
 *
 * WHY IT EXISTS: Smart Volume (FEATURE 1) contributes a static per-track
 * multiplier while up to three engines (sleep timer / focus timer /
 * crossfade) may want to fade the stream. If each wrote
 * TrackPlayer.setVolume directly they would overwrite each other — the
 * exact race the mission bar forbids ("sleep fade 0.5 × smart volume
 * 0.85 = 0.425, not a race"). Every volume-affecting feature reports its
 * factor HERE; the bus multiplies and writes ONCE.
 *
 * Model:
 *   effective = smartVolumeMultiplier × activeFadeFactor
 *   - The multiplier is the Smart Volume curve output (1.0 when off or
 *     the track has no baked energy).
 *   - At most ONE fade owner is honored at a time, by
 *     VOLUME_FADE_PRECEDENCE (sleep > focus > crossfade) — FEATURE 10's
 *     single-owner rule. A lower-priority engine's factor is STORED (so
 *     it resumes automatically when the higher one disarms) but never
 *     fights the active one. 'focus' is the spec-reserved slot for
 *     FEATURE 10 (Pomodoro/Focus Mode, wave 4) — nothing writes it yet.
 *
 * No tick loop lives here: owners push their own factor on their own
 * cadence (the sleep timer's 500ms ramp, the crossfade's 1s service
 * ticks). Writes are skipped when the product is unchanged, so repeated
 * ticks at the same factor are free.
 *
 * TrackPlayer.setVolume is best-effort (the web mock is a no-op):
 * failures are swallowed — a volume glitch must never crash playback.
 */

import TrackPlayer from 'react-native-track-player';
import { SMART_VOLUME, VOLUME_FADE_PRECEDENCE } from '../ai/core/constants';

export type FadeOwner = (typeof VOLUME_FADE_PRECEDENCE)[number];

/**
 * Pure composition — the lock pins 0.5 × 0.85 = 0.425 here. The
 * multiplier is clamped to [0, SMART_VOLUME.max] — v4.3.1: the old
 * Math.min(1, …) ceiling was a LIE that silently ate the Smart Volume
 * quiet-track lift (the curve advertised 1.05; the bus shipped 1.0 —
 * the auditor's BAR 2 mutation proved no test watched the write). The
 * lift is now REAL up to the curve's own documented ceiling. The fade
 * factor stays [0,1]: a fade can only attenuate, never boost.
 */
export function composeVolume(multiplier: number, fadeFactor: number): number {
  const m = Math.max(0, Math.min(SMART_VOLUME.max, multiplier));
  const f = Math.max(0, Math.min(1, fadeFactor));
  const v = m * f;
  return Math.max(0, Math.min(SMART_VOLUME.max, v));
}

const factors = new Map<FadeOwner, number>();
let multiplier = 1.0;
let lastWritten = 1.0;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** The ONE honored fade, by precedence; 1.0 when no owner is active. */
export function activeFadeFactor(): number {
  for (const owner of VOLUME_FADE_PRECEDENCE) {
    const f = factors.get(owner);
    if (typeof f === 'number') return clamp01(f);
  }
  return 1.0;
}

function recompute(): void {
  const v = composeVolume(multiplier, activeFadeFactor());
  if (v === lastWritten) return;
  lastWritten = v;
  void TrackPlayer.setVolume(v).catch(() => undefined);
}

/** Smart Volume reports the new track's multiplier (1.0 when off). The
 *  legal range is [0, SMART_VOLUME.max] — the quiet-track lift (>1.0)
 *  is real and must survive this gate (see composeVolume, v4.3.1). */
export function setSmartVolumeMultiplier(m: number): void {
  multiplier = Math.max(0, Math.min(SMART_VOLUME.max, m));
  recompute();
}

/** A fade owner reports its current ramp factor (0..1). */
export function setFadeFactor(owner: FadeOwner, factor: number): void {
  factors.set(owner, clamp01(factor));
  recompute();
}

/**
 * A fade owner releases the fade (fired / cancelled / disarmed / ramp
 * finished) — volume returns to the remaining sources' product. An
 * owner that is outranked while active keeps its stored factor, so
 * clearing it never overwrites the higher-priority owner's ramp.
 */
export function clearFadeFactor(owner: FadeOwner): void {
  factors.delete(owner);
  recompute();
}

/** True when this owner's factor is the one currently honored. */
export function ownsFade(owner: FadeOwner): boolean {
  return activeFadeOwner() === owner;
}

/** The owner currently honored (null = no fade active). */
export function activeFadeOwner(): FadeOwner | null {
  for (const owner of VOLUME_FADE_PRECEDENCE) {
    if (factors.has(owner)) return owner;
  }
  return null;
}

/** Test/lab reset — back to the boot state (no writes). */
export function resetVolumeBusForTests(): void {
  factors.clear();
  multiplier = 1.0;
  lastWritten = 1.0;
}
