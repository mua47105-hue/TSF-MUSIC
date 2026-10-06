/**
 * CROSSFADE (THE TEN · FEATURE 2) — the honest transition fade.
 *
 * RNTP v4.1.1 exposes NO crossfade API and its single ExoPlayer
 * instance cannot overlap two streams, so a DJ-style audio crossfade
 * is physically impossible in this engine. What ships instead is a
 * VOLUME-automation fade: over the final N seconds of each track the
 * stream ramps toward silence, then the native queue transition lands.
 * Value 0 = no JS interference at all — the engine's own transition,
 * exactly today's behavior (the "gapless attempt": ExoPlayer advances
 * media items natively; on network streams a tiny gap is possible and
 * we say so honestly instead of claiming gapless).
 *
 * The fade owns the volume ONLY through the volume bus (single
 * writer); sleep/focus fades outrank it (VOLUME_FADE_PRECEDENCE —
 * sleep > focus > crossfade), so an armed sleep timer's ramp wins for
 * its window and the crossfade factor resumes automatically after.
 *
 * Headless-safe: the BACKGROUND SERVICE feeds every tick (1s progress
 * events), so the fade works with the UI killed. On web the mock's
 * registerPlaybackService is a no-op — the fade simply doesn't tick
 * there (documented honest limitation, the web build is a lab harness).
 *
 * Setting changes take effect for SUBSEQUENT transitions: the engine
 * reads the live module flag every tick; a mid-fade change to 0
 * releases the ramp immediately. DOCUMENTED DESIGN EDGES (honest
 * trade-offs, not bugs): (a) a track SHORTER than the fade window
 * spends its whole life inside the ramp — it starts below full volume
 * and decays (the fade is measured to each track's own end); (b)
 * ENLARGING the fade mid-ramp re-derives the factor from the longer
 * window on the next tick, which can step the volume DOWN in one move.
 *
 * Transition instants (PlaybackActiveTrackChanged in the service) reset
 * the ramp synchronously — the next track never inherits the previous
 * track's fade. The in-tick backward-jump detector remains as a seek
 * backstop.
 */

import { CROSSFADE } from '../ai/core/constants';
import { getCrossfadeSeconds, setCrossfadeSeconds as persistCrossfadeSeconds } from '../storage/store';
import { clearFadeFactor, setFadeFactor } from './volumeBus';
/**
 * Clamp any incoming value to the legal [0, CROSSFADE.maxSeconds] range
 * (rounded — the UI offers whole seconds). Garbage (NaN, strings that
 * don't parse) ⇒ 0 = off.
 */
export function clampCrossfadeSeconds(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(CROSSFADE.maxSeconds, Math.round(n)));
}

/**
 * Pure fade curve: inside the final `fadeSeconds` the factor ramps
 * linearly to 0; outside it (and whenever fadeSeconds is 0 or the
 * duration is unknown) the factor is 1.0 — no fade.
 */
export function fadeFactorFor(positionSec: number, durationSec: number, fadeSeconds: number): number {
  if (!(fadeSeconds > 0) || !(durationSec > 0)) return 1.0;
  const remaining = durationSec - positionSec;
  if (remaining >= fadeSeconds) return 1.0;
  if (remaining <= 0) return 0.0;
  return Math.max(0, Math.min(1, remaining / fadeSeconds));
}

// ── engine state (module-level: survives sheet unmounts, works headless) ──

let seconds: number = CROSSFADE.defaultSeconds;
let lastPositionSec = -1;
let lastApplied = 1.0;

/** One-shot boot read; fire-and-forget safe. */
export function initCrossfade(): void {
  void getCrossfadeSeconds()
    .then((v) => {
      if (typeof v === 'number') seconds = clampCrossfadeSeconds(v);
    })
    .catch(() => undefined);
}

export function crossfadeSeconds(): number {
  return seconds;
}

/** Flip the preference: the live flag updates SYNCHRONOUSLY (a tap to 0
 *  releases the ramp immediately, before any storage await), then persists. */
export async function setCrossfadeSeconds(v: number): Promise<void> {
  seconds = clampCrossfadeSeconds(v);
  if (seconds === 0) resetCrossfadeRamp();
  await persistCrossfadeSeconds(seconds).catch(() => undefined);
}

/**
 * Feed from the service's 1s progress events. The backward-jump check is
 * the SEEK backstop (a rewind past the tolerance resets the ramp); the
 * transition-instant reset itself lives in the service's
 * PlaybackActiveTrackChanged listener.
 */
export function crossfadeTick(positionSec: number, durationSec: number): void {
  if (positionSec < lastPositionSec - CROSSFADE.backJumpToleranceSec) resetCrossfadeRamp();
  lastPositionSec = positionSec;
  if (seconds <= 0) return;
  const f = fadeFactorFor(positionSec, durationSec, seconds);
  if (f === lastApplied) return;
  lastApplied = f;
  if (f >= 1.0) clearFadeFactor('crossfade');
  else setFadeFactor('crossfade', f);
}

/** Release the ramp (track changed / queue ended / setting off). */
export function resetCrossfadeRamp(): void {
  lastPositionSec = -1;
  lastApplied = 1.0;
  clearFadeFactor('crossfade');
}

/** Test/lab reset — back to the boot default (no storage access). */
export function resetCrossfadeForTests(): void {
  seconds = CROSSFADE.defaultSeconds;
  resetCrossfadeRamp();
}
