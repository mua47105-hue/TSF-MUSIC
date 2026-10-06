/**
 * LOCAL WRAPPED / MONTHLY REWIND (THE TEN · FEATURE 6) — Wrapped-grade
 * counting computed ENTIRELY on-device from the Event Ledger. No
 * servers, no accounts: the user's year belongs to the user.
 *
 * Every stat is a PURE function of the listens (same input ⇒ same
 * output); the facade supplies the window. The 30-second rule (industry
 * stream definition, STREAM_COUNT_SECONDS) decides what a "stream" is —
 * the same rule mindbeat.stats() uses, never a new definition.
 *
 * THE AURA is truth-conditioned, closed-set: the listener's weighted
 * energy×valence center picks one of four quadrants — nothing is
 * fabricated, nothing is social-proof. LOW-data listeners get an honest
 * null (the UI says "not enough listening yet"), never zeros dressed up
 * as stats.
 */

import { STREAM_COUNT_SECONDS, WRAPPED } from './core/constants';
import type { ListenRecord } from './core/types';

const DAY_MS = 86_400_000;

/** The closed aura vocabulary — four quadrants, no invented fifth. */
export type AuraLabel = 'GOLDEN_HOUR' | 'RED_LINE' | 'SOFT_LANDING' | 'DEEP_FOG';

/**
 * The aura quadrant of an energy/valence center. Pure + clamped:
 *   energy ≥ split, valence ≥ split → GOLDEN_HOUR  (bright + upbeat)
 *   energy ≥ split, valence < split → RED_LINE     (intense + heavy)
 *   energy < split, valence ≥ split → SOFT_LANDING (calm + warm)
 *   energy < split, valence < split → DEEP_FOG     (low + melancholy)
 */
export function auraFor(energy: number, valence: number): AuraLabel {
  const s = WRAPPED.auraSplit;
  const e = typeof energy === 'number' && Number.isFinite(energy) ? energy : s;
  const v = typeof valence === 'number' && Number.isFinite(valence) ? valence : s;
  if (e >= s) return v >= s ? 'GOLDEN_HOUR' : 'RED_LINE';
  return v >= s ? 'SOFT_LANDING' : 'DEEP_FOG';
}

export interface WrappedSummary {
  rangeDays: number;
  /** 30-second-rule streams inside the window. */
  streams: number;
  minutes: number;
  topArtist: { artist: string; plays: number } | null;
  topTrack: { title: string; artist: string; plays: number } | null;
  /** The most-played track between midnightFromHour and midnightToHour. */
  midnight: { title: string; artist: string; plays: number } | null;
  aura: { label: AuraLabel; energy: number; valence: number } | null;
  streakDays: number;
  /** When the streak's last active day was (honest copy: the streak may
   *  have ended before today). Epoch ms, or null with no streak. */
  streakEndTs: number | null;
  /** Top lists for the cards (bounded, deterministic). */
  topArtists: Array<{ artist: string; plays: number }>;
  topTracks: Array<{ title: string; artist: string; plays: number }>;
}

function emptySummary(rangeDays: number): WrappedSummary {
  return {
    rangeDays,
    streams: 0,
    minutes: 0,
    topArtist: null,
    topTrack: null,
    midnight: null,
    aura: null,
    streakDays: 0,
    streakEndTs: null,
    topArtists: [],
    topTracks: [],
  };
}

/** Deterministic local-day key (y*10000+m*100+d) — NEVER a parsed date
 *  string (Hermes/engine-defined parsing made the streak fragile). */
function dayKey(d: Date): number {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/** Cross-device deterministic string compare (UTF-16 code units) —
 *  localeCompare drifts between locales for non-ASCII ties. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The rewind for the last `rangeDays` days — or NULL when the listener
 * honestly hasn't streamed enough (WRAPPED.minStreams, 30-second rule)
 * for the cards to say anything true.
 */
export function buildWrapped(listens: ListenRecord[], rangeDays: number, now: number): WrappedSummary | null {
  const floorTs = now - rangeDays * DAY_MS;
  const window = listens.filter((l) => l.startedTs >= floorTs);

  let streams = 0;
  let minutes = 0;
  const artistAgg = new Map<string, { artist: string; plays: number }>();
  const trackAgg = new Map<string, { title: string; artist: string; plays: number }>();
  const midnightAgg = new Map<string, { title: string; artist: string; plays: number }>();
  const daySet = new Set<number>();
  let energySum = 0;
  let valenceSum = 0;
  let featureRows = 0;

  for (const l of window) {
    // The 30-second rule — the SAME stream definition as stats().
    if (l.listenedMs < STREAM_COUNT_SECONDS * 1000) continue;
    streams += 1;
    minutes += l.listenedMs / 60000;
    const d = new Date(l.startedTs);
    daySet.add(dayKey(d));
    const a = artistAgg.get(l.artist) ?? { artist: l.artist, plays: 0 };
    a.plays += 1;
    artistAgg.set(l.artist, a);
    if (l.title) {
      const t = trackAgg.get(l.trackId) ?? { title: l.title, artist: l.artist, plays: 0 };
      t.plays += 1;
      trackAgg.set(l.trackId, t);
      const hour = d.getHours();
      if (hour >= WRAPPED.midnightFromHour && hour < WRAPPED.midnightToHour) {
        const m = midnightAgg.get(l.trackId) ?? { title: l.title, artist: l.artist, plays: 0 };
        m.plays += 1;
        midnightAgg.set(l.trackId, m);
      }
    }
    // garbage feature rows never steer the aura (a NaN mean would land
    // the listener in the brightest quadrant — the exact fake-stats sin)
    if (Number.isFinite(l.energy) && Number.isFinite(l.valence)) {
      energySum += l.energy;
      valenceSum += l.valence;
      featureRows += 1;
    }
  }

  // HONEST COLD START: below the stream floor there is nothing true to say.
  if (streams < WRAPPED.minStreams) return null;

  const rank = <T,>(agg: Map<string, T>, plays: (x: T) => number, name: (x: T) => string): T[] =>
    [...agg.values()].sort((x, y) => plays(y) - plays(x) || cmp(name(x), name(y)));

  const topArtists = rank(artistAgg, (x) => x.plays, (x) => x.artist)
    .slice(0, WRAPPED.topArtistCount)
    .map((x) => ({ artist: x.artist, plays: x.plays }));
  const topTracks = rank(trackAgg, (x) => x.plays, (x) => x.title)
    .slice(0, WRAPPED.topTrackCount)
    .map((x) => ({ ...x }));

  // Streak: consecutive ACTIVE days ending at the last one — the anchor
  // is the last active day (honest copy says "thru <date>" when it is
  // not today), walked with real Dates against the integer day keys.
  let streakDays = 0;
  let streakEndTs: number | null = null;
  if (daySet.size) {
    // reconstruct the LAST ACTIVE DAY from the integer key (a day key is
    // NOT an epoch — new Date(20261006) would be January 1970)
    const lastActive = Math.max(...daySet);
    const ky = Math.floor(lastActive / 10000);
    const km = Math.floor((lastActive % 10000) / 100);
    const kd = lastActive % 100;
    const cursor = new Date(ky, km - 1, kd, 12, 0, 0, 0); // noon: DST-safe
    for (let i = 0; i < 365; i++) {
      if (!daySet.has(dayKey(cursor))) break;
      streakDays += 1;
      if (streakDays === 1) streakEndTs = cursor.getTime(); // the FIRST walked day IS the end
      cursor.setDate(cursor.getDate() - 1);
    }
  }

  // the mean divides by the FINITE-row count (garbage rows diluting the
  // center toward zero would drag a bright listener into DEEP_FOG)
  const energy = featureRows ? energySum / featureRows : 0;
  const valence = featureRows ? valenceSum / featureRows : 0;

  return {
    rangeDays,
    streams,
    minutes: Math.round(minutes),
    topArtist: topArtists[0] ?? null,
    topTrack: topTracks[0] ?? null,
    midnight: rank(midnightAgg, (x) => x.plays, (x) => x.title)[0] ?? null,
    aura: { label: auraFor(energy, valence), energy, valence },
    streakDays,
    streakEndTs,
    topArtists,
    topTracks,
  };
}
