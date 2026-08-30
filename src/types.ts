export type TrackSource = 'saavn' | 'itunes' | 'youtube';

export interface Track {
  /** Stable provider id */
  id: string;
  title: string;
  artist: string;
  album?: string;
  albumId?: string;
  artistId?: string;
  /** Remote artwork URL (already upgraded to 500px where possible) */
  artwork: string;
  /** Seconds — may be 0/unknown for streams until playback starts */
  duration: number;
  source: TrackSource;
  /** JioSaavn song id when source === 'saavn' (used to refresh stream URLs) */
  saavnId?: string;
  /** Provider-encrypted stream URL — decrypted lazily at play time */
  encryptedUrl?: string;
  /** iTunes 30s preview (fallback stream) */
  previewUrl?: string;
  /** True when only a preview-length stream is available */
  previewOnly: boolean;
  /** JioSaavn 320kbps availability flag — false keeps the 96k URL */
  has320?: boolean;
  /** Catalog language (hindi/punjabi/english/…) — powers language affinity */
  language?: string;
  /** Release year — powers era affinity */
  year?: number;
  /** Attached by MINDBEAT surfaces — the truthful explanation line */
  reason?: string;
  reasonCode?: string;
  /** True when this serve came from an exploration slot (§8.4) */
  exploration?: boolean;
  /** SEARCH V2 (§8): full primary-artist list for matching/display */
  artistsFull?: string[];
  featuredArtists?: string[];
  hasLyrics?: boolean;
  /** First lyric line from the provider — free V1 verification signal */
  lyricsSnippet?: string;
  releaseDate?: string;
  playCount?: number;
  /** Set by S2 when the track was verified against typed lyrics */
  lyricMatch?: boolean;
  matchedLine?: string;
  /** Version-cluster size (S2): "+N versions" affordance */
  versionCount?: number;
  /** Which search plan kind surfaced this row */
  planKind?: string;
  /** Local downloaded file URI (documentDirectory path) */
  localUri?: string;
  /** Provider explicit flag (kept for search badges; filtered off home) */
  explicit?: boolean;
  /** Injected by Smart Shuffle — badges the row with a sparkle */
  isRecommended?: boolean;
  /** YouTube video id when source === 'youtube' (stream resolve + refresh) */
  youtubeId?: string;
  /** Resolved stream URL — set by the YT rescue/resolve path (cache-backed) */
  streamUrl?: string;
  /** YouTube entity type — Song rows rank above lyric/cover videos */
  ytKind?: 'song' | 'video' | 'album';
  /** True when the row arrived through a SIG rescue rung (truthful labelling) */
  rescued?: boolean;
  /** Which rescue rung found it: youtube | itunes | variant | album */
  rescueRung?: 'youtube' | 'itunes' | 'variant' | 'album';
}

export interface Collection {
  id: string;
  title: string;
  subtitle?: string;
  artwork: string;
  trackCount?: number;
  /** How to resolve tracks when none were passed in the route */
  kind?: 'chart' | 'search' | 'album';
  /** Search query for kind === 'search' */
  query?: string;
}

export interface SearchResult {
  tracks: Track[];
  degraded: boolean;
}

/** Specific Intent Guarantee state (SEARCH-INTENT-RESCUE-PLAN §3.1).
 *  The UI must DECLARE which of the four states it is in — never paint
 *  an artist-matching, title-zero row as "Best match". */
export type SigState = 'hit' | 'rescued' | 'partial' | 'zero';

export interface Playlist {
  id: string;
  name: string;
  createdAt: number;
  tracks: Track[];
  /** True when the playlist was produced by the AI generator */
  aiGenerated?: boolean;
  prompt?: string;
}

export interface DailyMix {
  id: string;
  title: string;
  subtitle: string;
  artwork: string;
  tracks: Track[];
}

export interface PlayCountEntry {
  track: Track;
  count: number;
  lastAt: number;
}

export interface ListeningStats {
  totalPlays: number;
  distinctTracks: number;
  topArtists: Array<{ artist: string; plays: number; artwork?: string }>;
  topTracks: PlayCountEntry[];
  minutesEstimate: number;
}
