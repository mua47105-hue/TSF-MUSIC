/**
 * HAPTIC CHOREOGRAPHY (MAGNUM OPUS · F10) — the pure spec of what the
 * wrist feels, and the one helper that fires it.
 *
 * LAWS:
 *  - hapticEvent() is PURE: action + track + elapsedMs + settings →
 *    a haptic spec | null. No timers, no Date.now, no Math.random —
 *    the throttle is BEAT-INDEX-BASED (the caller owns the memory of
 *    the last fired index), so every decision is reproducible in tests.
 *  - reducedHaptics (persisted, default false = FULL haptics) nulls
 *    EVERY event — the switch is the first line of the function, not a
 *    caller-side afterthought.
 *  - JS THREAD ONLY (X8-audited): expo-haptics is a JS-bridge API, the
 *    fire helper is async on the JS thread, and the audio service
 *    (service.ts) NEVER imports this module. The battery story is
 *    structural: beat ticks only exist inside the open player screen,
 *    and the 500ms fast-class floor caps them at ≤2/second.
 *  - fireHaptic imports expo-haptics LAZILY (potato rule ⑯ — the
 *    module never loads at cold start, and bun tests never touch it).
 */

import { HAPTICS } from '../ai/core/constants';

export type HapticAction = 'beat-tick' | 'heart-tap' | 'crate-generate' | 'bookmark-save';

export type TempoClass = 'slow' | 'mid' | 'fast';

/** The slice of Track the spec is allowed to read. */
export interface HapticTrackInput {
  tempoClass?: TempoClass;
}

export interface HapticsSettings {
  /** the persisted reducedHaptics toggle (false = full haptics, default) */
  reducedHaptics: boolean;
  /** the last beat index a tick fired for (caller-owned memory; the
   *  beat-tick throttle is "one fire per beat, ever", never wall-clock) */
  lastBeatIndex: number;
}

export type HapticSpec =
  | { kind: 'impact'; style: 'light' | 'medium' | 'heavy' | 'soft' | 'rigid' }
  | { kind: 'notification'; style: 'success' | 'warning' | 'error' };

export interface HapticDecision {
  spec: HapticSpec;
  /** beat-tick only: the beat index this decision belongs to — the
   *  caller persists it as settings.lastBeatIndex on the next call. */
  beatIndex?: number;
}

/**
 * THE ONE DECISION TABLE (pure). Returns null = "the wrist stays still":
 * the reduced path, a beat whose index was already fired, or a call
 * that arrived before the module was HYDRATED.
 *
 * v5.0.1 FIX-C3 — THE HYDRATION GATE: the persisted reducedHaptics
 * setting loads ASYNC at player boot; before it lands, callers held the
 * default (false = full haptics), so a beat tick in that window fired
 * for a user who had chosen reduced. `hydrated` starts false and flips
 * ONLY when markHapticsHydrated() is called (the boot read's settle
 * hook) — until then EVERY event is silently null. The default-open
 * behavior is gone: silence before evidence is the honest default.
 */
let hydrated = false;

/** The boot read's settle hook: call once the persisted setting has
 *  landed (value OR honest default after a failed read). Sticky — a
 *  later call never re-closes the gate. */
export function markHapticsHydrated(): void {
  hydrated = true;
}

/** Test/inspection hook: whether the gate is open. */
export function isHapticsHydrated(): boolean {
  return hydrated;
}

/** Test hook: re-arm the un-hydrated state (the locks prove both sides). */
export function resetHapticsHydrationForTests(): void {
  hydrated = false;
}

export function hapticEvent(
  action: HapticAction,
  track: HapticTrackInput,
  elapsedMs: number,
  settings: HapticsSettings,
): HapticDecision | null {
  if (!hydrated) return null; // FIX-C3: no persisted evidence yet — the wrist stays still
  if (settings.reducedHaptics) return null; // the switch is law
  switch (action) {
    case 'beat-tick': {
      const cls: TempoClass = track.tempoClass ?? 'mid';
      const interval = HAPTICS.beatIntervalMs[cls];
      if (!(elapsedMs >= interval)) return null; // the first beat is due AT interval, not at t=0
      const beatIndex = Math.floor(elapsedMs / interval);
      if (beatIndex <= settings.lastBeatIndex) return null; // one fire per beat, ever
      return { spec: { kind: 'impact', style: HAPTICS.beatStyle[cls] }, beatIndex };
    }
    case 'heart-tap':
      // a soft double-kick reads as "kept" without jolting the wrist
      return { spec: { kind: 'impact', style: 'medium' } };
    case 'crate-generate':
      // the AI finished building this week's crate — a success chime
      return { spec: { kind: 'notification', style: 'success' } };
    case 'bookmark-save':
      // a lighter confirmation than the heart: a place, not a feeling
      return { spec: { kind: 'notification', style: 'success' } };
    default:
      return null;
  }
}

/** Fire a spec on the JS thread. NEVER called from the audio service;
 *  failures are swallowed (haptics are never load-bearing). */
export async function fireHaptic(spec: HapticSpec): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Haptics = require('expo-haptics');
    if (spec.kind === 'notification') {
      const style =
        spec.style === 'success'
          ? Haptics.NotificationFeedbackStyle.Success
          : spec.style === 'warning'
            ? Haptics.NotificationFeedbackStyle.Warning
            : Haptics.NotificationFeedbackStyle.Error;
      await Haptics.notificationAsync(style);
    } else {
      const map: Record<string, number> = {
        light: Haptics.ImpactFeedbackStyle.Light,
        medium: Haptics.ImpactFeedbackStyle.Medium,
        heavy: Haptics.ImpactFeedbackStyle.Heavy,
        soft: Haptics.ImpactFeedbackStyle.Soft,
        rigid: Haptics.ImpactFeedbackStyle.Rigid,
      };
      await Haptics.impactAsync(map[spec.style]);
    }
  } catch {
    /* no haptics hardware, or the bridge hiccuped — never fatal */
  }
}
