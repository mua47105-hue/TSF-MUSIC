/**
 * TIME MACHINE (MAGNUM OPUS · F9) — "This Day Last Year".
 *
 * THE LEDGER IS SACRED GROUND (R-LOCK-1). The laws, and how this file
 * honors them:
 *  L1  The summary lives in a NEW table (`historical_summary`). The raw
 *      `events` table, its id format and the 90-day RETENTION.rawEventDays
 *      behavior stay byte-identical — this module only ever READS the
 *      events the compaction pass is about to delete, and writes to its
 *      own table via the LedgerStore's OPTIONAL historical methods.
 *  L2  Aggregation runs DURING the existing first-open-of-day compaction
 *      pass (EventLedger.maybeCompact), BEFORE the old events are
 *      deleted. There is NO separate scan of the ledger anywhere.
 *  L3  `historical_summary` keeps top-N tracks + top-N artists + minutes
 *      per day, with its own HISTORY.retentionDays (3y) retention
 *      enforced in the SAME pass.
 *  L4  tests/ai/ledger.test.ts and tests/ai/gauntlet-r2.test.ts pass
 *      WITHOUT MODIFICATION (the fold is additive; when no events are
 *      being deleted it is a no-op).
 *  L5  The facade surface mindbeat.thisDayLastYear() returns the honest
 *      cold state (null → "Not enough history yet") when no summary rows
 *      exist for that month-day.
 *
 * The fold is a PURE function over (events → day summaries) so the
 * 400-day scripted fixture bar is testable without any store.
 */

import { HISTORY, RADAR } from './constants';
import type { LedgerEvent } from './types';

export interface HistoricalTrack {
  id: string;
  title: string;
  artist: string;
  /** Streams credited to this track that day (≥30s rule). */
  plays: number;
}

export interface HistoricalArtist {
  name: string;
  plays: number;
}

export interface HistoricalDay {
  /** LOCAL calendar day 'YYYY-MM-DD' — the summary's identity. */
  dayKey: string;
  /** Epoch ms of local midnight (sort key + retention cutoff). */
  dayStartTs: number;
  /** Listened minutes that day (sum of per-track maxima — see fold). */
  minutes: number;
  /** Streams that day (30-second rule applied). */
  streams: number;
  topTracks: HistoricalTrack[];
  topArtists: HistoricalArtist[];
}

/** Local calendar day key 'YYYY-MM-DD'. Deterministic (no UTC drift). */
export function dayKeyOf(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Local midnight of the day containing ts. */
export function dayStartOf(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Month-day key ('MM-DD') for the "this day" match across years. */
export function monthDayOf(ts: number): string {
  return dayKeyOf(ts).slice(5);
}

const STREAM_MIN_MS = RADAR.minStreamMs; // the ONE 30-second rule (its home + rationale live in constants.ts)

/**
 * foldEventsIntoDays — fold the events ABOUT TO BE DELETED into per-day
 * summaries, merging with whatever the table already holds for those
 * days. Deterministic; same inputs → same output.
 *
 * Honest accounting (documented):
 *  - Per track, the day credits the MAXIMUM listenedMs observed among
 *    that day's events for the track (heartbeats carry monotonically
 *    growing elapsedMs; TRACK_END/SKIP carries the final value) — never
 *    the sum, which would double-count a scrubbed-back track.
 *  - Minutes = Σ (max ms ≥ 30s ? ms : 0). Streams = #tracks with ≥30s.
 *  - Compaction passes over the same day see DISJOINT event sets (events
 *    are deleted the moment they are folded), so cross-pass merging sums.
 *  - HONEST LIMIT: a track played across midnight credits its max
 *    elapsed to BOTH days (heartbeat day + end day) — per-day totals
 *    are true; the sum across days can exceed the track's length.
 */
/** The listen-table join source for track metadata (F9 P0 fix): the
 *  event stream carries artistId, NEVER the artist NAME — production
 *  summaries resolved artist names only through this map. Listens are
 *  retained 180d (RE_listen), so listens for 90d-doomed events always
 *  exist at fold time; the map degrades to '' (honest Unknown) past
 *  its edge. */
export interface TrackMeta {
  title?: string;
  artist?: string;
}

export function foldEventsIntoDays(
  events: LedgerEvent[],
  existing: Map<string, HistoricalDay>,
  topN: number = HISTORY.topN,
  meta?: Map<string, TrackMeta>,
): Map<string, HistoricalDay> {
  const out = new Map<string, HistoricalDay>();
  for (const [k, v] of existing) {
    out.set(k, { ...v, topTracks: [...v.topTracks], topArtists: [...v.topArtists] });
  }

  interface TrackFold {
    ms: number;
    title: string;
    artist: string;
  }
  interface DayFold {
    dayStartTs: number;
    tracks: Map<string, TrackFold>;
  }
  const days = new Map<string, DayFold>();
  const dayOf = (ts: number): DayFold => {
    const key = dayKeyOf(ts);
    let d = days.get(key);
    if (!d) {
      d = { dayStartTs: dayStartOf(ts), tracks: new Map() };
      days.set(key, d);
    }
    return d;
  };

  for (const e of events) {
    const trackId = e.trackId ?? '';
    if (!trackId) continue;
    const day = dayOf(e.ts);
    const p = e.payload ?? {};
    const m = meta?.get(trackId);
    let t = day.tracks.get(trackId);
    if (!t) {
      t = { ms: 0, title: m?.title ?? '', artist: m?.artist ?? '' };
      day.tracks.set(trackId, t);
    }
    if (e.type === 'TRACK_START') {
      if (typeof p.title === 'string') t.title = p.title;
      // the artist NAME arrives via the listen-table join (m) — the
      // event payload never carries one (the P0 the blind critic caught)
      if (!t.artist && m?.artist) t.artist = m.artist;
      if (!t.artist && typeof p.artist === 'string') t.artist = p.artist; // legacy/fallback
    } else if (e.type === 'TRACK_HEARTBEAT' || e.type === 'TRACK_END' || e.type === 'TRACK_SKIP') {
      const elapsed = Number(p.elapsedMs ?? 0);
      if (Number.isFinite(elapsed)) t.ms = Math.max(t.ms, elapsed);
      if (!t.artist && m?.artist) t.artist = m.artist;
      if (!t.artist && typeof p.artist === 'string') t.artist = p.artist;
      if (!t.title && m?.title) t.title = m.title;
    }
  }

  for (const [key, fold] of days) {
    const prev = out.get(key);

    let minutesFold = 0;
    let streamsFold = 0;
    const tracksFold: HistoricalTrack[] = [];
    for (const [id, t] of fold.tracks) {
      if (t.ms >= STREAM_MIN_MS) {
        minutesFold += t.ms / 60000;
        streamsFold += 1;
        tracksFold.push({ id, title: t.title || 'Unknown', artist: t.artist || 'Unknown', plays: 1 });
      }
    }
    // Strongest first, then title asc — deterministic tiebreak.
    tracksFold.sort((a, b) => minutesOf(b.id, fold) - minutesOf(a.id, fold) || cmp(a.title, b.title));

    const artistsFold = topArtistsOf(tracksFold);

    out.set(key, {
      dayKey: key,
      dayStartTs: fold.dayStartTs,
      minutes: Math.round(((prev?.minutes ?? 0) + minutesFold) * 100) / 100,
      streams: (prev?.streams ?? 0) + streamsFold,
      topTracks: mergeTracks(prev?.topTracks ?? [], tracksFold, topN),
      topArtists: mergeArtists(prev?.topArtists ?? [], artistsFold, topN),
    });
  }

  return out;

  function minutesOf(trackId: string, fold: DayFold): number {
    return fold.tracks.get(trackId)?.ms ?? 0;
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Merge track lists: same id → bump plays; strongest first; cap topN.
 *  Ties keep the CALLER'S order (an index tiebreak, not a title
 *  tiebreak): the fold hands us tracks already ranked by that day's
 *  true listening minutes, so equal-play rows must never be
 *  alphabetized into oblivion. Deterministic — the input order is
 *  deterministic (law X4). */
function mergeTracks(a: HistoricalTrack[], b: HistoricalTrack[], topN: number): HistoricalTrack[] {
  const merged = [...a];
  for (const item of b) {
    const found = merged.find((m) => m.id === item.id);
    if (found) found.plays += item.plays;
    else merged.push({ ...item });
  }
  return merged
    .map((t, i) => ({ t, i }))
    .sort((x, y) => y.t.plays - x.t.plays || x.i - y.i)
    .slice(0, topN)
    .map(({ t }) => t);
}

function topArtistsOf(tracks: HistoricalTrack[]): HistoricalArtist[] {
  const agg = new Map<string, number>();
  for (const t of tracks) agg.set(t.artist, (agg.get(t.artist) ?? 0) + t.plays);
  return [...agg.entries()].map(([name, plays]) => ({ name, plays }));
}

/** Merge artist lists: same name → bump plays; strongest first; cap topN
 *  (index tiebreak — same law as mergeTracks). */
function mergeArtists(a: HistoricalArtist[], b: HistoricalArtist[], topN: number): HistoricalArtist[] {
  const merged = [...a];
  for (const item of b) {
    const found = merged.find((m) => m.name === item.name);
    if (found) found.plays += item.plays;
    else merged.push({ ...item });
  }
  return merged
    .map((t, i) => ({ t, i }))
    .sort((x, y) => y.t.plays - x.t.plays || x.i - y.i)
    .slice(0, topN)
    .map(({ t }) => t);
}

/**
 * thisDayLastYear — the pure selector over the summary table. Given all
 * summary rows and `now`, find the MOST RECENT prior year with a
 * summary for the same LOCAL month-day. null = honest cold state.
 */
export function pickThisDay(rows: HistoricalDay[], now: number): HistoricalDay | null {
  const md = monthDayOf(now);
  const thisYear = new Date(now).getFullYear();
  const candidates = rows
    .filter((r) => monthDayOf(r.dayStartTs) === md && new Date(r.dayStartTs).getFullYear() < thisYear)
    .sort((a, b) => b.dayStartTs - a.dayStartTs);
  return candidates[0] ?? null;
}

/**
 * ── The on-disk encoding (the storage bar's actual subject) ──────────
 *
 * The rich HistoricalDay shape is for CODE; the DISK holds a compact
 * columnar form — JSON arrays-of-arrays with no per-entry key tax:
 *   topTracks  → [[id, title, artist, plays], …]
 *   topArtists → [[name, plays], …]
 *   minutes    → rounded to 0.01 (a display value, not an accountant)
 * Measured against keyed-JSON rows this is ~40% smaller; the storage
 * lock pins the real numbers (see tests/wave2_historical_locks.test.ts).
 */

export type EncodedTrack = [string, string, string, number];
export type EncodedArtist = [string, number];

export function encodeMinutes(minutes: number): number {
  return Math.round(minutes * 100) / 100;
}

export function encodeTrackList(tracks: HistoricalTrack[]): EncodedTrack[] {
  return (tracks ?? []).map((t) => [t.id, t.title, t.artist, t.plays]);
}

export function encodeArtistList(artists: HistoricalArtist[]): EncodedArtist[] {
  return (artists ?? []).map((a) => [a.name, a.plays]);
}

/** Storage cost probe (bar: the summary stays a rounding error on
 *  device storage). Measures the COMPACT row exactly as the SQLite
 *  adapter writes it — no Fantasy Compression, the real bytes. */
export function summarizeStorageBytes(rows: HistoricalDay[]): number {
  return rows.reduce((sum, day) => {
    const row = [
      day.dayKey,
      day.dayStartTs,
      encodeMinutes(day.minutes),
      day.streams,
      JSON.stringify(encodeTrackList(day.topTracks)),
      JSON.stringify(encodeArtistList(day.topArtists)),
    ];
    return sum + JSON.stringify(row).length;
  }, 0);
}
