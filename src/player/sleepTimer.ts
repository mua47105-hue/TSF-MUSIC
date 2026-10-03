/**
 * SLEEP TIMER (Task 28 · godmode) — session-scoped, Spotify-class.
 *
 * The listener arms N minutes; when the window closes the player pauses and
 * the volume returns to full. The last stretch fades the volume down so the
 * queue never dies with a click. Storage-free by design: a sleep timer is a
 * "tonight" decision, not a preference — restarting the app clears it, same
 * as every other player in the market.
 *
 * Single-owner: PlayerScreen subscribes for the countdown chip; the engine
 * itself owns TrackPlayer so it survives sheet unmounts.
 */

import TrackPlayer from 'react-native-track-player';

export interface SleepTimerState {
  /** epoch ms when the timer fires; null = disarmed */
  endAt: number | null;
  /** armed minutes (for chip label), null = disarmed */
  minutes: number | null;
}

type Listener = (s: SleepTimerState) => void;

const listeners = new Set<Listener>();
let endAt: number | null = null;
let minutes: number | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;

/** Fade window: the final 8 seconds ramp volume 1 → 0. */
const FADE_MS = 8000;

function state(): SleepTimerState {
  return { endAt, minutes };
}

function notify() {
  const s = state();
  listeners.forEach((fn) => fn(s));
}

async function setVolume(v: number) {
  try {
    await TrackPlayer.setVolume(Math.max(0, Math.min(1, v)));
  } catch {
    /* volume is best-effort (web mock is a no-op) */
  }
}

async function fire() {
  clearTimers();
  try {
    await TrackPlayer.pause();
  } catch {
    /* the timer must never crash the app */
  }
  await setVolume(1); // restore for the next session
  endAt = null;
  minutes = null;
  notify();
}

function clearTimers() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

/** Arm (or re-arm) the timer for `mins` minutes. */
export function armSleepTimer(mins: number) {
  clearTimers();
  void setVolume(1); // any re-arm resets a mid-fade ramp
  minutes = mins;
  endAt = Date.now() + mins * 60_000;
  notify();
  tickTimer = setInterval(async () => {
    if (endAt == null) {
      clearTimers();
      return;
    }
    const remaining = endAt - Date.now();
    if (remaining <= 0) {
      await fire();
      return;
    }
    if (remaining <= FADE_MS) {
      // linear ramp inside the fade window; no re-arming mid-fade
      await setVolume(remaining / FADE_MS);
    }
  }, 500);
}

/** Disarm — volume restored, playback untouched (user cancelled). */
export function cancelSleepTimer() {
  clearTimers();
  void setVolume(1);
  endAt = null;
  minutes = null;
  notify();
}

export function getSleepTimerState(): SleepTimerState {
  return state();
}

export function subscribeSleepTimer(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
