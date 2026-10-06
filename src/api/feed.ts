/**
 * Endless home feed (F2) — the Spotify-style "scroll forever" tail of Home.
 *
 * Design (grounded in the R4 live probes, scripts/probe_pagination.ts):
 *   • JioSaavn `search.getResults` paginates: 30 rows/page, 24-30 fresh
 *     ids per page. There is NO paged playlist search
 *     (`search.getPlaylists` = error), so the endless feed interleaves
 *     paged SONG batches (compact playable rows) with paged ALBUM
 *     batches (tappable Collection cards) — both real, both deep.
 *   • Batches alternate songs → albums → songs → … so the feed feels like
 *     Spotify's home: a shelf of cards, then a list of tracks, forever.
 *   • Each ladder is a CURSOR (query, page): a productive query serves
 *     its page 2, 3, … before the cursor moves to the next query — the
 *     feed goes deep, not just wide.
 *   • Every batch is deduped against everything emitted before it (ids)
 *     and against caller-supplied "already on screen" ids (prime()).
 *   • The pager is PURE + injectable: fetchers are passed in, so the
 *     rotation, dedupe and exhaustion logic is unit-testable with no
 *     network (tests/ai/feed_pager.test.ts).
 *
 * Output contract (the UI depends on these three states):
 *   • a songs/albums batch  → append and render
 *   • { kind: 'retry' }     → transient network failure — show a retry
 *                             row; the next call resumes the ladders
 *   • null                  → the pager is exhausted FOREVER — show the
 *                             honest end marker, never call again
 */

import type { Collection, Track } from '../types';
import { filterClean } from '../safety';
import { recordingKey, titleKeyOf, creditSetOf, sameCredits, nestedCredits, countTwins, primaryArtistOf } from './recording';

export interface FeedFetchers {
  searchSongs: (q: string, page: number, signal?: AbortSignal) => Promise<Track[]>;
  searchAlbums: (q: string, page: number, signal?: AbortSignal) => Promise<Collection[]>;
}

export type FeedBatch =
  | { kind: 'songs'; title: string; songs: Track[] }
  | { kind: 'albums'; title: string; albums: Collection[] }
  | { kind: 'retry' };

/** Rotating query ladders — broad, popular, safety-filterable by design. */
const SONG_QUERIES = [
  'top songs',
  'arijit singh',
  'punjabi hits',
  'romantic songs',
  'bollywood 2024',
  'party songs',
  'atif aslam',
  'sad songs',
  'dance hits',
  'kishore kumar',
  'lofi songs',
  'workout music',
  'shreya ghoshal',
  'sufi songs',
  'english hits',
  'a r rahman',
];

const ALBUM_QUERIES = [
  'hits',
  'romantic',
  'love',
  'party',
  'sad',
  'punjabi',
  'devotional',
  'dance',
  'acoustic',
  'workout',
  'classic',
  'instrumental',
];

/** How many times each ladder may be walked before honest exhaustion. */
const MAX_LADDER_PASSES = 3;
const SONGS_PER_BATCH = 14;
const ALBUMS_PER_BATCH = 12;
/** Minimum fresh rows for a batch to be worth rendering. */
const MIN_SONG_BATCH = 6;
const MIN_ALBUM_BATCH = 4;
/** Page size requested from the provider (good overlap tolerance). */
const FETCH_PAGE_SIZE = 30;

function titleCase(q: string): string {
  return q.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Per-ladder cursor: which query, how deep into its pages. */
interface LadderCursor {
  queryIdx: number;
  page: number;
  /** total times the cursor moved to a NEW query (exhaustion budget) */
  queriesUsed: number;
}

export class EndlessFeedPager {
  private songCursor: LadderCursor = { queryIdx: 0, page: 1, queriesUsed: 0 };
  private albumCursor: LadderCursor = { queryIdx: 0, page: 1, queriesUsed: 0 };
  private songLadder: string[];
  private albumLadder: string[];
  /** BAR 3.7 — MINDBEAT's dynamic query generator. Called when the song
   *  cursor advances to a NEW query; an empty/absent yield keeps the
   *  legacy hardcoded ladder (byte-identical cold start). */
  private songQueryGenerator?: () => string[];
  private dynSongLadder: { forQueryIdx: number; ladder: string[] } | null = null;
  private seenSongIds = new Set<string>();
  private seenSongKeys = new Set<string>();
  /** R8-P4b: title bucket → credit sets already shown — catches the
   *  re-ordered/truncated re-credit re-lists ACROSS batches (the key
   *  pass can't see those). Entries carry play counts for the twin
   *  escape (round-2 NEW-6: lyricist-first fuller-credit re-lists). */
  private seenSongBuckets = new Map<
    string,
    { credits: Set<string>; primary: string; plays?: number }[]
  >();
  private seenAlbumIds = new Set<string>();
  private lastWasSongs = false;
  private failures = 0;
  private exhausted = false;

  constructor(
    private fetchers: FeedFetchers,
    opts?: { songQueries?: string[]; albumQueries?: string[]; songQueryGenerator?: () => string[] },
  ) {
    this.songLadder = opts?.songQueries ?? SONG_QUERIES;
    this.albumLadder = opts?.albumQueries ?? ALBUM_QUERIES;
    this.songQueryGenerator = opts?.songQueryGenerator;
  }

  /** The active song ladder: MINDBEAT's generated one when it yields,
   *  cached per cursor position so one ladder stays stable while the
   *  cursor walks its pages (deterministic within a query). */
  private activeSongLadder(): string[] {
    if (this.songQueryGenerator) {
      if (!this.dynSongLadder || this.dynSongLadder.forQueryIdx !== this.songCursor.queryIdx) {
        const dyn = this.songQueryGenerator();
        this.dynSongLadder = {
          forQueryIdx: this.songCursor.queryIdx,
          ladder: dyn && dyn.length ? dyn : this.songLadder,
        };
      }
      return this.dynSongLadder.ladder;
    }
    return this.songLadder;
  }

  get isExhausted(): boolean {
    return this.exhausted;
  }

  private songLadderDone(): boolean {
    return this.songCursor.queriesUsed >= this.activeSongLadder().length * MAX_LADDER_PASSES;
  }

  private albumLadderDone(): boolean {
    return this.albumCursor.queriesUsed >= this.albumLadder.length * MAX_LADDER_PASSES;
  }

  /** Full recording-ledger check (R8-P4 + P4b): id, recording key,
   *  same-title nested credit sets (guarded), and play-count twins.
   *  Callers add the id — this method never mutates. */
  private seenRecording(t: Track): boolean {
    if (this.seenSongKeys.has(recordingKey(t))) return true;
    const bucket = this.seenSongBuckets.get(titleKeyOf(t));
    if (!bucket) return false;
    const credits = creditSetOf(t);
    const primary = primaryArtistOf(t);
    return bucket.some(
      (seen) =>
        nestedCredits(seen.credits, credits) &&
        (sameCredits(seen.credits, credits, seen.primary, primary) ||
          countTwins(seen.plays, t.playCount)),
    );
  }

  /** Register a row's identity in the ledger (id + key + bucket). */
  private registerRecording(t: Track): void {
    this.seenSongKeys.add(recordingKey(t));
    const title = titleKeyOf(t);
    if (!title) return;
    let bucket = this.seenSongBuckets.get(title);
    if (!bucket) {
      bucket = [];
      this.seenSongBuckets.set(title, bucket);
    }
    bucket.push({ credits: creditSetOf(t), primary: primaryArtistOf(t), plays: t.playCount });
  }

  /**
   * Pull fresh rows from one ladder. A productive (query, page) advances
   * deeper into the SAME query; a dry one moves the cursor to the next
   * query. Up to `maxAttempts` cursor positions are tried per call.
   *
   * CRITIC P2-2 fix: a fetch that THROWS is an error, not a dry page —
   * errors never advance the cursor or consume the exhaustion budget
   * (a flaky network must not permanently end the feed).
   */
  private async pullLadder<T>(
    kind: 'songs' | 'albums',
    signal: AbortSignal | undefined,
    maxAttempts: number,
    minRows: number,
  ): Promise<{ rows: T[]; title: string } | 'error' | null> {
    const ladder = kind === 'songs' ? this.songLadder : this.albumLadder;
    const cursor = kind === 'songs' ? this.songCursor : this.albumCursor;
    const seen = kind === 'songs' ? this.seenSongIds : this.seenAlbumIds;
    const isDone = kind === 'songs' ? this.songLadderDone : this.albumLadderDone;
    const fetchPage =
      kind === 'songs'
        ? (q: string, p: number) => this.fetchers.searchSongs(q, p, signal)
        : (q: string, p: number) => this.fetchers.searchAlbums(q, p, signal);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (isDone.call(this)) return null;
      const activeLadder = kind === 'songs' ? this.activeSongLadder() : ladder;
      const q = activeLadder[cursor.queryIdx % activeLadder.length];
      let rows: T[];
      try {
        const page = await fetchPage(q, cursor.page);
        rows = (kind === 'songs'
          ? (filterClean(page as unknown as Track[]) as unknown as T[])
          : (page as unknown as Collection[])) as T[];
      } catch {
        return 'error'; // network failure — NOT a dry page, no budget burn
      }
      // R8-P4 recording-level dedup: songs collapse by id AND by
      // title+primary-artist key (kept INSIDE one page too — the same
      // page can carry "Zalima" 5x with 5 different ids). Albums stay
      // id-only (a re-issued album shelf is legitimately distinct).
      // R8-P4b: same-title rows with NESTED credit sets collapse too
      // ("Tum Hi Ho | Mithoon, Arijit" after "… | Arijit, Mithoon").
      const freshRows: Array<{ id: string }> = [];
      for (const r of rows as Array<{ id: string }>) {
        if (seen.has(r.id)) continue;
        if (kind === 'songs' && this.seenRecording(r as Track)) continue;
        seen.add(r.id);
        if (kind === 'songs') this.registerRecording(r as Track);
        freshRows.push(r);
      }
      if (freshRows.length >= minRows) {
        cursor.page += 1; // next call goes deeper into this query
        return { rows: freshRows as unknown as T[], title: titleCase(q) };
      }
      // dry: move to the next query, restart at page 1
      cursor.queryIdx += 1;
      cursor.page = 1;
      cursor.queriesUsed += 1;
    }
    return null;
  }

  /**
   * Emit the next batch — alternates kinds, falls through to the other
   * kind when the preferred one comes up dry, and only ever returns null
   * when BOTH ladders are fully walked (honest exhaustion).
   */
  async next(signal?: AbortSignal): Promise<FeedBatch | null> {
    if (this.exhausted) return null;

    // both ladders walked — done forever
    if (this.songLadderDone() && this.albumLadderDone()) {
      this.exhausted = true;
      return null;
    }

    // transient network death — offer an honest retry, keep the pager alive
    if (this.failures >= 2) {
      this.failures = 0; // a subsequent call retries the ladders
      return { kind: 'retry' };
    }

    const firstSongs = !this.lastWasSongs;
    let songs: FeedBatch | null = null;
    let albums: FeedBatch | null = null;
    let errored = false;

    const pull = async (kind: 'songs' | 'albums'): Promise<FeedBatch | null> => {
      if (kind === 'songs') {
        const pulled = await this.pullLadder<Track>('songs', signal, 2, MIN_SONG_BATCH);
        if (pulled === 'error' || !pulled) {
          if (pulled === 'error') errored = true;
          return null;
        }
        return {
          kind: 'songs' as const,
          title: pulled.title,
          songs: pulled.rows.slice(0, SONGS_PER_BATCH),
        };
      }
      const pulled = await this.pullLadder<Collection>('albums', signal, 2, MIN_ALBUM_BATCH);
      if (pulled === 'error' || !pulled) {
        if (pulled === 'error') errored = true;
        return null;
      }
      return {
        kind: 'albums' as const,
        title: 'More albums to explore',
        albums: pulled.rows.slice(0, ALBUMS_PER_BATCH),
      };
    };

    if (firstSongs) {
      songs = await pull('songs');
      if (!songs) albums = await pull('albums');
    } else {
      albums = await pull('albums');
      if (!albums) songs = await pull('songs');
    }

    const batch = songs ?? albums;
    if (batch) {
      this.lastWasSongs = batch.kind === 'songs';
      this.failures = 0;
      return batch;
    }

    // network errors count toward the retry threshold but never burn the
    // ladder budget (the cursor never moved on error)
    this.failures += 1;
    if (this.failures >= 2) {
      this.failures = 0; // a subsequent call retries the same cursor
      return { kind: 'retry' };
    }
    // ladders walked out AND genuinely dry (no fetch errors) → done forever
    if (!errored && this.songLadderDone() && this.albumLadderDone()) {
      this.exhausted = true;
      return null;
    }
    // one empty round is not death: let the UI try again on next scroll
    return { kind: 'retry' };
  }

  /** Register ids AND recording identities already on screen (fixed
   *  shelves) so the feed never repeats them — "Trending now" showing
   *  Zalima also suppresses every compilation and re-credited re-list
   *  of Zalima below (R8-P4 + P4b). */
  prime(seen: { songs?: Track[]; albums?: Collection[] }): void {
    for (const t of seen.songs ?? []) {
      this.seenSongIds.add(t.id);
      this.registerRecording(t);
    }
    for (const c of seen.albums ?? []) this.seenAlbumIds.add(c.id);
  }
}

export { FETCH_PAGE_SIZE };
