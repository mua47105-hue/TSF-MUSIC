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

/** WAVE B B2 — the persisted genre-aware haptics mode (default 'auto').
 *  'auto'    = the beat pattern follows the TRACK'S GENRE (EDM bars hit
 *              heavy on the downbeat, classical ticks soft on every
 *              beat, lofi stays still) — missing/unknown genre falls
 *              back to the uniform tempo-class behavior,
 *  'uniform' = the legacy tempo-class-only behavior for EVERY track
 *              (also the override that un-silences lofi/ambient),
 *  'off'     = beat ticks disabled entirely (the wrist stays still). */
export type HapticGenreMode = 'auto' | 'uniform' | 'off';

/** The slice of Track the spec is allowed to read. */
export interface HapticTrackInput {
  tempoClass?: TempoClass;
  /** WAVE B B2 — the track's catalog genre (Track.genre, e.g. an iTunes
   *  primaryGenreName). Missing/unknown ⇒ the uniform fallback. */
  genre?: string | null;
}

export interface HapticsSettings {
  /** the persisted reducedHaptics toggle (false = full haptics, default) */
  reducedHaptics: boolean;
  /** the last beat index a tick fired for (caller-owned memory; the
   *  beat-tick throttle is "one fire per beat, ever", never wall-clock) */
  lastBeatIndex: number;
  /** WAVE B B2 — the persisted genre mode (undefined = 'auto'; callers
   *  that predate the mode keep their exact legacy behavior, because
   *  auto + no genre = uniform). */
  genreMode?: HapticGenreMode;
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

// ── WAVE B B2 — the genre pattern table ─────────────────────────────────

/**
 * A genre's beat pattern, resolved PURELY from (genre, tempoClass):
 *   fireOn   — which beat slots of a 4/4 bar fire (compared against
 *              beatIndex % 4); empty = no beat fires,
 *   style    — the impact style of every fired beat,
 *   disabled — the genre's pattern says the wrist stays still by
 *              DEFAULT (lofi/ambient); only the 'uniform' mode
 *              overrides it.
 */
export interface HapticPatternSpec {
  fireOn: number[];
  style: 'light' | 'medium' | 'heavy' | 'soft';
  disabled: boolean;
}

/**
 * Genre alias → pattern family. THE SCAN ORDER IS THE PRECEDENCE:
 * chill families first ("lo-fi hip hop" is lofi, not hip-hop), then the
 * club families, then the seated ones, then the broad pop/rock catch.
 * Matching is exact-string OR containment (iTunes primaryGenreName
 * strings are compounds like "Hip-Hop/Rap" or "Alternative Rock" — the
 * containment pass is what makes real catalog strings resolve).
 */
const GENRE_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['lofi', 'lofi'], ['lo-fi', 'lofi'], ['chillhop', 'lofi'], ['chill-out', 'lofi'], ['downtempo', 'lofi'],
  ['ambient', 'ambient'],
  ['hip-hop', 'hiphop'], ['hip hop', 'hiphop'], ['hiphop', 'hiphop'], ['rap', 'hiphop'], ['trap', 'hiphop'], ['drill', 'hiphop'],
  ['edm', 'edm'], ['electronic', 'edm'], ['dance', 'edm'], ['house', 'edm'], ['techno', 'edm'], ['trance', 'edm'], ['dubstep', 'edm'],
  ['classical', 'classical'], ['orchestral', 'classical'], ['symphony', 'classical'],
  ['jazz', 'jazz'],
  ['bollywood', 'bollywood'],
  ['rock', 'rock'], ['punk', 'rock'], ['metal', 'rock'], ['grunge', 'rock'],
  ['pop', 'pop'],
];

function genreFamily(genre: string | null | undefined): string | null {
  if (typeof genre !== 'string') return null;
  const g = genre.toLowerCase().trim();
  if (!g) return null;
  // pass 1 — exact alias hit ("jazz", "Bollywood")
  for (const [alias, family] of GENRE_ALIASES) {
    if (g === alias) return family;
  }
  // pass 2 — containment for compound catalog strings ("Hip-Hop/Rap")
  for (const [alias, family] of GENRE_ALIASES) {
    if (g.includes(alias)) return family;
  }
  return null;
}

/**
 * THE PATTERN TABLE (pure). Missing/unknown genre ⇒ the UNIFORM
 * fallback (the legacy tempo-class tick — every beat, HAPTICS.beatStyle)
 * so the pre-B2 behavior is byte-identical for genre-less tracks.
 *   EDM/Hip-hop  — heavy impact on beat 1 of every bar (4/4),
 *   Classical/Jazz — a soft tick on every beat,
 *   Bollywood    — medium impact on the downbeats (beats 1 and 3),
 *   Lofi/Ambient — still by default (override via the 'uniform' mode),
 *   Rock/Pop     — medium impact on every beat.
 */
export function hapticPattern(
  genre: string | null | undefined,
  tempoClass: TempoClass,
): HapticPatternSpec {
  const uniform: HapticPatternSpec = {
    fireOn: [0, 1, 2, 3],
    style: HAPTICS.beatStyle[tempoClass],
    disabled: false,
  };
  switch (genreFamily(genre)) {
    case 'edm':
    case 'hiphop':
      return { fireOn: [0], style: 'heavy', disabled: false };
    case 'classical':
    case 'jazz':
      return { fireOn: [0, 1, 2, 3], style: 'soft', disabled: false };
    case 'bollywood':
      return { fireOn: [0, 2], style: 'medium', disabled: false };
    case 'lofi':
    case 'ambient':
      return { fireOn: [], style: 'soft', disabled: true };
    case 'rock':
    case 'pop':
      return { fireOn: [0, 1, 2, 3], style: 'medium', disabled: false };
    default:
      return uniform;
  }
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
      // WAVE B B2 — the persisted genre mode is law (undefined = 'auto',
      // which for genre-less tracks is byte-identical to the legacy tick).
      const mode: HapticGenreMode = settings.genreMode ?? 'auto';
      if (mode === 'off') return null; // the wrist stays still, every beat
      const cls: TempoClass = track.tempoClass ?? 'mid';
      const interval = HAPTICS.beatIntervalMs[cls];
      if (!(elapsedMs >= interval)) return null; // the first beat is due AT interval, not at t=0
      const beatIndex = Math.floor(elapsedMs / interval);
      if (beatIndex <= settings.lastBeatIndex) return null; // one fire per beat, ever
      if (mode === 'auto') {
        const pattern = hapticPattern(track.genre, cls);
        if (pattern.disabled || pattern.fireOn.length === 0) return null; // lofi/ambient: still by default
        if (pattern.fireOn.indexOf(beatIndex % 4) === -1) return null; // the genre says this beat is silent
        return { spec: { kind: 'impact', style: pattern.style }, beatIndex };
      }
      // 'uniform' — the legacy tempo-class behavior for EVERY track
      // (also the documented override that un-silences lofi/ambient)
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
