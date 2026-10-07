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
  /** Phase 3 — the Thompson-sampling refinement (additive). Below
   *  profileAffinity: the bandit refines ranking, it never owns it. */
  bandit: 0.5,
  /** Phase 4 — the directed Markov flow bonus (additive). */
  flowNext: 0.4,
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

// ── Profile normalization (§6.2) ────────────────────────────────────────
export const NORMALIZATION = {
  topArtistRead: 10,
  minEvidenceForExplain: 3,
} as const;

// ── THE LIGHTWEIGHT GENIUS LIFT (v4.2.0 mission) ───────────────────────
// Every number below is a starting value with a stated tuning protocol
// (Appendix C discipline). Nothing outside this file may hard-code them.

/** Phase 2 — baked Spotify audio features (the offline knowledge table). */
export const DATASET = {
  /** Baked rows beat cultural priors (0.7) but lose to observed behavior. */
  confidence: 0.8,
  /** BAR 1.3: the real loadFeatureTable() parse must finish under this. */
  loadBudgetMs: 2000,
  /** Hard size ceiling for the gzipped asset — the bake script fails
   *  loudly above it (potato-phone rule ⑧). */
  maxGzipBytes: 2_621_440,
  /** Maximum rows baked from the dataset (popularity-sorted). */
  maxRows: 200_000,
} as const;

/** Phase 3 — the Thompson-sampling bandit over artist/track arms. */
export const BANDIT = {
  /** kv hard cap; arms with the lowest alpha+beta are evicted first. */
  armCap: 2000,
  /** Uniform Beta prior: every arm starts {1, 1}. */
  priorStrength: 1.0,
  /** BAR 3.9 — onboarding artist seeds start trusted (Day-1 visibility). */
  seedAlpha: 3.0,
  seedBeta: 1.0,
  /** BAR 2.1 — a track arm above this reject rate is vetoed from the
   *  serving pools. 0.75 ⇒ the ratio rule is the law.
   *  Weight math (GRADE_WEIGHTS.INSTANT_REJECT = 3.0): a single
   *  instant-reject on a fresh arm is {α1, β4} = 0.80 — but evidence
   *  must ALSO clear the floor below, so one accidental tap NEVER bans
   *  a track (critic finding); 2 straight rejects {1,7} = 0.875 do. */
  vetoRejectRate: 0.75,
  /** Net evidence (alpha+beta−2) required before a veto may fire — keeps
   *  the prior itself from vetoing fresh arms. 6 ⇒ "two strikes": one
   *  accidental tap (evidence 3) is forgiven; two (evidence 6) is a
   *  pattern. 3 skips + 2 completions (rate 0.667) stay un-vetoed. */
  vetoMinEvidence: 6.0,
  /** Bounded pre-hydration update queue (rule ⑦ — hydration is lazy). */
  pendingCap: 100,
  /** Bounded pre-hydration seed queue (BAR 3.3). */
  seedQueueCap: 50,
  /** Debounced kv flush for arm updates (amortized write rule ⑦). */
  flushDebounceMs: 4000,
} as const;

/** Phase 4 — the directed Markov flow memory ("what follows what"). */
export const FLOW = {
  /** Per-node top-K outgoing transitions kept (heavy pruning). */
  outEdgeCap: 8,
  /** Edge weight floor — weaker edges are pruned (co-play floor parity). */
  edgeWeightFloor: 0.02,
  /** Global directed-edge budget (potato rule ⑧). */
  globalEdgeCap: 3000,
  /** Edges observed ≥ this many times inside ONE daypart cell get the
   *  second-order daypart bonus baked into their weight. */
  daypartBonusMinCount: 2,
  daypartBonusMultiplier: 1.25,
} as const;

/** Phase 5 — lyric mood reading (VADER + romanized Hindi/Punjabi). */
export const LYRIC_MOOD = {
  /** Blend confidence — below dataset (0.8): a vibe nudge, not truth. */
  confidence: 0.6,
  /** |Δvalence| hard bound. LOCKED by the literal 0.25 in
   *  tests/ai/lyric_mood_locks.test.ts (BAR 1.2 — do not unliteral). */
  maxDelta: 0.25,
  /** kv LRU cap for per-recordingKey lyric mood entries. */
  cacheCap: 1000,
  /** Fewer lexicon hits than this is noise — no shift applied. */
  minHits: 3,
} as const;

/** Phase 6 — tag-overlap similarity (the sound-alike engine). */
export const SIMILARITY = {
  /** Truth condition: a sound-alike must share ≥2 tag dimensions. */
  minSharedTags: 2,
  /** Same-artist dimension is down-weighted (clones must not win on
   *  artist alone — the whole point is sound-ALIKE, not same-artist). */
  artistTagWeight: 0.3,
  /** Max tracks per artist inside one sound-alike list. */
  perArtistCap: 2,
  /** Candidate pool bounds (mirrors aiPoolMin/Max — never index the world). */
  poolMin: 60,
  poolMax: 120,
  /** Cache lifetime (same stability class as On The Rise). */
  cacheDays: 7,
} as const;

/** BAR 2.2 — behavioral calibration against ground-truth-ish sources. */
export const CALIBRATION = {
  /** When the base estimate came from the baked dataset or the lyric
   *  mood read, observed behavior may only drift the estimate ±0.05
   *  per channel. Breaks the "sad song reclassified happy by 2am
   *  listens" feedback loop. */
  groundTruthCap: 0.05,
} as const;

/** BAR 3.8 — session-aware search ranking (tie-breaker, never SIG). */
export const SEARCH_VIBE = {
  /** Max score bonus for baked-energy alignment with the session vibe.
   *  0.5 is ~1.6 provider-rank steps (3.0 × 0.91-decay ≈ 0.27/step) —
   *  big enough to reorder TIES, small enough that the SIG override
   *  caps (which bind AFTER the bonus) keep explicit intent on top. */
  maxBonus: 0.5,
  /** Energy targets per vibe (the direction the room is heading). */
  targetEnergy: { PEAK: 0.85, FLOW: 0.7, WIND_DOWN: 0.2 } as Record<string, number | undefined>,
} as const;

/** Phase 1 — captured (free) genre evidence weight = explicit seed × 0.5.
 *  The listener never typed it, so it carries half an onboarding pick. */
export const CAPTURED_GENRE_WEIGHT = ONBOARDING.genreSeedWeight * 0.5;

// ── THE TEN (v4.3.0 mission) — WAVE 1: the playback engine ──────────────

/** FEATURE 1 — Smart Volume (ReplayGain-style loudness smoothing from the
 *  baked Spotify `energy` column — no audio analysis, a pure lookup). */
export const SMART_VOLUME = {
  /** Baked energy at/above which attenuation begins (top-tier bangers). */
  highEnergy: 0.85,
  /** Baked energy at/below which the lift begins (ambient/lofi floor). */
  lowEnergy: 0.3,
  /** Attenuation target at energy 1.0 — bangers ride noticeably quieter. */
  highFloor: 0.82,
  /** Lift target at energy 0.0 — near-silent tracks get headroom back. */
  lowLift: 1.05,
  /** Absolute clamp — the multiplier can never leave [0.8, 1.05], even
   *  for out-of-range energies (defensive; baked rows are 0..1). */
  min: 0.8,
  max: 1.05,
  /** Default ON (Spotify's volume normalization defaults on too; the max
   *  effect is ±0.18 and the OFF path is byte-identical to v4.2.0 — the
   *  multiplier pins to exactly 1.0). Documented decision, not an accident. */
  defaultOn: true,
} as const;

/** FEATURE 2 — Crossfade / transition fade. RNTP v4.1.1 exposes NO
 *  crossfade API and its single ExoPlayer instance cannot overlap two
 *  streams, so this ships as a volume-automation fade with the honest
 *  limitation stated in the UI (never claims true gapless). */
export const CROSSFADE = {
  /** Hard clamp — the control can never request a longer ramp. */
  maxSeconds: 12,
  /** Offered durations (PULSE chips; 0 = off — the native queue
   *  transition, i.e. today's behavior byte-identically). */
  choicesSeconds: [0, 2, 4, 6, 8, 12] as const,
  /** Default OFF: transitions untouched until the listener asks. */
  defaultSeconds: 0,
  /** Playhead regression that counts as a NEW track (seek protection):
   *  a backward jump larger than this resets the fade ramp. */
  backJumpToleranceSec: 0.25,
} as const;

/** FEATURE 3 — Playback speed (lectures/lofi at 0.75×–2×). ExoPlayer
 *  time-stretches with Sonic so pitch is preserved; RNTP v4 exposes no
 *  remote speed capability, so the control is in-app by design. */
export const PLAYBACK_RATE = {
  /** The whole allowed set — anything else snaps to the nearest member. */
  allowed: [0.75, 1.0, 1.25, 1.5, 2.0] as const,
  /** 1.0 is always one tap away and the boot default. */
  defaultRate: 1.0,
} as const;

/** Wave-1 volume arbitration: SINGLE WRITER of TrackPlayer.setVolume.
 *  effective = smartVolumeMultiplier × activeFadeFactor, where at most
 *  ONE fade owner is honored at a time — FEATURE 10's single-owner rule
 *  (sleep timer outranks focus outranks crossfade; a lower-priority
 *  engine's factor waits its turn instead of fighting). */
export const VOLUME_FADE_PRECEDENCE = ['sleep', 'focus', 'crossfade'] as const;

// ── THE TEN — WAVE 2: library & data ────────────────────────────────────

/** FEATURE 4 — Smart auto-playlists (live query folders over the ledger
 *  + favorites + play counts). The Graveyard window is capped at the
 *  raw-event retention (RETENTION.rawEventDays = 90) — we never query
 *  beyond what is stored. */
export const SMART_FOLDERS = {
  /** Heavy Rotation: ≥10 plays (listen attempts) inside the last 14 days. */
  heavyWindowDays: 14,
  heavyMinPlays: 10,
  /** Forgotten Gems: hearted, last play older than 90 days. Tracks with
   *  NO play evidence are NOT "forgotten" (they are unexplored — claiming
   *  staleness without a timestamp would fabricate history). */
  forgottenDays: 90,
  /** The Graveyard: skip ratio > 0.6 with ≥3 plays (candidates to remove). */
  graveyardWindowDays: 90, // = RETENTION.rawEventDays — the honest ceiling
  graveyardMinPlays: 3,
  graveyardSkipRatio: 0.6,
} as const;

/** FEATURE 5 — local metadata overrides: how many corrections the device
 *  stores (LRU by updatedAt; AsyncStorage lease, same class as the
 *  playCounts cap). Lives here, not in the storage module, so tuning is
 *  a one-file edit (house rule ④). */
export const META_OVERRIDES = {
  /** Hard cap on stored corrections. */
  cap: 500,
} as const;

// ── THE TEN — WAVE 3: intelligence & social (serverless, privacy-first) ──

/** FEATURE 6 — Local Wrapped / Monthly Rewind (computed on-device from
 *  the Event Ledger; shares as a card or honest text). */
export const WRAPPED = {
  /** Below this many streams (30-second rule) the rewind refuses to
   *  pretend: the UI shows "not enough listening yet". */
  minStreams: 10,
  /** Midnight Obsession window (local hours; end exclusive). */
  midnightFromHour: 0,
  midnightToHour: 4,
  /** The energy/valence split separating the aura quadrants. */
  auraSplit: 0.5,
  /** Card list sizes. */
  topArtistCount: 5,
  topTrackCount: 5,
} as const;

/** FEATURE 7 — Taste DNA Blend (peer-to-peer, serverless). The payload
 *  carries ONLY taste aggregates — never raw ledger events (privacy). */
export const TASTE_DNA = {
  /** Payload version — decode refuses anything else (honest failure). */
  version: 1,
  /** Top artists carried in the code (bounded payload, base64url-safe). */
  artistCount: 20,
  /** Top genres carried in the code. */
  genreCount: 8,
  /** Bridge artists each side contributes (the meeting-ground seeds). */
  bridgePerSide: 5,
  /** Blend playlist size target. */
  blendTracks: 25,
  /** A DNA younger than this many known artists is honestly "too young
   *  to share" — sharing a 0-artist DNA would fabricate a one-sided
   *  blend and call it a meeting of tastes. */
  minArtistsForShare: 3,
  /** Wall-clock budget for the blend's artist resolution (offline-ish
   *  users must not stare at BLENDING… forever); an honest partial
   *  blend ships with whatever resolved in time. */
  resolveBudgetMs: 8000,
} as const;

// ── THE TEN — WAVE 4: immersion (the emotional layer) ───────────────────

/** FEATURE 8 — Kinetic typography lyrics (the SingAlong upgrade).
 *  Row height is UNIFORM on purpose: the scroll math (activeIdx ×
 *  lineHeight) must never drift when the active line changes size. */
export const KINETIC = {
  /** The active line's display size (the "singing" line). */
  activeFontSize: 24,
  /** Upcoming/past lines — present, but clearly not the moment. */
  inactiveFontSize: 14,
  /** Uniform row height (the auto-scroll contract depends on it). */
  lineHeight: 40,
  /** Upcoming lines dim to this opacity (a cheap dim — never a real
   *  blur, which costs fill-rate a potato phone does not have). */
  inactiveOpacity: 0.38,
} as const;

/** FEATURE 9 — Aura Visualizer (battery-safe, GPU-cheap: three gradient
 *  layers animating ONLY opacity, native driver, no per-frame JS math;
 *  the layer count is JSX structure, not a runtime tuning number). */
export const AURA = {
  /** Pulse period mapped from baked energy: calm songs breathe slowly. */
  slowPulseMs: 5200,
  fastPulseMs: 2100,
  /** Glow opacity range across the pulse. */
  minGlow: 0.14,
  maxGlow: 0.34,
  /** Data saver CALMS the aura to half speed (battery first); the OS
   *  reduce-motion intent freezes it entirely (auraMode). */
  dataSaverCalms: true,
} as const;

/** FEATURE 10 — Pomodoro / Focus Mode (the study timer that owns the
 *  player). Fade precedence: sleep > focus (VOLUME_FADE_PRECEDENCE) —
 *  an armed sleep timer always outranks the focus fade. */
export const FOCUS = {
  /** Offered durations (PULSE chips). */
  choicesMinutes: [15, 25, 45] as const,
  /** One tap arms the default; cancel restores everything. */
  defaultMinutes: 25,
  /** The final fade window (linear ramp to 0 through the volume bus). */
  fadeMs: 8000,
  /** The short break offered after a completed session. */
  breakMinutes: 5,
  /** Focus playlist: baked energy at/below this is "focus-friendly". */
  maxEnergy: 0.45,
  /** Focus playlist size. */
  picksCount: 12,
} as const;

// ── THE MAGNUM OPUS (v5.0.0 mission) — WAVE 1: performance & polish ─────

/** F1 — Predictive Track Pre-warming: when track N starts, the stream
 *  URLs of N+1/N+2 are re-resolved through the same ladder buildPlayable
 *  uses (YT client ladder / saavn rescue) and parked in a single-use
 *  store. Queue rebuilds, shuffle reorders, smart-shuffle heals and the
 *  just-in-time recommendation/radio inserts then consume the parked
 *  URLs instead of paying a fresh resolve. */
export const PREWARM = {
  /** How many UPCOMING tracks are primed (the radioPrefetch precedent). */
  ahead: 2,
  /** Hard cap on the parked-promise store (LRU eviction, potato rule ⑧).
   *  ahead×2 headroom so two primes can overlap during fast skips. */
  cap: 5,
  /** Parked URLs expire: CDN links carry signed query params (JioSaavn
   *  and YT googlevideo both rot). A prewarmed URL consumed after this
   *  window is DISCARDED, never handed to the player — a fresh resolve
   *  is slower than a dead URL is fatal. */
  ttlMs: 30_000,
  /** The savings bar the feature must clear vs a fresh resolve (locked
   *  in tests/wave1_prewarm_locks.test.ts with a 600ms fake resolver). */
  minSavedMs: 500,
} as const;

/** F2 — Search prefetch: at ≥3 characters the typeahead pipeline is
 *  fired in parallel with the 700ms debounce, so by Enter-press (or by
 *  the debounce itself) the LRU-200 retrieve cache already holds the
 *  ranked list. The prefetch runs the real orchestrator with learning
 *  DISABLED (deps.disabled() === true) — the user-visible search stays
 *  the single writer of lexicon/ledger evidence (house rule ③). */
export const SEARCH_PREFETCH = {
  /** Below 3 characters provider results are noise (prefix flood). */
  minLength: 3,
  /** The cache-hit budget a prefetched query must answer inside when
   *  the real search lands on it (retrieve()'s LRU path budgets <15ms;
   *  the lock asserts the whole orchestrator call <50ms). */
  hitBudgetMs: 50,
} as const;

/** F3 — Image prefetch for the queue: next N artworks are warmed through
 *  RN Image.prefetch so the transition paints art, not placeholders.
 *  Gated exactly like F1 (data saver ⇒ WiFi only). */
export const IMAGE_PREWARM = {
  /** Queue rows ahead of the current track whose art gets warmed. */
  ahead: 5,
  /** LRU cap on the already-prefetched URI set (memory rule ⑧; a URI
   *  set entry is a string — 60 rows ≈ a few KB). */
  cap: 60,
  /** A warmed URI is not re-warmed inside this window (RN's image cache
   *  is opaque; this only bounds OUR re-issue rate). */
  ttlMs: 10 * 60_000,
} as const;

/** F4 — Cinema transition: tapping a row flies its art to the player's
 *  hero slot (pure-JS Animated — react-native-reanimated is NOT a
 *  dependency of this repo, and adding it for one transition violates
 *  potato rule ⑯; the mission explicitly provides for the fallback). */
export const CINEMA = {
  /** Flight duration — the bar is <400ms end to end. */
  durationMs: 340,
  /** An armed flight older than this is honestly skipped (the player
   *  must consume it while the tap is still "the same gesture"). */
  armTtlMs: 600,
  /** Retry window for the player's first consume attempt (measureInWindow
   *  resolves on the next frame; one retry covers a lost frame). */
  consumeRetryMs: 150,
  /** How long the overlay waits for the image's onLoad before giving up
   *  honestly (the row JUST displayed this URI, so it is nearly always
   *  memory-cached and onLoad lands the same frame; the timeout covers
   *  the degenerate slow-CDN case). Blind-critic P0-1: without a WAIT
   *  state the mount effect ran unloaded, self-skipped and unmounted —
   *  the flight could never start. */
  loadWaitMs: 800,
  // critic N1: loadWaitMs > armTtlMs means a load landing in the final
  // 200ms of the wait window is already expired and skips — harmless
  // (unloaded art paints nothing), documented overlap, not a bug.
  /** The double-tap guard mirrors miniModel.DOUBLE_TAP_MS (320) — the
   *  runtime uses isDoubleTap() directly so the two cannot drift. */
  doubleTapWindowMs: 320,
} as const;

// ── THE MAGNUM OPUS (v5.0.0 mission) — WAVE 2: emotional features ──────

/** F6 — Song Stories: personal notes attached to recordings ("this was
 *  playing when we met"). Factual USER data, not a recommendation — the
 *  kill switch deliberately does NOT gate it (the switch disables the
 *  intelligence layer; it must never delete or hide the user's own
 *  memories). Every number here is a storage bound, not a score. */
export const STORIES = {
  /** LRU cap (by updatedAt) on stored stories. 1000 memories at ~200
   *  bytes ≈ 200KB SQLite worst case — a decade of heavy use stays
   *  lightweight (potato rule ⑯: every new table declares its cap). */
  cap: 1000,
  /** Hard character cap on one story's text. A memory note, not a
   *  diary — keeps a single row honest and the input box scroll-free. */
  maxChars: 500,
} as const;

/** F7 — Audio Bookmarks: long-press the progress bar to save a position
 *  (+ optional note); dots on the bar; tap a dot to jump. Keyed by
 *  recordingKey so a bookmark survives source switches (saavn→YT for the
 *  same recording keeps its place). */
export const BOOKMARKS = {
  /** Per-recording cap (a 10-min podcast chapter list, not a diary). */
  perTrackCap: 50,
  /** Global cap across all recordings (LRU by createdAt). */
  totalCap: 500,
  /** Optional note length bound. */
  maxNoteChars: 120,
  /** The press-and-hold duration that distinguishes SAVE from SCRUB —
   *  a normal scrub gesture ends well under this; holding still longer
   *  means "remember this spot". Distinct gesture, scrubbing untouched. */
  longPressMs: 550,
  /** Max finger travel (px) during the hold for it to count as a
   *  long-press and not a slow scrub. */
  moveTolerancePx: 10,
  /** Bookmark positions snap to whole seconds (clean dots, clean jumps). */
  snapMs: 1000,
  /** Tap-to-JUMP radius around a dot (px) — generous, because a jump is
   *  non-destructive (blind-critic P1: the F7 hit area is wider than the
   *  6px dot on purpose, so quick taps near a dot still land on it). */
  dotHitPx: 14,
  /** Hold-to-DELETE radius around a dot (px) — deliberately NARROW (the
   *  visible dot itself): the blind critic caught that reusing the
   *  generous 14px radius for the destructive branch made "hold NEAR a
   *  bookmark" silently destroy it instead of saving a new one. */
  dotDeletePx: 4,
} as const;

/** F8 — Taste Radar: six axes in [0,1], each a DOCUMENTED formula over
 *  the listener's own graded listens. Pure description of data the
 *  listener already owns — no kill-switch involvement (same posture as
 *  stats()). */
export const RADAR = {
  /** Axis formulas (all clamp01'd by the caller):
   *  energy   = mean baked/estimated energy of counted streams
   *  valence  = mean valence of counted streams
   *  diversity= distinctArtists / artistSaturation  (more artists = wider taste)
   *  discovery= tracksWithSinglePlay / distinctTracks (1-play rows = finds you met once)
   *  loyalty  = topArtistShare / loyaltySaturation   (one artist's share of streams)
   *  eraSpread= distinctDecades / eraSaturation      (how many eras you roam)
   * Saturation = the raw share/value that reads as a FULL axis. */
  artistSaturation: 25,
  loyaltySaturation: 0.5,
  eraSaturation: 6,
  /** The 30-second rule applies before any axis is computed — a 2s
   *  accidental open is not taste evidence. */
  minStreamMs: 30000,
  /** Listen window the radar reads (graded listens are retained 180d). */
  windowDays: 180,
  /** Hexagon render size scale for the share card. */
  chartSize: 240,
} as const;

/** F9 — Time Machine ("This Day Last Year"). THE LEDGER IS SACRED
 *  GROUND (R-LOCK-1): the raw events table, its id format and the 90-day
 *  RETENTION.rawEventDays behavior stay byte-identical; the summary is a
 *  NEW table written during the EXISTING first-open-of-day compaction
 *  pass (never a separate scan), with its own retention below. */
export const HISTORY = {
  /** Top-N tracks/artists kept per day in the summary. */
  topN: 5,
  /** Summary retention in days (3 years ≈ 1096 rows). MEASURED on-disk
   *  cost with the compact array encoding (historical.ts): a full day
   *  (top-5+top-5) ≈ 350B, the scripted 400-day realistic fixture ≈
   *  59KB total, 3 years of the same realistic pattern ≈ 163KB. The
   *  original <100KB/3yr estimate holds for the 400-day bar and light
   *  use, not for three years of near-daily listening — stated honestly
   *  here rather than gamed in the fixture (anti-hallucination law ⑰). */
  retentionDays: 3 * 365 + 1,
  /** The month-day match window for "this day last year": the summary
   *  is matched on LOCAL calendar month/day across prior years. */
  lookbackYears: 3,
  /** Leap-safe year length for the lookback window arithmetic — 366
   *  OVERSHOOTS the retention edge on purpose (a 366th day slightly
   *  outside the window is harmless; a 365-day window could drop Feb 29
   *  summaries on leap years). Blind-critic note: law ④ wants no magic
   *  numbers, so it lives here with its rationale. */
  daysPerLookbackYear: 366,
} as const;

/** F5 — Hermes/metro cold-start optimization. Two REAL levers:
 *  (a) metro `inlineRequires: true` — Expo's default is FALSE
 *      (ExpoMetroConfig.js:322); inline requires defer every non-boot
 *      module's body off the startup path (the classic TTI win).
 *  (b) hermesc `-fstrip-function-names` — verified against the RN
 *      0.76.9 toolchain's `hermesc --help`; strips function names from
 *      the bytecode string table (the v4.3.1 verifier work showed that
 *      table is a large packed blob). Anti-hallucination note: the
 *      mission draft suggested '-emit-moving-average' — that flag DOES
 *      NOT EXIST in hermesc and was NOT shipped; '-O' was already the
 *      RN gradle default (ReactExtension.kt hermesFlags convention). */
export const HERMES = {
  /** Extra hermesc flags on top of the RN default ['-O','-output-source-map']. */
  extraFlags: ['-fstrip-function-names'] as const,
  /** Metro transform — inline requires ON (expo default false). */
  inlineRequires: true,
} as const;
