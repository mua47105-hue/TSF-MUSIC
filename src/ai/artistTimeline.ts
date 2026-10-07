/**
 * ARTIST TIMELINE (MAGNUM OPUS · F17) — the artist's years on an axis.
 *
 * Two honest timelines over data the app ACTUALLY carries:
 *  - groupAlbumsByYear: albums WITH a year, one bucket per year, plus
 *    an 'unknown' bucket for rows the provider does not date (dropping
 *    them would silently lose the user's albums — law ⑬'s cousin).
 *  - groupTracksByYear: the artist's TOP TRACKS by release year — the
 *    provider's rows carry real year metadata (saavn mapper), so this
 *    is the PRIMARY timeline when albums arrive undated (the mission's
 *    "0 albums → top-tracks timeline" fallback, generalized: the
 *    fallback is per-DATA, not per-hardware).
 *
 * Deterministic throughout: buckets sort descending (newest era first),
 * rows keep their input order inside a bucket (X4).
 */

export interface TimelineAlbum {
  id: string;
  title: string;
  year?: number;
}

export const TIMELINE_UNKNOWN = 'unknown';

/** Albums → Map<yearKey, albums[]>; year-less rows land in 'unknown'. */
export function groupAlbumsByYear(albums: TimelineAlbum[]): Map<string, TimelineAlbum[]> {
  const out = new Map<string, TimelineAlbum[]>();
  for (const a of albums) {
    const key =
      typeof a.year === 'number' && a.year > 1900 ? String(Math.floor(a.year / 10) * 10) : TIMELINE_UNKNOWN;
    const bucket = out.get(key);
    if (bucket) bucket.push(a);
    else out.set(key, [a]);
  }
  // deterministic order: known decades newest first, 'unknown' last
  return new Map(
    [...out.entries()].sort((x, y) => {
      if (x[0] === TIMELINE_UNKNOWN) return 1;
      if (y[0] === TIMELINE_UNKNOWN) return -1;
      return Number(y[0]) - Number(x[0]);
    }),
  );
}

/** Tracks → Map<year, tracks[]> (rows without a year are skipped — the
 *  UI counts them and says so; a track without a year has no place on
 *  a time axis, and inventing one would be a lie). */
export function groupTracksByYear<T extends { year?: number }>(tracks: T[]): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const t of tracks) {
    if (typeof t.year !== 'number' || t.year <= 1900) continue;
    const bucket = out.get(t.year);
    if (bucket) bucket.push(t);
    else out.set(t.year, [t]);
  }
  return new Map([...out.entries()].sort((x, y) => y[0] - x[0]));
}

/** Tracks → Map<decade, tracks[]> — the artist page's decade chips. */
export function groupTracksByDecade<T extends { year?: number }>(tracks: T[]): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const t of tracks) {
    if (typeof t.year !== 'number' || t.year <= 1900) continue;
    const decade = Math.floor(t.year / 10) * 10;
    const bucket = out.get(decade);
    if (bucket) bucket.push(t);
    else out.set(decade, [t]);
  }
  return new Map([...out.entries()].sort((x, y) => y[0] - x[0]));
}

/** The decade axis for the track timeline (desc, deduped). */
export function timelineDecades(years: number[]): number[] {
  const decades = new Set(years.filter((y) => y > 1900).map((y) => Math.floor(y / 10) * 10));
  return [...decades].sort((a, b) => b - a);
}
