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
 *  - metadata tags ([ti:…], [offset:…]) never parse as timestamps (the
 *    stamp regex demands digit:digit),
 *  - multiple stamps on one line ([00:12][00:45]) expand to repeated
 *    entries (repeated chorus),
 *  - stamp-only lines (instrumental gaps) are dropped — nothing to sing,
 *  - result is sorted by time; equal timestamps keep first-seen order.
 */

export interface LrcLine {
  /** milliseconds from song start */
  tMs: number;
  text: string;
}

const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

export function parseLrc(raw: string | null | undefined): LrcLine[] {
  if (!raw) return [];
  const out: LrcLine[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    STAMP.lastIndex = 0;
    const stamps: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = STAMP.exec(line))) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const fracRaw = m[3] ?? '';
      // ".5" = 500ms, ".05" = 50ms, ".500" = 500ms — scale by digits given
      const frac = fracRaw ? parseInt(fracRaw, 10) / Math.pow(10, fracRaw.length) : 0;
      stamps.push(Math.round((min * 60 + sec + frac) * 1000));
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
