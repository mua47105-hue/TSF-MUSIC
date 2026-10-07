/**
 * DECADE RADIO (MAGNUM OPUS · F16) — "play me the sound of 1994".
 *
 * decadeQuery is the PURE heart: a deterministic search ladder for a
 * year — the exact year first, then its decade, then the decade's
 * hindi/bollywood rung (JioSaavn's strongest catalog axis). Same year
 * in, same ladder out — on every device, every run (law X4).
 *
 * The facade (mindbeat.decadeRadio) walks the ladder through the
 * injected CatalogApi, dedupes, applies reconcileRecordings at the
 * merge point, filters by track.year WHERE THE ROW CARRIES ONE (rows
 * without year metadata stay — honesty about missing data, not silent
 * fabrication of era purity), respects the kill switch, and returns
 * fewer rows honestly when a year is thin in the catalog.
 */

import { DECADE_RADIO } from './core/constants';

export interface QueryLadder {
  /** the exact-year rung, e.g. "1994 hits" */
  exact: string;
  /** the decade rung, e.g. "90s hits" */
  decade: string;
  /** the genre rung, e.g. "90s bollywood" */
  genre: string;
  /** the decade bucket (1994 → 1990) */
  decadeStart: number;
}

const decadeName = (decadeStart: number): string => {
  const d2 = Math.floor((decadeStart % 100) / 10);
  const names: Record<number, string> = { 0: '00s', 1: '10s', 2: '20s', 9: '90s', 8: '80s', 7: '70s', 6: '60s' };
  return names[d2] ?? `${decadeStart}s`;
};

/** THE LADDER (pure, deterministic): year in → the three search rungs. */
export function decadeQuery(year: number): QueryLadder {
  const y = Math.max(DECADE_RADIO.minYear, Math.min(DECADE_RADIO.maxYear, Math.floor(year)));
  const decadeStart = Math.floor(y / 10) * 10;
  const name = decadeName(decadeStart);
  return {
    exact: `${y} hits`,
    decade: `${name} hits`,
    genre: `${name} bollywood`,
    decadeStart,
  };
}

/**
 * Year filtering (pure): a row WITH a year must sit inside the decade
 * (the exact-year rung is a search hint, not a guarantee); a row
 * WITHOUT a year stays — dropping it would pretend we know something
 * we do not (law ⑰).
 */
export function inDecade<T extends { year?: number }>(t: T, decadeStart: number): boolean {
  if (typeof t.year !== 'number' || t.year <= 0) return true; // no metadata → keep, honestly
  return Math.floor(t.year / 10) * 10 === decadeStart;
}
