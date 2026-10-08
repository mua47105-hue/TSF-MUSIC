/**
 * L1 — THE EVENT LEDGER (§5, "Signal Telescope").
 *
 * Every meaningful interaction becomes graded evidence:
 *   • append-only raw events (90-day retention, bounded ≤20k by compaction)
 *   • ListenRecords — the graded outcomes (skip taxonomy §5.2)
 *   • session records (30-min gap rule, §5.3)
 *   • crash-safe: 10s heartbeats let the next boot reconstruct a partial
 *     listen ("killing the app mid-track loses zero evidence" — §5.5).
 *
 * Write protocol (§5.4): a single serialized write chain; heartbeats
 * accumulate in memory and flush every HEARTBEAT_SECONDS so the amortized
 * write cost stays ≪10 ms.
 */

import {
  HEARTBEAT_SECONDS,
  HISTORY,
  RETENTION,
  SESSION,
  SKIP_THRESHOLDS,
} from './constants';
import type { LedgerStore } from './store';
import type { LedgerEvent, ListenRecord, ReasonCode, SessionRecord, SourceSurface } from './types';
import type { HistoricalDay } from './historical';
import { dayStartOf, foldEventsIntoDays, type TrackMeta } from './historical';
import { blockOf, dayKindOf } from './time';

export interface TrackStartMeta {
  trackId: string;
  artist: string;
  artistId?: string;
  title?: string;
  language?: string;
  genre?: string;
  year?: number;
  durationMs: number;
  energy: number;
  valence: number;
  wasRecommended: boolean;
  reasonCode?: ReasonCode;
  explorationSlot?: boolean;
}

let idCounter = 0;
/**
 * Monotonic under STRING comparison (store tiebreaks sort by id text):
 * the counter is zero-padded base-36, so "…-000z" < "…-0010" always.
 * 36^4 = 1.68M same-ms events before degradation (cap is 20k total —
 * unreachable). Found by the Search V2 gauntlet: unpadded ids reordered
 * same-timestamp events once the counter passed 35 ("z" → "10") and
 * broke crash recovery. LOCKED by tests/ai/search_rank.test.ts R-LOCK-1.
 */
function nextId(ts: number): string {
  idCounter += 1;
  return `${ts.toString(36)}-${idCounter.toString(36).padStart(4, '0')}`;
}

export class EventLedger {
  private store: LedgerStore;
  private now: () => number;
  private writeChain: Promise<unknown> = Promise.resolve();

  private sessionId = '';
  private sessionStartTs = 0;
  private sessionTrackCount = 0;
  private sessionListenMs = 0;
  private lastActivityTs = 0;
  private lastCompactionDay = '';
  /** Single-owner instrumentation state: last started track + ts. */
  private lastStartedId = '';
  private lastStartedTs = 0;
  /** trackId → ts of recent COMPLETED listens (cheap REPLAY checks). */
  private recentCompletions = new Map<string, number>();
  private recoveredStartIds = new Set<string>();

  /** The in-flight listen (TRACK_START … finalize). */
  private current: (TrackStartMeta & {
    startTs: number;
    surface: SourceSurface;
    listenedMs: number;
    lastFlushMs: number;
    pendingSkip: boolean;
  }) | null = null;

  private eventsSinceStart = 0;

  constructor(store: LedgerStore, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  // ── Boot ───────────────────────────────────────────────────────────────

  /** Open-time recovery + compaction (first open of day). Idempotent. */
  async init(): Promise<void> {
    await this.recoverPartialListen();
    await this.maybeCompact();
    // Hydrate the REPLAY cache from recent completions (cross-boot replays).
    try {
      const recent = await this.store.getlistens(this.now() - SKIP_THRESHOLDS.replayWindowDays * 86400_000);
      for (const l of recent) {
        if (l.grade === 'COMPLETED' || l.grade === 'REPLAY') {
          this.recentCompletions.set(l.trackId, l.startedTs);
        }
      }
    } catch {
      /* cache is an optimization */
    }
  }

  /**
   * Crash recovery (§5.5): find the last TRACK_START whose track never got
   * a TRACK_SKIP/TRACK_END, rebuild the partial listen from heartbeats.
   */
  private async recoverPartialListen(): Promise<void> {
    try {
      const events = await this.store.getEvents();
      const lastStartIdx = findLastUnclosedStart(events);
      if (lastStartIdx == null) return;
      const start = events[lastStartIdx];
      // Idempotence: recovery must append the partial listen EXACTLY ONCE.
      // Closing the start with a synthetic TRACK_END means the next boot's
      // findLastUnclosedStart skips it.
      if (this.recoveredStartIds.has(start.id)) return;
      this.recoveredStartIds.add(start.id);
      const meta = start.payload as Record<string, unknown>;
      let listenedMs = 0;
      for (let i = lastStartIdx + 1; i < events.length; i++) {
        const e = events[i];
        if (e.type === 'TRACK_HEARTBEAT' && e.trackId === start.trackId) {
          listenedMs = Number(e.payload.elapsedMs ?? 0);
        }
        if (e.type === 'TRACK_START') break; // a new track started — the old one is done
      }
      const durationMs = Number(meta.durationMs ?? 0) || 1;
      if (listenedMs <= 0) {
        // Still close the start (no listen worth recording <10s).
        await this.store.appendEvents([this.syntheticClose(start)]);
        return;
      }
      const ratio = Math.min(1, listenedMs / durationMs);
      const record: ListenRecord = {
        trackId: start.trackId ?? '',
        artistId: (meta.artistId as string) ?? undefined,
        artist: (meta.artist as string) ?? 'Unknown',
        title: meta.title as string | undefined,
        language: meta.language as string | undefined,
        genre: meta.genre as string | undefined,
        year: meta.year as number | undefined,
        energy: Number(meta.energy ?? 0.5),
        valence: Number(meta.valence ?? 0.5),
        sessionId: start.sessionId,
        surface: (start.surface ?? 'user_queue') as SourceSurface,
        startedTs: start.ts,
        listenedMs,
        durationMs,
        completionRatio: ratio,
        grade: gradeFor(false, listenedMs, durationMs, ratio),
        skipBucket: skipBucketOf(ratio),
        wasRecommended: Boolean(meta.wasRecommended),
        reasonCode: meta.reasonCode as ListenRecord['reasonCode'] | undefined,
        explorationSlot: Boolean(meta.explorationSlot),
      };
      await this.store.appendListen(record);
      // Close the reconstructed start so the next boot never re-appends it.
      await this.store.appendEvents([this.syntheticClose(start)]);
    } catch {
      /* recovery is best-effort — never block boot */
    }
  }

  /** A closing event for crash-recovered TRACK_STARTs (idempotence). */
  private syntheticClose(start: LedgerEvent): LedgerEvent {
    return {
      id: `${start.id}-rc`,
      ts: start.ts + 1,
      type: 'TRACK_END',
      sessionId: start.sessionId,
      trackId: start.trackId,
      payload: { recovered: true },
    };
  }

  /** First-open-of-day compaction + hard cap (§5.4).
   *
   *  F9 · TIME MACHINE (sacred-ground laws L1–L4): BEFORE the old events
   *  are deleted, the doomed events are folded into `historical_summary`
   *  (a NEW table — the events table, its ids and the 90-day behavior
   *  stay byte-identical) and the summary's own 3-year retention runs in
   *  the SAME pass. When the store predates F9 (no historical methods)
   *  the fold is skipped and deletion behaves exactly as before.
   *
   *  v5.0.1 FIX-A1 (the independent auditor's P1): the fold now GATES
   *  the deletion. The old code advanced the fold watermark BEFORE the
   *  summary upserts and deleted the raw events unconditionally — a
   *  failing upsert meant empty history, gone raw events, advanced
   *  watermark: permanent data loss. Now a failed fold RETAINS the raw
   *  events and the next compaction retries. */
  async maybeCompact(): Promise<void> {
    const today = new Date(this.now()).toDateString();
    if (today === this.lastCompactionDay) return;
    this.lastCompactionDay = today;
    try {
      const now = this.now();
      const cutoff = now - RETENTION.rawEventDays * 86400_000;
      // FIX-A1: fold-then-delete is now ATOMIC at the protocol level —
      // the raw events are deleted only when the fold committed (every
      // summary row persisted AND the watermark advanced). A failed fold
      // retains the events; the next compaction retries (L2: fold is
      // still strictly BEFORE delete in the success path).
      if (await this.foldDoomedEventsIntoHistory(cutoff)) {
        await this.store.deleteEventsBefore(cutoff);
      }
      const count = await this.store.countEvents();
      if (count > RETENTION.maxRawEvents) {
        // Hard cap: keep the newest (max - compactBatch) events.
        const events = await this.store.getEvents();
        const keepFrom = events[Math.max(0, events.length - (RETENTION.maxRawEvents - RETENTION.compactBatch))];
        if (keepFrom && (await this.foldDoomedEventsIntoHistory(keepFrom.ts))) {
          await this.store.deleteEventsBefore(keepFrom.ts);
        }
      }
      // L3 — the summary's own retention, same pass.
      if (this.store.deleteHistoricalDaysBefore) {
        await this.store
          .deleteHistoricalDaysBefore(now - HISTORY.retentionDays * 86400_000)
          .catch(() => undefined);
      }
    } catch {
      /* compaction failures are non-fatal */
    }
  }

  /**
   * F9 — fold the events about to be deleted (ts < cutoffTs) into
   * historical_summary. Returns TRUE when the caller may delete the raw
   * events (nothing to fold, or EVERY summary row persisted AND the
   * watermark committed); FALSE when the fold failed — the caller MUST
   * then retain the raw events and let the next compaction retry.
   *
   * THE ATOMICITY LAW (v5.0.1 FIX-A1, the auditor's P1): watermark
   * advancement, summary writes and raw-event deletion commit together
   * or not at all. The watermark is the LAST write of the fold — only
   * after every summary row for this fold is durable does
   * `foldedThroughTs` move. The old protocol wrote it FIRST ("declare
   * intent") and let deletion proceed regardless: a store that threw on
   * upsert permanently emptied the Time Machine.
   *
   * IDEMPOTENCY (kept from the blind-critic P1 design): the watermark
   * still fences already-folded events — a crash AFTER the commit but
   * BEFORE the delete leaves folded events in the raw table that no
   * later pass re-folds (ts > watermark excludes them), so minutes are
   * never counted twice on a clean retry.
   *
   * HONEST TRADE (documented, not hidden): the store interface has no
   * cross-table transaction, so a fold that fails MID-upsert can leave
   * some day rows persisted while the events survive. The retry re-folds
   * the same events and the cross-pass merge sums — those days can
   * over-count REAL minutes (nothing fabricated, nothing lost). The old
   * trade lost the days entirely; this one at worst inflates a day when
   * a store fails mid-fold. Raw evidence is the irreplaceable copy —
   * retention must never outrun the summary again.
   */
  private async foldDoomedEventsIntoHistory(cutoffTs: number): Promise<boolean> {
    if (!this.store.upsertHistoricalDay || !this.store.getHistoricalDays) return true; // pre-F9 store: deletion proceeds exactly as before (L1/L4)
    const WATERMARK = 'historical.foldedThroughTs';
    try {
      const prevWatermark = (await this.store.getKV<number>(WATERMARK)) ?? 0;
      const doomed = (await this.store.getEvents()).filter((e) => e.ts < cutoffTs && e.ts > prevWatermark);
      if (!doomed.length) return true; // nothing to fold — deletion may proceed
      // monotonic raise (the hard-cap pass can run after the 90-day
      // pass in the same compaction) — COMMITTED only after the upserts
      const newWatermark = Math.max(prevWatermark, cutoffTs - 1);
      // P0 (blind critic): the event stream carries artistId, never the
      // artist NAME — resolve names from the listens table (retained
      // 180d, so listens for 90d-doomed events always exist here).
      const meta = new Map<string, TrackMeta>();
      try {
        const listens = await this.store.getlistens(doomed[0].ts);
        for (const l of listens) {
          if (!l.trackId) continue;
          const cur = meta.get(l.trackId) ?? {};
          if (!cur.artist && l.artist) cur.artist = l.artist;
          if (!cur.title && l.title) cur.title = l.title;
          meta.set(l.trackId, cur);
        }
      } catch {
        /* a listen-join failure degrades to the honest Unknown, never blocks */
      }
      const existingRows = await this.store.getHistoricalDays();
      const existingByDay = new Map<string, HistoricalDay>();
      for (const row of existingRows) {
        // only merge rows whose day could overlap the doomed window
        if (row.dayStartTs >= dayStartOf(doomed[0].ts) && row.dayStartTs <= dayStartOf(doomed[doomed.length - 1].ts)) {
          existingByDay.set(row.dayKey, row);
        }
      }
      const folded = foldEventsIntoDays(doomed, existingByDay, HISTORY.topN, meta);
      // FIX-A1: EVERY summary row for this fold must persist BEFORE the
      // watermark moves. A failed upsert is counted, never swallowed
      // into a committed state.
      let upsertFailures = 0;
      for (const day of folded.values()) {
        if (existingByDay.has(day.dayKey) || day.streams > 0) {
          try {
            await this.store.upsertHistoricalDay(day);
          } catch {
            upsertFailures += 1;
          }
        }
      }
      if (upsertFailures > 0) return false; // raw events retained, watermark unchanged — retry on the next compaction
      // THE COMMIT — the watermark is the fold's LAST write, not its
      // first: only a fully-persisted fold may move it.
      await this.store.setKV(WATERMARK, newWatermark);
      return true;
    } catch {
      return false; // any fold-setup failure retains the raw events too
    }
  }

  // ── Sessions (§5.3) ────────────────────────────────────────────────────

  /** App became active. Starts a session after a ≥30 min gap. */
  async onAppActive(): Promise<string> {
    const now = this.now();
    const gapMin = (now - this.lastActivityTs) / 60000;
    if (!this.sessionId || gapMin >= SESSION.gapMinutes || this.lastActivityTs === 0) {
      if (this.sessionId) await this.closeSession(now);
      this.sessionId = `s-${nextId(now)}`;
      this.sessionStartTs = now;
      this.sessionTrackCount = 0;
      this.sessionListenMs = 0;
      await this.emit('SESSION_START', {});
    }
    this.lastActivityTs = now;
    return this.sessionId;
  }

  /** App backgrounded: checkpoint the session (app-kill durability) but
   *  do NOT finalize the in-flight listen — music typically keeps playing
   *  in the background and the service keeps sending heartbeats. */
  async onAppBackground(): Promise<void> {
    this.lastActivityTs = this.now();
    await this.emit('APP_BACKGROUND', {
      sessionDurationMs: this.now() - this.sessionStartTs,
    });
    if (this.sessionId) {
      const inFlightMs = this.current?.listenedMs ?? 0;
      await this.store.upsertSession({
        id: this.sessionId,
        startTs: this.sessionStartTs,
        daypart: blockOf(this.sessionStartTs),
        dayKind: dayKindOf(this.sessionStartTs),
        trackCount: this.sessionTrackCount,
        totalListenMs: this.sessionListenMs + inFlightMs,
      });
    }
  }

  private async closeSession(endTs: number): Promise<void> {
    if (!this.sessionId) return;
    const record: SessionRecord = {
      id: this.sessionId,
      startTs: this.sessionStartTs,
      endTs,
      daypart: blockOf(this.sessionStartTs),
      dayKind: dayKindOf(this.sessionStartTs),
      trackCount: this.sessionTrackCount,
      totalListenMs: this.sessionListenMs,
    };
    await this.store.upsertSession(record);
    this.sessionId = '';
  }

  // ── Track lifecycle ────────────────────────────────────────────────────

  async trackStarted(meta: TrackStartMeta, surface: SourceSurface): Promise<void> {
    // SINGLE-OWNER GUARD: two instrumenters (UI effect + background service
    // tick) may both report the same transition. Re-starting the identical
    // in-flight track is a no-op — never a phantom finalize+restart.
    if (this.current && this.current.trackId === meta.trackId && this.current.listenedMs < 15000) {
      this.current.surface = surface;
      return;
    }
    if (this.lastStartedId === meta.trackId && this.current == null && this.now() - this.lastStartedTs < 2000) {
      return; // duplicate start event for an already-finalized track
    }
    // A new TRACK_START implicitly finalizes any in-flight listen as a skip
    // (the user jumped away) unless it was already finalized.
    if (this.current) await this.finalizeTrack(true, 'jump');
    const now = this.now();
    this.lastStartedId = meta.trackId;
    this.lastStartedTs = now;
    this.current = {
      ...meta,
      startTs: now,
      surface,
      listenedMs: 0,
      lastFlushMs: 0,
      pendingSkip: false,
    };
    this.sessionTrackCount += 1;
    this.lastActivityTs = now;
    if (this.sessionId) {
      await this.emit(
        'TRACK_START',
        {
          artistId: meta.artistId,
          durationMs: meta.durationMs,
          energy: meta.energy,
          valence: meta.valence,
          language: meta.language,
          genre: meta.genre,
          title: meta.title,
          wasRecommended: meta.wasRecommended,
          reasonCode: meta.reasonCode,
          explorationSlot: meta.explorationSlot ?? false,
          queuePosition: this.sessionTrackCount,
        },
        meta.trackId,
        meta.artistId,
        surface,
      );
    }
  }

  /**
   * Progress tick (1 s). Accumulates listened time; flushes a heartbeat
   * event every HEARTBEAT_SECONDS of accumulated listen.
   */
  async heartbeat(elapsedMs: number): Promise<void> {
    if (!this.current) return;
    this.current.listenedMs = Math.max(this.current.listenedMs, Math.min(elapsedMs, this.current.durationMs || elapsedMs));
    const sinceFlush = this.current.listenedMs - this.current.lastFlushMs;
    if (sinceFlush >= HEARTBEAT_SECONDS * 1000) {
      this.current.lastFlushMs = this.current.listenedMs;
      await this.emit(
        'TRACK_HEARTBEAT',
        { elapsedMs: this.current.listenedMs },
        this.current.trackId,
      );
    }
    this.lastActivityTs = this.now();
  }

  /** User scrubbed. Backward seeks are replay-evidence (§5.1). */
  async seek(fromMs: number, toMs: number): Promise<void> {
    if (!this.current) return;
    await this.emit('TRACK_SEEK', { fromMs, toMs }, this.current.trackId);
  }

  /** Mark the in-flight listen as user-initiated-skip (pressed Next). */
  markPendingSkip(): void {
    if (this.current) this.current.pendingSkip = true;
  }

  /**
   * Grade + persist the in-flight listen (§5.2). Called on skip, natural
   * end, track jump, or session close. Idempotent per track. Returns the
   * persisted record (or null) so callers can feed the SessionBrain
   * without re-reading storage.
   */
  async finalizeTrack(
    userInitiated: boolean,
    cause: 'skip' | 'end' | 'jump' | 'background' = 'end',
  ): Promise<ListenRecord | null> {
    const cur = this.current;
    if (!cur) return null;
    this.current = null;
    // A marked pending skip (RemoteNext / next button) always grades as
    // user-initiated even when the caller's flag is stale.
    const skipped = userInitiated || cur.pendingSkip || cause === 'jump';
    const now = this.now();
    const durationMs = cur.durationMs || Math.max(cur.listenedMs, 1);
    const ratio = Math.min(1, cur.listenedMs / durationMs);
    let grade = gradeFor(skipped, cur.listenedMs, durationMs, ratio);

    // REPLAY: completed/late + same track finalized COMPLETED again within 7d.
    if (grade === 'COMPLETED') {
      const priorTs = this.recentCompletions.get(cur.trackId);
      if (priorTs != null && now - priorTs <= SKIP_THRESHOLDS.replayWindowDays * 86400_000) {
        grade = 'REPLAY';
      }
    }

    const record: ListenRecord = {
      trackId: cur.trackId,
      artistId: cur.artistId,
      artist: cur.artist,
      title: cur.title,
      language: cur.language,
      genre: cur.genre,
      year: cur.year,
      energy: cur.energy,
      valence: cur.valence,
      sessionId: this.sessionId,
      surface: cur.surface,
      startedTs: cur.startTs,
      listenedMs: cur.listenedMs,
      durationMs,
      completionRatio: ratio,
      grade,
      skipBucket: skipBucketOf(ratio),
      wasRecommended: cur.wasRecommended,
      reasonCode: cur.reasonCode,
      explorationSlot: cur.explorationSlot ?? false,
    };
    this.sessionListenMs += cur.listenedMs;

    await this.store.appendListen(record);
    // Remember recent completions in-memory for cheap REPLAY detection
    // (the 7-day table read was a per-finalize hot-path cost).
    if (grade === 'COMPLETED' || grade === 'REPLAY') {
      this.recentCompletions.set(record.trackId, now);
      if (this.recentCompletions.size > 400) {
        const oldest = [...this.recentCompletions.entries()].sort((a, b) => a[1] - b[1]).slice(0, 100);
        for (const [k] of oldest) this.recentCompletions.delete(k);
      }
    }
    await this.emit(skipped ? 'TRACK_SKIP' : 'TRACK_END', {
      elapsedMs: cur.listenedMs,
      completionRatio: ratio,
      grade,
      cause,
    }, cur.trackId);
    return record;
  }

  // ── Discrete signals ───────────────────────────────────────────────────

  async liked(track: { id: string; artist: string; artistId?: string }, surface: SourceSurface): Promise<void> {
    await this.emit('TRACK_LIKE', { artist: track.artist }, track.id, track.artistId, surface);
  }

  async unliked(track: { id: string; artist: string }): Promise<void> {
    await this.emit('TRACK_UNLIKE', { artist: track.artist }, track.id);
  }

  async downloaded(track: { id: string; artist: string }): Promise<void> {
    await this.emit('TRACK_DOWNLOAD', { artist: track.artist }, track.id);
  }

  async queueAdded(track: { id: string; artist: string }, targetSurface: SourceSurface): Promise<void> {
    await this.emit('QUEUE_ADD_MANUAL', { targetSurface, artist: track.artist }, track.id);
  }

  async queueRemoved(trackId: string, wasRecommended: boolean): Promise<void> {
    await this.emit('QUEUE_REMOVE', { wasRecommended }, trackId);
  }

  /** A recommended track entered the visible queue (§5.1 — survivorship-safe metrics). */
  async recExposed(trackId: string, surface: SourceSurface, rankInPool: number, exploration: boolean): Promise<void> {
    await this.emit('REC_EXPOSURE', { rankInPool, exploration }, trackId, undefined, surface);
  }

  async searchQueried(query: string, resultCount: number): Promise<void> {
    await this.emit('SEARCH_QUERY', { query, resultCount });
  }

  /** SEARCH V2 (§5.6): correlated query event — joins to SEARCH_CLICK. */
  async searchQueriedV2(p: {
    query: string;
    normalized: string;
    resultCount: number;
    planKind: string;
    probes: string[];
    latencyMs: number;
    corrections: Array<{ from: string; to: string }>;
    correlationId: string;
  }): Promise<void> {
    await this.emit('SEARCH_QUERY', { ...p, v: 2 });
  }

  async searchClicked(trackId: string, rankInResults: number): Promise<void> {
    await this.emit('SEARCH_CLICK', { rankInResults }, trackId);
  }

  /** SEARCH V2 (§5.6): correlated click — the learning join key. */
  async searchClickedV2(p: {
    trackId: string;
    rankInResults: number;
    query: string;
    normalizedQuery: string;
    correlationId: string;
    lyricVerified?: boolean;
  }): Promise<void> {
    await this.emit(
      'SEARCH_CLICK',
      { v: 2, rankInResults: p.rankInResults, query: p.query, normalizedQuery: p.normalizedQuery, correlationId: p.correlationId, lyricVerified: p.lyricVerified ?? false },
      p.trackId,
    );
  }

  async aiPlaylistSaved(playlistId: string, promptHash: string): Promise<void> {
    await this.emit('PLAYLIST_SAVE_AI', { promptHash }, playlistId);
  }

  async aiRegenerated(promptHash: string, variantIndex: number): Promise<void> {
    await this.emit('AI_REGENERATE', { promptHash, variantIndex });
  }

  async notForMe(trackId: string, surface: SourceSurface, reasonCode?: string): Promise<void> {
    await this.emit('NOT_FOR_ME', { surface, reasonCode }, trackId);
  }

  async stationEnded(tracksServed: number, avgListenRatio: number): Promise<void> {
    await this.emit('STATION_ENDED', { tracksServed, avgListenRatio });
  }

  // ── Read paths ─────────────────────────────────────────────────────────

  async getListens(days = 180): Promise<ListenRecord[]> {
    return this.store.getlistens(this.now() - days * 86400_000);
  }

  async getSessions(days = 180): Promise<SessionRecord[]> {
    return this.store.getSessions(this.now() - days * 86400_000);
  }

  async getEventsSince(sinceTs: number): Promise<LedgerEvent[]> {
    return this.store.getEvents(sinceTs);
  }

  get activeSessionId(): string {
    return this.sessionId;
  }

  get inFlightTrackId(): string | null {
    return this.current?.trackId ?? null;
  }

  get store_(): LedgerStore {
    return this.store;
  }

  // ── Write chain ────────────────────────────────────────────────────────

  private emit(
    type: LedgerEvent['type'],
    payload: Record<string, unknown>,
    trackId?: string,
    artistId?: string,
    surface?: SourceSurface,
  ): Promise<void> {
    const run = this.writeChain.then(async () => {
      const ts = this.now();
      const event: LedgerEvent = {
        id: nextId(ts),
        ts,
        type,
        sessionId: this.sessionId || 'boot',
        trackId,
        artistId,
        surface,
        payload,
      };
      this.eventsSinceStart++;
      await this.store.appendEvents([event]);
    });
    this.writeChain = run.catch(() => undefined);
    return run;
  }
}

// ── Grading helpers (pure — unit-tested) ────────────────────────────────

export function gradeFor(
  _userInitiated: boolean,
  listenedMs: number,
  _durationMs: number,
  ratio: number,
): ListenRecord['grade'] {
  if (ratio >= SKIP_THRESHOLDS.completedRatio) return 'COMPLETED';
  const seconds = listenedMs / 1000;
  if (seconds < SKIP_THRESHOLDS.instantSeconds) return 'INSTANT_REJECT';
  if (seconds < SKIP_THRESHOLDS.earlySeconds) return 'EARLY_SKIP';
  if (ratio < SKIP_THRESHOLDS.lateRatio) return 'MID_SKIP';
  return 'LATE_SKIP';
}

/** Decile 1..10 where the listen stopped (skip-position histogram §5.2). */
export function skipBucketOf(ratio: number): number {
  return Math.max(1, Math.min(10, Math.ceil(ratio * 10)));
}

/** Index of the last TRACK_START that never got a closing event. */
function findLastUnclosedStart(events: LedgerEvent[]): number | null {
  let lastStart: number | null = null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === 'TRACK_START') lastStart = i;
    else if ((e.type === 'TRACK_SKIP' || e.type === 'TRACK_END') && lastStart != null) {
      const closedId = events[lastStart].trackId;
      if (closedId === e.trackId) lastStart = null;
    }
  }
  return lastStart;
}
