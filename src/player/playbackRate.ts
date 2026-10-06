/**
 * PLAYBACK SPEED (THE TEN · FEATURE 3) — 0.75×–2× via RNTP's setRate
 * (verified present in v4.1.1's public API). ExoPlayer time-stretches
 * with Sonic — pitch is preserved (a 1.25× lecture keeps a natural
 * voice). The UI label says "pitch stays natural" and the engine note
 * stays honest: pitch preservation is the native engine's behavior,
 * not something this module can guarantee on every device.
 *
 * RNTP v4 exposes NO remote (notification) speed capability — the
 * control is in-app by design (documented honest limitation).
 *
 * The last choice persists (`tsf.playbackRate.v1`) and re-applies at
 * play time (queue start + service loads), so a 1.5× session survives
 * restarts. 1.0× is always one tap away — it is a member of the chip
 * row and the boot default.
 */

import TrackPlayer from 'react-native-track-player';
import { PLAYBACK_RATE } from '../ai/core/constants';
import { getPlaybackRateSetting, setPlaybackRateSetting } from '../storage/store';

/** The allowed set (PLAYBACK_RATE.allowed) as a plain number list. */
export const ALLOWED_RATES: readonly number[] = PLAYBACK_RATE.allowed;

/**
 * Snap any incoming value to the nearest allowed rate — 3.0 → 2.0,
 * 0.1 → 0.75, NaN → 1.0. The lock pins the literal snaps.
 */
export function nearestAllowedRate(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : (PLAYBACK_RATE.defaultRate as number);
  let best: number = PLAYBACK_RATE.allowed[0];
  let bestDist = Infinity;
  for (const r of PLAYBACK_RATE.allowed) {
    const d = Math.abs(r - n);
    if (d < bestDist) {
      bestDist = d;
      best = r;
    }
  }
  return best;
}

let rate: number = PLAYBACK_RATE.defaultRate;
let booted = false;
type Listener = (r: number) => void;
const listeners = new Set<Listener>();

export function currentRate(): number {
  return rate;
}

async function applyToPlayer(): Promise<void> {
  try {
    await TrackPlayer.setRate(rate);
  } catch {
    /* web mock / player not ready — the next apply wins */
  }
}

/** Set + persist + apply. Snaps to the allowed set first. */
export async function setPlaybackRate(v: number): Promise<void> {
  rate = nearestAllowedRate(v);
  await setPlaybackRateSetting(rate).catch(() => undefined);
  await applyToPlayer();
  listeners.forEach((fn) => fn(rate));
}

export function subscribePlaybackRate(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * One-shot boot read — restores the last choice and pushes it to the
 * engine. Fire-and-forget safe (never blocks playback start). IDEMPOTENT:
 * the background service calls this lazily in a headless context (the
 * UI provider may never have run) — only the first call reads storage.
 */
export function initPlaybackRate(): void {
  if (booted) return;
  booted = true;
  void getPlaybackRateSetting()
    .then((v) => {
      if (typeof v === 'number' && Number.isFinite(v)) {
        rate = nearestAllowedRate(v);
        void applyToPlayer();
      }
    })
    .catch(() => undefined);
}

/**
 * Re-apply the persisted choice at PLAY TIME (after a queue reset the
 * engine's rate is back to 1.0). Called by PlayerProvider after
 * TrackPlayer.play(). Headless contexts boot the rate lazily via
 * initPlaybackRate() in the service instead. Does NOT re-persist — this
 * is a restore, not a user decision.
 */
export function reapplyPlaybackRate(): Promise<void> {
  return applyToPlayer();
}

/** Test/lab reset — back to the boot default (no storage access). */
export function resetPlaybackRateForTests(): void {
  rate = PLAYBACK_RATE.defaultRate;
  booted = false;
  listeners.clear();
}
