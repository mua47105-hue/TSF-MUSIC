/**
 * MINDBEAT type contracts — plan Appendix A (ledger) + Appendix B (profile).
 * Pure types + enums; no imports from React Native so the whole core is
 * testable in Node/bun.
 */

import type { BlockName, DayKind } from './constants';

// ── Events (Appendix A) ─────────────────────────────────────────────────

export type EventType =
  | 'SESSION_START'
  | 'APP_BACKGROUND'
  | 'TRACK_START'
  | 'TRACK_HEARTBEAT'
  | 'TRACK_SKIP'
  | 'TRACK_END'
  | 'TRACK_SEEK'
  | 'TRACK_LIKE'
  | 'TRACK_UNLIKE'
  | 'TRACK_DOWNLOAD'
  | 'QUEUE_ADD_MANUAL'
  | 'QUEUE_REMOVE'
  | 'REC_EXPOSURE'
  | 'SEARCH_QUERY'
  | 'SEARCH_CLICK'
  | 'PLAYLIST_SAVE_AI'
  | 'AI_REGENERATE'
  | 'NOT_FOR_ME'
  | 'STATION_ENDED';

/** Enumerated source surfaces — never free-text. */
export type SourceSurface =
  | 'user_playlist'
  | 'user_queue'
  | 'search'
  | 'chart'
  | 'daily_mix'
  | 'smart_shuffle'
  | 'radio'
  | 'daylist'
  | 'on_the_rise'
  | 'ai_playlist'
  | 'liked'
  | 'album'
  | 'artist_page'
  | 'home_feed';

export interface LedgerEvent<P = Record<string, unknown>> {
  /** Monotonic id (timestamp + counter — ULID-equivalent without deps). */
  id: string;
  /** Epoch ms. */
  ts: number;
  type: EventType;
  sessionId: string;
  trackId?: string;
  artistId?: string;
  surface?: SourceSurface;
  payload: P;
}

// ── Listen grades (§5.2) ────────────────────────────────────────────────

export type ListenGrade =
  | 'INSTANT_REJECT'
  | 'EARLY_SKIP'
  | 'MID_SKIP'
  | 'LATE_SKIP'
  | 'COMPLETED'
  | 'REPLAY'
  | 'HEART'
  | 'HEART_CONTRADICT'
  | 'DOWNLOAD'
  | 'NOT_FOR_ME';

export interface ListenRecord {
  trackId: string;
  artistId?: string;
  artist: string;
  title?: string;
  language?: string;
  genre?: string;
  year?: number;
  energy: number; // proxy feature at listen time
  valence: number;
  sessionId: string;
  surface: SourceSurface;
  startedTs: number;
  listenedMs: number;
  durationMs: number;
  completionRatio: number;
  grade: ListenGrade;
  skipBucket?: number; // 1..10 decile where the skip happened
  wasRecommended: boolean;
  reasonCode?: ReasonCode;
  explorationSlot: boolean;
}

export interface SessionRecord {
  id: string;
  startTs: number;
  endTs?: number;
  daypart: BlockName;
  dayKind: DayKind;
  trackCount: number;
  totalListenMs: number;
}

// ── Proxy Feature Space (§6.4) ──────────────────────────────────────────

export type TempoClass = 'slow' | 'mid' | 'fast';

export interface TrackFeatures {
  energy: number; // 0..1 arousal estimate
  valence: number; // 0..1 positivity estimate
  tempoClass: TempoClass;
  /** 0..1 — how much of this estimate is prior vs observed behavior. */
  confidence: number;
  source: 'prior' | 'metadata' | 'calibrated';
}

// ── Taste Profile (Appendix B) ──────────────────────────────────────────

export interface AffinityEntry {
  w: number; // decayed weight
  lastEventTs: number;
  evidenceCount: number;
  source: 'organic' | 'heart' | 'onboarding' | 'correction';
}

export interface BlockCell {
  artistWeights: Record<string, number>;
  genreWeights: Record<string, number>;
  energyMean: number;
  energyStd: number;
  valenceMean: number;
  valenceStd: number;
  sessionCount: number;
}

export interface MoodCell {
  id: string;
  label: string;
  energyCenter: number;
  valenceCenter: number;
  trackIds: string[];
}

export interface ArtistCluster {
  id: string;
  label: string; // top artist name
  artistIds: string[];
}

export interface SkipProfileEntry {
  buckets: number[]; // 10 deciles, normalized histogram
  listens: number;
}

export interface ExplorationState {
  epsilon: number;
  noveltyServed: number;
  noveltyConverted: number;
  lastScheduleTs: number;
  crossLanguageStreak: number;
}

export interface Corrections {
  mutedArtists: string[];
  mutedTracks: string[];
  boosts: Record<string, number>; // artistId → multiplier
  wrongLabels: string[]; // surfaces the user corrected via "You got me wrong"
}

export interface TasteProfile {
  builtAt: number;
  sessionCount: number;
  artists: Record<string, AffinityEntry>; // key: normalized artist name
  genres: Record<string, AffinityEntry>;
  languages: Record<string, AffinityEntry>;
  eras: Record<string, AffinityEntry>;
  proxy: {
    energyPref: { mean: number; std: number };
    valencePref: { mean: number; std: number };
    tempoDist: { slow: number; mid: number; fast: number };
  };
  daypart: Record<string, BlockCell>; // key: `${block}|${dayKind}`
  activities: Record<string, { confidence: number; lastObservedTs: number }>;
  skipProfiles: Record<string, SkipProfileEntry>;
  coplayTracks: Record<string, Record<string, number>>; // top-5000 edges
  coplayArtists: Record<string, Record<string, number>>; // top-2000 edges
  clusters: { artistClusters: ArtistCluster[]; moodCells: MoodCell[] };
  exploration: ExplorationState;
  corrections: Corrections;
  /** Learned block boundary offsets (minutes), applied after day 14. */
  boundaries: { weekday: Partial<Record<BlockName, number>>; weekend: Partial<Record<BlockName, number>> };
}

// ── Session Brain (§7) ──────────────────────────────────────────────────

export type VibeState = 'WARMUP' | 'FLOW' | 'PEAK' | 'WIND_DOWN' | 'SKIP_STORM' | 'EXPLORING';

export interface SessionState {
  id: string;
  startTs: number;
  daypart: BlockName;
  dayKind: DayKind;
  /** Ordered recent listens (bounded window). */
  window: ListenRecord[];
  sessionArtists: Map<string, number>;
  sessionGenres: Map<string, number>;
  energyTrajectory: number[];
  instantRejects: number[]; // ts of instant-rejects in window
  completionRate: number;
  dedupSet: Map<string, number>; // trackId → ts served
  vibe: VibeState;
}

// ── Decision Engine (§8) ────────────────────────────────────────────────

export type ReasonCode =
  | 'BECAUSE_PLAYED'
  | 'BECAUSE_HEARTED'
  | 'NEIGHBOR'
  | 'FITS_BLOCK'
  | 'SESSION_CONTINUITY'
  | 'FRESH_FIND'
  | 'FROM_YOUR_AI_MIX'
  | 'BACK_FOR_MORE';

export interface Candidate {
  trackId: string;
  artist: string;
  artistId?: string;
  language?: string;
  genre?: string;
  era?: string;
  features: TrackFeatures;
  pool: 'affinity' | 'neighborhood' | 'daypart' | 'cultural' | 'discovery';
  /** Set by the engine: */
  score?: number;
  reasonCode?: ReasonCode;
  explorationSlot?: boolean;
}

export interface DecisionContext {
  surface: SourceSurface;
  block: BlockName;
  dayKind: DayKind;
  seedTrackIds: string[];
  seedArtists: string[];
  requested: number;
}

export interface ScoredPick {
  trackId: string;
  artist: string;
  score: number;
  reasonCode: ReasonCode;
  explorationSlot: boolean;
}

// ── Surfaces ────────────────────────────────────────────────────────────

export interface ReasonLine {
  code: ReasonCode;
  line: string;
}

export interface TrackMetaMinimal {
  id: string;
  title: string;
  artist: string;
  album?: string;
  language?: string;
  year?: number;
  genre?: string;
}
