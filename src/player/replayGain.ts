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

/** V5.3.0 BAR 1 — the album-mode queue predicate (pure): TRUE when the
 *  queue is ONE album — every row carries a non-empty album name AND all
 *  names agree (trim/lowercase) AND there are ≥2 rows. Any missing/mixed
 *  album field ⇒ false ⇒ per-track gain (the exact v5.2.1 path). */
export function isSingleAlbumQueue(
  active: { album?: string } | null,
  queue: Array<{ album?: string }>,
): boolean {
  if (!active || !queue || queue.length < 2) return false;
  const norm = (s?: string) => (s ?? '').trim().toLowerCase();
  const album = norm(active.album);
  if (!album) return false;
  return queue.every((t) => norm(t.album) === album);
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

/**
 * V5.3.0 BAR 1 — ALBUM MODE (the Spotify default_album_normalization_params
 * semantics, RE report 03 §6 [T1]): an album is normalized as ONE unit, so
 * the intentional inter-track dynamics the mastering engineer baked in
 * (quiet ballad → loud closer) SURVIVE. The album's loudness is the mean
 * of its tracks' baked LUFS; every track in the album then gets the SAME
 * gain = target − albumLufs, clamped ±6 dB. Tracks without loudness
 * evidence contribute nothing to the mean (they are not secretly -14);
 * an album with ZERO evidence rows ⇒ 0 dB exactly (the honest no-op).
 *
 * The literal bars (law ⑩): album mean −18 ⇒ +4 dB for EVERY track (the
 * quiet album gets uniformly louder, dynamics intact); mean −10 ⇒ −4 dB;
 * empty input ⇒ 0; a single track's gain EQUALS its per-track gain (the
 * degenerate album of one).
 */
export function computeAlbumGain(loudnesses: Array<number | null | undefined>): number {
  const present = loudnesses.filter(
    (l): l is number => typeof l === 'number' && Number.isFinite(l),
  );
  if (!present.length) return 0;
  const albumLufs = present.reduce((s, l) => s + l, 0) / present.length;
  const raw = REPLAY_GAIN.targetLufs - albumLufs;
  return Math.max(-REPLAY_GAIN.maxCutDb, Math.min(REPLAY_GAIN.maxBoostDb, raw));
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
 * V5.3.0 BAR 1 — the album-mode apply: same bus contract as
 * applyReplayGainForTrack, but the pushed factor comes from the ALBUM's
 * mean loudness (one gain for the whole record — intra-album dynamics
 * preserved). Returns the applied factor; albumLufs null (no evidence at
 * all) ⇒ factor exactly 1.0, byte-identical to the pre-BAR-1 app.
 */
export function applyAlbumGainForTracks(
  loudnesses: Array<number | null | undefined>,
): number {
  const f = gainToLinear(computeAlbumGain(loudnesses));
  setReplayGainFactor(f);
  return f;
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
