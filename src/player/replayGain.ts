/**
 * REPLAYGAIN (WAVE B · B1) — per-track loudness normalization, the
 * Spotify-style fix for the quiet-indie → loud-EDM eardrum whiplash.
 *
 * THE MODEL (pure math, zero DSP, zero servers):
 *   gain(dB)  = REPLAY_GAIN.targetLufs − track loudness, clamped ±6 dB
 *   factor    = 10^(gain/20)            (the dB→linear conversion)
 *   missing loudness ⇒ gain 0 dB ⇒ factor EXACTLY 1.0 — the honest
 *   no-op: a track with no baked loudness evidence is never touched,
 *   byte-identical to the pre-B1 app.
 *
 * LAWS:
 *  - Routes through the volume bus (X4 — volume discipline): the ONLY
 *    write path is setReplayGainFactor(); this module NEVER calls
 *    TrackPlayer.setVolume (a direct call would be a P0 race against
 *    sleep/focus/crossfade).
 *  - PERSISTENT, not a fade: ReplayGain does not participate in the
 *    single-owner fade precedence — it multiplies ALONGSIDE Smart
 *    Volume and the honored fade (both multiply, never race).
 *  - POTATO BUDGET (X6): one Map.get + one Math.pow per track CHANGE.
 *    Nothing per frame, nothing on the audio thread, no timers.
 *  - THE LOUDNESS SOURCE: mindbeat.bakedLoudnessFor() (the baked `l`
 *    column). The current bake predates the column — until a bake
 *    carries loudness, every lookup is null and the factor is 1.0 for
 *    every track (the wiring is live; the data is the honest gap).
 *    computeGain() also accepts a track's own `loudness` field, so
 *    any future source plugs in with zero changes here.
 */

import { REPLAY_GAIN } from '../ai/core/constants';
import { setReplayGainFactor } from './volumeBus';

/** The slice of Track the gain math is allowed to read. */
export interface GainTrackInput {
  /** Baked loudness in LUFS (a negative dB reference, e.g. -10 for a
   *  loud master, -18 for a quiet one). Missing ⇒ no adjustment. */
  loudness?: number | null;
}

/**
 * THE PURE CORE — track → gain in dB, clamped to
 * [-REPLAY_GAIN.maxCutDb, +REPLAY_GAIN.maxBoostDb].
 * THE BAR literals: loudness −10 ⇒ −4 dB (quieter); loudness −18 ⇒
 * +4 dB (louder); missing/NaN/Infinity ⇒ 0 dB.
 */
export function computeGain(track: GainTrackInput): number {
  const loudness = track?.loudness;
  if (typeof loudness !== 'number' || !Number.isFinite(loudness)) return 0;
  const raw = REPLAY_GAIN.targetLufs - loudness;
  return Math.max(-REPLAY_GAIN.maxCutDb, Math.min(REPLAY_GAIN.maxBoostDb, raw));
}

/** dB → linear gain: 10^(dB/20). 0 dB ⇒ exactly 1.0. */
export function gainToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/** Convenience: raw loudness (or a track) → the linear factor directly.
 *  Missing loudness ⇒ exactly 1.0. */
export function replayGainFactor(
  loudness: number | null | undefined | GainTrackInput,
): number {
  const t: GainTrackInput =
    typeof loudness === 'object' && loudness !== null
      ? loudness
      : { loudness };
  return gainToLinear(computeGain(t));
}

/**
 * Per-track apply — the PlayerProvider (foreground) and the service
 * (headless transitions) call this on every track change with the
 * track's BAKED loudness (null when the table has no row/column).
 * Pushes the linear factor through the bus; returns what was applied
 * (for tests + debug surfaces). The factor is PERSISTENT: it stays
 * until the next track change rewrites it — no fade, no decay.
 */
export function applyReplayGainForTrack(
  loudness: number | null | undefined,
): number {
  const f = replayGainFactor(loudness);
  setReplayGainFactor(f);
  return f;
}
