/**
 * SMART VOLUME (THE TEN · FEATURE 1) — ReplayGain-style loudness
 * smoothing from the baked Spotify `energy` column (Phase 2,
 * assets/baked_features.json). No audio analysis, no servers — a pure
 * lookup plus a pure curve:
 *
 *   • bangers (energy > 0.85) attenuate toward 0.82 so the quiet-song →
 *     loud-banger transition stops attacking the eardrum,
 *   • quiet tracks (energy < 0.3) lift toward 1.05,
 *   • everything in between is untouched (multiplier exactly 1.0),
 *   • no baked features ⇒ 1.0 (a no-op — byte-identical to v4.2.0).
 *
 * It NEVER touches the user's device volume — only the player stream
 * level — and it never writes TrackPlayer.setVolume itself: the volume
 * bus owns that write so sleep/crossfade fades compose (multiply).
 *
 * Toggle persistence follows the audioQuality.ts subscribe pattern: the
 * flag loads once at player boot and flips live. Default ON is the
 * documented decision (SMART_VOLUME.defaultOn — Spotify's volume
 * normalization defaults on too; max effect ±0.18): the curve is live
 * from the first frame (before the boot read lands the flag is the
 * documented default, not the pre-feature behavior), and the OFF path
 * re-applies the multiplier as exactly 1.0 the instant it is tapped.
 *
 * The lookup is lazy + cached per track id — an in-memory object access
 * through the mindbeat facade, never a blocker of playback start.
 */

import { SMART_VOLUME } from '../ai/core/constants';
import { getSmartVolumeSetting, setSmartVolumeSetting } from '../storage/store';
import { setSmartVolumeMultiplier } from './volumeBus';

/**
 * THE CURVE — pure, clamped to [SMART_VOLUME.min, SMART_VOLUME.max],
 * monotonic-ish (higher energy ⇒ ≤ multiplier):
 *   energy > highEnergy → linear 1.0 → highFloor across [0.85, 1.0]
 *   energy < lowEnergy  → linear 1.0 → lowLift  across [0.3, 0.0]
 *   else                → 1.0
 * null/undefined/NaN (no baked row) ⇒ 1.0.
 *
 * The ramps extrapolate LINEARLY for energies outside [0,1] (defensive
 * against bad data) and the final clamp is what guarantees the legal
 * range — the clamp is load-bearing, not decorative: e=5 → 0.8, e=-5 →
 * 1.05. Within real baked energies (0..1) behavior is the pure ramp.
 */
export function smartVolumeMultiplier(energy: number | null | undefined): number {
  if (typeof energy !== 'number' || !Number.isFinite(energy)) return 1.0;
  const { highEnergy, lowEnergy, highFloor, lowLift, min, max } = SMART_VOLUME;
  let m = 1.0;
  if (energy > highEnergy) {
    const span = Math.max(1e-6, 1.0 - highEnergy);
    m = 1.0 - ((energy - highEnergy) / span) * (1.0 - highFloor);
  } else if (energy < lowEnergy) {
    const span = Math.max(1e-6, lowEnergy);
    m = 1.0 + ((lowEnergy - energy) / span) * (lowLift - 1.0);
  }
  return Math.max(min, Math.min(max, m));
}

/**
 * The apply-path gate: enabled=false ⇒ 1.0 ALWAYS (byte-identical
 * volume to the pre-feature app, for any energy).
 */
export function effectiveSmartMultiplier(
  energy: number | null | undefined,
  enabled: boolean,
): number {
  return enabled ? smartVolumeMultiplier(energy) : 1.0;
}

// ── persisted toggle (the audioQuality.ts subscribe pattern) ──────────

let active: boolean = SMART_VOLUME.defaultOn;
/** The last energy the apply path saw — the toggle re-applies it so OFF
 *  is byte-identical IMMEDIATELY (not at the next track change). */
let lastEnergy: number | null | undefined;
type Listener = (on: boolean) => void;
const listeners = new Set<Listener>();

/** One-shot boot read; fire-and-forget safe (never blocks playback). */
export function initSmartVolume(): void {
  void getSmartVolumeSetting()
    .then((v) => {
      if (typeof v === 'boolean') {
        active = v;
        listeners.forEach((fn) => fn(active));
      }
    })
    .catch(() => undefined);
}

export function smartVolumeActive(): boolean {
  return active;
}

/** Flip the preference: the flag updates and the bus RE-APPLIES the
 *  current track's multiplier SYNCHRONOUSLY (the OFF path is
 *  byte-identical the instant it is tapped, even while a sleep/crossfade
 *  fade is active — otherwise the shaped multiplier would keep
 *  modulating the fade until the next track change); persistence
 *  follows (a storage failure never blocks the apply). */
export async function setSmartVolumeActive(on: boolean): Promise<void> {
  active = on;
  listeners.forEach((fn) => fn(active));
  applySmartVolumeForTrack(lastEnergy);
  await setSmartVolumeSetting(on).catch(() => undefined);
}

export function subscribeSmartVolume(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Per-track apply — the PlayerProvider calls this on every track change
 * with the track's BAKED energy (null when the table has no row).
 * Pushes the composed multiplier through the bus; returns what was
 * applied (for tests + debug surfaces).
 */
export function applySmartVolumeForTrack(energy: number | null | undefined): number {
  lastEnergy = energy;
  const m = effectiveSmartMultiplier(energy, active);
  setSmartVolumeMultiplier(m);
  return m;
}

/** Test/lab reset — back to the boot default (no storage access). */
export function resetSmartVolumeForTests(): void {
  active = SMART_VOLUME.defaultOn;
  lastEnergy = undefined;
  listeners.clear();
}
