/**
 * SING-ALONG CORE (Task 29 · godmode wave 2) — pure synced-lyrics model.
 *
 * parseLrc turns a raw LRCLIB `syncedLyrics` payload ([mm:ss.xx] line)
 * into a sorted, tap-seekable timeline; activeLrcIndex binary-searches the
 * line that should be highlighted at a playback position. Both are pure
 * and deterministic — the locks suite pins every edge so the karaoke card
 * can never drift into a wrong highlight.
 *
 * Discipline:
 *  - metadata tags ([ti:…], [ar:…]) never parse as timestamps (the
 *    stamp regex demands digit:digit),
 *  - [offset:+N] / [offset:-N] shifts the WHOLE timeline (positive =
 *    highlights land N ms later — the common player convention),
 *  - multiple stamps on one line ([00:12][00:45]) expand to repeated
 *    entries (repeated chorus),
 *  - fractions longer than 3 digits are truncated (the LRC spec has
 *    centiseconds; some taggers write nanoseconds),
 *  - stamp-only lines (instrumental gaps) are dropped — nothing to sing,
 *  - result is sorted by time; equal timestamps keep first-seen order.
 */

import { KINETIC, KARAOKE } from '../ai/core/constants';

export interface LrcLine {
  /** milliseconds from song start */
  tMs: number;
  text: string;
}

const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,}))?\]/g;
const OFFSET = /^\[offset:\s*([+-]?\d+)\s*\]$/i;

export function parseLrc(raw: string | null | undefined): LrcLine[] {
  if (!raw) return [];
  const out: LrcLine[] = [];
  let shiftMs = 0;
  // offset tag first: it may sit anywhere (usually the header) and shifts
  // every stamp in the file
  for (const rawLine of raw.split(/\r?\n/)) {
    const off = OFFSET.exec(rawLine.trim());
    if (off) shiftMs = parseInt(off[1], 10);
  }
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || OFFSET.test(line)) continue;
    STAMP.lastIndex = 0;
    const stamps: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = STAMP.exec(line))) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      // ".5" = 500ms, ".05" = 50ms, ".500" = 500ms — scale by digits given;
      // >3 digits (rare over-precise taggers) truncate to milliseconds
      const fracRaw = (m[3] ?? '').slice(0, 3);
      const frac = fracRaw ? parseInt(fracRaw, 10) / Math.pow(10, fracRaw.length) : 0;
      stamps.push(Math.round((min * 60 + sec + frac) * 1000) + shiftMs);
    }
    if (!stamps.length) continue; // metadata or plain text between stamps
    const text = line.replace(STAMP, '').trim();
    if (!text) continue; // instrumental gap — nothing to sing
    for (const tMs of stamps) out.push({ tMs, text });
  }
  out.sort((a, b) => a.tMs - b.tMs);
  return out;
}

/** Index of the line active at `positionMs` (-1 before the first stamp). */
export function activeLrcIndex(lines: LrcLine[], positionMs: number): number {
  if (!lines.length) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].tMs <= positionMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/* ── THE TEN · F8 — the kinetic typography spec (pure, lockable) ────── */

export interface KineticSpec {
  fontSize: number;
  lineHeight: number;
  /** 1 = fully present; upcoming/past lines dim to KINETIC.inactiveOpacity */
  opacity: number;
  /** the tint for the ACTIVE line (the palette's glow), null = keep ink */
  activeTint: string | null;
}

/**
 * The style of ONE line given whether it is the active one. Pure and
 * uniform-height on purpose: the auto-scroll contract (target =
 * activeIdx × lineHeight) must never drift when a line changes size.
 * No blur anywhere — the dim is a cheap opacity (potato rule).
 */
export function kineticLineSpec(active: boolean, tint: string | null | undefined): KineticSpec {
  return {
    fontSize: active ? KINETIC.activeFontSize : KINETIC.inactiveFontSize,
    lineHeight: KINETIC.lineHeight,
    opacity: active ? 1 : KINETIC.inactiveOpacity,
    activeTint: active ? (tint ?? null) : null,
  };
}

/**
 * The auto-scroll target for the active line — PURE, so the uniform-
 * height contract is testable without a ScrollView: the active line
 * centers at activeIdx × lineHeight + lineHeight/2 (the row heights
 * and this math read the SAME KINETIC constant, so they cannot drift).
 */
export function kineticScrollTarget(activeIdx: number, viewH: number): number {
  return Math.max(0, activeIdx * KINETIC.lineHeight + KINETIC.lineHeight / 2 - viewH / 2);
}

/* ── MAGNUM OPUS · F12 — word-level karaoke (an honest interpolation) ──
 *
 * LRC carries NO word stamps; the line's span (start → next line's
 * start) is distributed across its words by CHARACTER WEIGHT — longer
 * words hold the microphone proportionally longer. Every number here is
 * derived, none guessed: when a span cannot be computed (single line,
 * zero-length span) the words array is EMPTY and the renderer degrades
 * to the exact line-level look it had before F12 (the degradation is
 * structural, not a flag).
 */

export interface WordSpan {
  word: string;
  startMs: number;
  endMs: number;
}

/** An LrcLine plus its computed span + word timeline (F12). */
export interface WordLine extends LrcLine {
  endMs: number;
  words: WordSpan[];
}

/**
 * withWordSpans — attach the interpolated word timeline to each line.
 * Runs ONCE per song (the caller memoizes the parsed LRC; this rides
 * the same memo — never per tick). endMs = next line's tMs; the last
 * line sings for KARAOKE.tailMs or `durationMs`, whichever is shorter.
 */
export function withWordSpans(lines: LrcLine[], durationMs?: number): WordLine[] {
  return lines.map((line, i) => {
    const next = lines[i + 1];
    const tail = typeof durationMs === 'number' && durationMs > 0 ? Math.min(durationMs - line.tMs, KARAOKE.tailMs) : KARAOKE.tailMs;
    const endMs = next ? next.tMs : line.tMs + Math.max(0, tail);
    return { text: line.text, tMs: line.tMs, endMs, words: wordSpansOf(line.text, line.tMs, endMs) };
  });
}

/** Proportional (character-weighted) split of the line's span.
 *
 * v5.0.1 FIX-D2: every emitted word now has endMs > startMs, guaranteed
 * by INTEGER allocation that sums EXACTLY to the line's duration. The
 * old per-word `max(1, round(share))` could overshoot the span (a
 * 100:1-char split of a 2 ms line gave the first word 2 ms and the
 * last word a ZERO-duration span after the end snap-back). The
 * allocation: a 1 ms floor per word (the span ≥ word-count guard makes
 * it affordable), character-weighted floors, then the remainder
 * distributed by largest fractional share (index tiebreak — law X4).
 */
function wordSpansOf(text: string, startMs: number, endMs: number): WordSpan[] {
  const words = text.split(/\s+/).filter(Boolean);
  const span = endMs - startMs;
  if (words.length < 2 || !(span > 0)) return []; // structural degradation
  // a span too short to give every word ≥1ms of mic time degrades too —
  // negative/invalid word spans; blind-critic P2 (and FIX-D2's floor)
  if (span < words.length) return [];
  const totalChars = words.reduce((s, w) => s + w.length, 0);
  // INTEGER ALLOCATION: durs[i] ≥ 1, Σ durs = span exactly.
  const durs = words.map((w) => Math.max(1, Math.floor((w.length / totalChars) * span)));
  let diff = span - durs.reduce((s, d) => s + d, 0);
  const order = words.map((_, i) => i);
  if (diff > 0) {
    // give the surplus to the largest fractional shares first
    order.sort((a, b) => (words[b].length / totalChars) - (words[a].length / totalChars) || a - b);
    for (let k = 0; diff > 0; k++, diff--) durs[order[k % order.length]] += 1;
  } else if (diff < 0) {
    // trim the largest allocations first, never below the 1 ms floor
    order.sort((a, b) => durs[b] - durs[a] || a - b);
    for (let k = 0; diff < 0; k++) {
      const i = order[k % order.length];
      if (durs[i] > 1) {
        durs[i] -= 1;
        diff += 1;
      }
    }
  }
  const out: WordSpan[] = [];
  let cursor = startMs;
  for (let i = 0; i < words.length; i++) {
    out.push({ word: words[i], startMs: cursor, endMs: cursor + durs[i] });
    cursor += durs[i];
  }
  // cursor lands exactly on endMs (Σ durs = span) — asserted by the locks
  return out;
}

/**
 * activeWord — THE F12 selector (pure). Index of the word being sung at
 * `positionMs` within `line`; -1 = before the line, past it, or the
 * line carries no word timeline (the line-level degradation).
 */
export function activeWord(line: WordLine, positionMs: number): number {
  if (!line.words.length) return -1;
  if (positionMs < line.tMs || positionMs >= line.endMs) return -1;
  // binary search the word whose span contains the position
  let lo = 0;
  let hi = line.words.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (line.words[mid].endMs <= positionMs) {
      lo = mid + 1;
    } else if (line.words[mid].startMs > positionMs) {
      hi = mid - 1;
    } else {
      ans = mid;
      break;
    }
  }
  // position inside the line but between words (rounding gaps): the
  // word that started most recently is still on the mic
  if (ans === -1) {
    let best = -1;
    for (let i = 0; i < line.words.length; i++) {
      if (line.words[i].startMs <= positionMs) best = i;
      else break;
    }
    return best;
  }
  return ans;
}
