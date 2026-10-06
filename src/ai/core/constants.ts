/**
 * MINDBEAT — the single tuning table (plan Appendix C).
 *
 * Every number is a starting value with a stated tuning protocol, never a
 * magic constant. Nothing in the intelligence stack may hard-code a weight,
 * threshold or half-life: it must live here so tuning is a one-file edit.
 */

// ── Listen grades (§5.2) ────────────────────────────────────────────────
export const GRADE_WEIGHTS = {
  INSTANT_REJECT: -3.0,
  EARLY_SKIP: -1.5,
  MID_SKIP: -0.5,
  LATE_SKIP: 0.5,
  COMPLETED: 2.0,
  REPLAY_BONUS: 1.0,
  HEART: 4.0,
  HEART_CONTRADICT: 1.0,
  DOWNLOAD: 2.5,
  NOT_FOR_ME_TRACK: -4.0,
  NOT_FOR_ME_ARTIST: -1.0,
} as const;

/** Blame splits: where a grade's evidence lands (artist/track/mood/session). */
export const BLAME_SPLIT = {
  INSTANT_REJECT: { artist: 0.4, track: 0.2, mood: 0.2, session: 0.2 },
  EARLY_SKIP: { artist: 0.5, track: 0.25, mood: 0.25, session: 0 },
  MID_SKIP: { artist: 0.6, track: 0.3, mood: 0.1, session: 0 },
  LATE_SKIP: { artist: 0.6, track: 0.3, mood: 0.1, session: 0 },
  COMPLETED: { artist: 0.6, track: 0.3, mood: 0.1, session: 0 },
  HEART: { artist: 0.7, track: 0.3, mood: 0, session: 0 },
  DOWNLOAD: { artist: 0.7, track: 0.3, mood: 0, session: 0 },
} as const;

// ── Half-lives, days (§6.2) ─────────────────────────────────────────────
export const HALF_LIFE = {
  heart: 180,
  artist: 45,
  genre: 60,
  language: 90,
  era: 120,
  daypartCell: 30,
  skipProfile: 180,
  coplayEdge: 60,
  sourceTrust: 21,
} as const;

// ── Decision-engine score weights (§8.3) ────────────────────────────────
export const SCORE_WEIGHTS = {
  profileAffinity: 1.0,
  sessionFit: 1.2,
  daypartFit: 0.8,
  freshness: 0.6,
  sourceTrust: 0.4,
} as const;

/** Energy tolerance before the quadratic penalty kicks in. */
export const ENERGY_TOLERANCE = 0.2;

// ── Exploration budget (§8.4) ───────────────────────────────────────────
export const EXPLORATION = {
  coldStartEpsilon: 0.5, // sessions 1–5
  matureEpsilon: 0.15,
  floorEpsilon: 0.1,
  crossLanguageMax: 0.2, // ≤ 1 in 5 exploration slots cross-language
  conversionTarget: 0.1, // 10% of fresh finds complete/save within 30d
  autoDropPerWeek: 0.02, // ε falls when exploration under-converts
} as const;

// ── Session (§7.1) ──────────────────────────────────────────────────────
export const SESSION = {
  windowTracks: 12,
  recencyTiers: [3, 2, 1] as const, // newest third ×3 … oldest third ×1
  stormThreshold: 3, // instant-rejects …
  stormWindow: 6, // … within last 6 tracks
  gapMinutes: 30, // session = app open after ≥30 min gap
  maxSameArtistPer6: 2,
  maxMinutes: 45 * 60, // beyond ~45 min the room has changed
} as const;

// ── Cadence (Appendix C) ────────────────────────────────────────────────
export const CADENCE = {
  smartShuffleRatio: 3, // 1 rec per 3 user tracks (>15 track playlists)
  smartShuffleMinTracks: 15,
  healBackoff: 4, // after a healed slot, next heal waits 4 slots
  saveTighten: 2, // after playlist save, rec ratio tightens to 1:2
  radioDriftEvery: 5, // every 5th radio slot is a drift track
  radioDedupSize: 100, // last 100 radio serves …
  radioDedupTtlDays: 7, // … blocked for 7 days
  radioPrefetch: 2, // extend the queue 2 slots ahead of playback
  mixesMin: 3,
  mixesMax: 6,
  mixCoreBridgeFresh: [0.6, 0.25, 0.15] as const, // core/bridge/fresh split
  mixMaxRepeatFromYesterday: 0.3,
  refreshAfterSessions: 3, // mixes re-rank after every 3rd session
  // ── THE WEEKLY CRATE (§9.7) — the Discover Weekly surface ──
  weeklySize: 30, // the edition's shelf count (Spotify DW class)
  weeklyCoreBridgeFresh: [0.35, 0.4, 0.25] as const, // discovery outweighs core
  weeklyMaxPrevRepeat: 0.3, // ≤30% of last week's crate may return
  weeklyMinTracks: 8, // below this the crate is an embarrassment → honest null
  aiPoolMin: 60,
  aiPoolMax: 120,
  aiOutput: 25,
  aiOutputMin: 18,
  aiArtistCap: 5,
  aiMaxEnergyStep: 0.25,
} as const;

// ── Daypart blocks (§6.3, Heggli-verified structure) ────────────────────
export type BlockName = 'morning' | 'afternoon' | 'evening' | 'night' | 'lateNight';
export type DayKind = 'weekday' | 'weekend';

/** Weekday boundaries (local hours). Weekend shifts +2h via WEEKEND_SHIFT_HOURS. */
export const BLOCKS = {
  weekday: [
    { block: 'morning', from: 5, to: 11 },
    { block: 'afternoon', from: 11, to: 16 },
    { block: 'evening', from: 16, to: 20 },
    { block: 'night', from: 20, to: 24 },
    { block: 'lateNight', from: 0, to: 5 },
  ],
} as const;
export const WEEKEND_SHIFT_HOURS = 2;
/** Personal calibration may move learned boundaries ±90 min after day 14. */
export const BOUNDARY_CALIBRATION_MIN = 14;
export const BOUNDARY_CALIBRATION_MAX_MIN = 90;

// ── Ledger retention (§5.4) ─────────────────────────────────────────────
export const RETENTION = {
  rawEventDays: 90,
  sessionDays: 180,
  maxRawEvents: 20000, // compaction guarantee
  compactBatch: 2000,
  replayWindowDays: 7, // same track never re-served within 7d (non-user-queued)
} as const;

// ── Performance budgets (§10.3) — enforced by tests/ai/perf.test.ts ────
export const PERF_BUDGETS = {
  decisionQueryMs: 150, // p95, post-candidates, in-memory
  profileReadMs: 50, // full read + lazy decay
  coplayLookupMs: 20,
  ledgerWriteAmortizedMs: 10, // batched chain
  profileRebuildMs: 3000, // 90-day ~20k-event ledger
  coldStartDeltaMs: 80, // intelligence layer adds ≤80ms to app cold start
  aiPlaylistEndToEndMs: 10000, // p95 ceiling (typical ≪ — stages are local)
} as const;

// ── Skip-grade boundaries (§5.2) ────────────────────────────────────────
export const SKIP_THRESHOLDS = {
  instantSeconds: 5,
  earlySeconds: 30,
  midRatio: 0.3, // 30–75% of duration
  lateRatio: 0.75,
  completedRatio: 0.95,
  replayWindowDays: 7,
  heartContradictInstantSkips: 2, // hearted track instant-skipped twice → collapse
} as const;

// ── Heartbeat cadence ───────────────────────────────────────────────────
export const HEARTBEAT_SECONDS = 10;

// ── 30-second rule (industry stream definition, §9.7) ──────────────────
export const STREAM_COUNT_SECONDS = 30;

// ── Onboarding (§6.7 / §9.9) ────────────────────────────────────────────
export const ONBOARDING = {
  pickCount: 5,
  seedWeight: 3.0, // ≈ 6h of listening equivalent
  genreSeedWeight: 2.2, // softer than artists — taste hints, not anchors
  firstSessionsExplore: 5, // sessions 1–5 run exploration-heavy
} as const;

// ── Captured genre evidence (GENIUS P1 — the free lunch) ───────────────
// Providers (iTunes primaryGenreName, JioSaavn genre when present) give
// genre strings away on every response. Captured genres flow into
// genreAffinities through the SAME bump path as the mood pseudo-genres
// (profile.ts: w · 0.3 per graded listen, already there). The two new
// numbers below are the only extra weight genre evidence may carry:
export const GENRE_CAPTURE = {
  /** One-time bump when a genre is backfilled onto a stored favorite —
   *  heart-class evidence (the user chose to keep this song), so it earns
   *  0.5 × ONBOARDING.genreSeedWeight (2.2 · 0.5 = 1.1). A favorite is one
   *  strong signal, not a listening history — hence the hard 0.5 cap. */
  favoriteBackfillWeight: 1.1,
  /** Safety cap on genre entries contributed purely by captured evidence
   *  in one rebuild — keeps a genre-heavy session from drowning the
   *  artist axis in the decision engine's 0.4 × genreAffinity term. */
  maxAffinityEntries: 40,
} as const;

// ── Profile normalization (§6.2) ────────────────────────────────────────
export const NORMALIZATION = {
  topArtistRead: 10,
  minEvidenceForExplain: 3,
} as const;
