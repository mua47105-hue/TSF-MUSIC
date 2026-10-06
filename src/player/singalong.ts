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

import { KINETIC } from '../ai/core/constants';

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
