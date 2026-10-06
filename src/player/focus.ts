/**
 * FOCUS MODE (THE TEN · FEATURE 10) — the Pomodoro study timer that owns
 * the player: one tap strips the UI, queues a focus-friendly playlist,
 * runs 25 minutes, and fades the audio to zero at the end.
 *
 * Architecture mirrors sleepTimer.ts (module-level engine: survives
 * sheet unmounts, owns TrackPlayer) with two deliberate differences:
 *
 *  1. VOLUME: the fade reports to the VOLUME BUS as the 'focus' owner —
 *     the spec-reserved slot from wave 1. PRECEDENCE IS THE LAW: sleep >
 *     focus (VOLUME_FADE_PRECEDENCE), so an armed sleep timer's ramp
 *     outranks the focus fade for its window; the focus factor is stored
 *     and becomes active again when sleep disarms. Cancel/fire release
 *     the factor — the bus restores the remaining sources' product.
 *
 *  2. PHASES: focus → (optional) break → done. The break phase pauses
 *     playback at its start (the study session is over; the break is
 *     silence, not different music — honest and simple).
 *
 * Session-scoped by design: restarting the app clears it, exactly like
 * the sleep timer. The countdown chip subscribes; the engine never
 * blocks the UI.
 *
 * HONEST LIMITATION (shared with the sleep timer): the engine lives in
 * the UI process, and Android throttles JS timers when backgrounded —
 * the wall-clock `endAt` keeps the countdown truthful, but the fade and
 * the fire can land LATE if the session ends while backgrounded.
 *
 * CANCEL SEMANTICS: cancelFocus(resumePlayback) restores the volume
 * (the bus recomputes from the remaining sources) and resumes playback
 * only when the CALLER says so — the UI passes the CURRENT playing
 * state, so the user's own mid-session pause is never overridden.
 */

import TrackPlayer from 'react-native-track-player';
import * as Haptics from 'expo-haptics';
import { FOCUS } from '../ai/core/constants';
import { clearFadeFactor, ownsFade, setFadeFactor } from './volumeBus';

export type FocusPhase = 'focus' | 'break';

export interface FocusState {
  /** epoch ms when the current phase ends; null = disarmed */
  endAt: number | null;
  /** armed minutes of the CURRENT phase (chip label) */
  minutes: number | null;
  phase: FocusPhase | null;
  /** true while the final fade is ramping (the UI can show it) */
  fading: boolean;
}

type Listener = (s: FocusState) => void;

const listeners = new Set<Listener>();
let endAt: number | null = null;
let minutes: number | null = null;
let phase: FocusPhase | null = null;
let fading = false;
let tickTimer: ReturnType<typeof setInterval> | null = null;

function state(): FocusState {
  return { endAt, minutes, phase, fading };
}

function notify() {
  const s = state();
  listeners.forEach((fn) => fn(s));
}

function clearTimers() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

async function hapticPulse() {
  try {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  } catch {
    /* haptics are best-effort (web mock is a no-op) */
  }
}

/** The linear fade factor over FOCUS.fadeMs — the same ramp shape as the
 *  sleep timer. Pure; the lock pins the math. */
export function focusFadeFactor(remainingMs: number): number {
  if (!(FOCUS.fadeMs > 0)) return 1.0;
  if (remainingMs >= FOCUS.fadeMs) return 1.0;
  if (remainingMs <= 0) return 0.0;
  return Math.max(0, Math.min(1, remainingMs / FOCUS.fadeMs));
}

/** Pure timer math: the phase end from an arm decision. */
export function focusEndAt(minutes: number, now: number): number {
  return now + Math.max(1, minutes) * 60_000;
}

let finishing = false;

async function finishPhase() {
  if (finishing) return; // a tick racing skipFocusPhase must not double-fire
  finishing = true;
  try {
    clearTimers();
    fading = false;
    await hapticPulse();
    if (phase === 'focus') {
      // the study session is over: fade released, music paused, break offered
      try {
        await TrackPlayer.pause();
      } catch {
        /* the timer must never crash the app */
      }
      clearFadeFactor('focus'); // the bus restores the remaining sources
      phase = 'break';
      minutes = FOCUS.breakMinutes;
      endAt = focusEndAt(FOCUS.breakMinutes, Date.now());
      notify();
      armTicker();
    } else {
      // the break is over — disarm. Music the user started during the
      // break keeps playing (we only ever pause OUR OWN session end).
      clearFadeFactor('focus');
      phase = null;
      minutes = null;
      endAt = null;
      notify();
    }
  } finally {
    finishing = false;
  }
}

function armTicker() {
  clearTimers();
  tickTimer = setInterval(() => {
    void focusTick(Date.now());
  }, 500);
}

/**
 * One engine tick — separated from the interval so the locks can drive
 * time MANUALLY (no 60-second sleeps): the fade window pushes the ramp
 * factor through the bus; zero fires the phase end.
 */
export function focusTick(now: number): void {
  if (endAt == null) return;
  const remaining = endAt - now;
  if (remaining <= 0) {
    void finishPhase();
    return;
  }
  if (phase === 'focus' && remaining <= FOCUS.fadeMs) {
    fading = true;
    // single-owner law: the sleep timer outranks the focus fade; the
    // focus factor is STORED and takes over the moment sleep disarms.
    setFadeFactor('focus', focusFadeFactor(remaining));
    notify();
  }
}

/** Arm (or re-arm) a focus session for `mins` minutes. */
export function armFocus(mins: number, wasPlaying = false) {
  clearTimers();
  clearFadeFactor('focus'); // any re-arm resets a mid-fade ramp
  void wasPlaying; // retained in the signature for UI symmetry
  phase = 'focus';
  minutes = Math.max(1, mins);
  endAt = focusEndAt(minutes, Date.now());
  fading = false;
  notify();
  armTicker();
}

/**
 * Cancel: volume and UI state restore EXACTLY. The fade factor is
 * released (the bus recomputes from the remaining sources) and the
 * phase is dropped. Playback resumes only when the caller passes
 * resumePlayback (the UI passes the CURRENT playing state — the user's
 * own mid-session pause is never overridden).
 */
export async function cancelFocus(resumePlayback = false) {
  clearTimers();
  clearFadeFactor('focus');
  phase = null;
  minutes = null;
  endAt = null;
  fading = false;
  notify();
  if (resumePlayback) {
    try {
      await TrackPlayer.play();
    } catch {
      /* best-effort */
    }
  }
}

/** Skip the current phase (finish the break early / end focus now). */
export async function skipFocusPhase() {
  if (phase == null) return;
  await finishPhase();
}

export function getFocusState(): FocusState {
  return state();
}

/** True when this engine's fade is the one the bus is honoring. */
export function focusOwnsFade(): boolean {
  return phase != null && ownsFade('focus');
}

export function subscribeFocus(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Test/lab reset — full disarm (no storage, no player calls). */
export function resetFocusForTests(): void {
  clearTimers();
  clearFadeFactor('focus');
  phase = null;
  minutes = null;
  endAt = null;
  fading = false;
  finishing = false;
}
