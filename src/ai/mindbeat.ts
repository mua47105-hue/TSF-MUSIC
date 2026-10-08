/**
 * MINDBEAT facade — the app's single intelligence entry point.
 *
 * init() is performance-shaped (§10.3): the store opens fast, the profile
 * build is deferred off the first render, surfaces get skeletons meanwhile.
 * Every player/screen hook routes through here; nothing outside src/ai
 * touches the ledger directly.
 */

import { Platform } from 'react-native';
import { EventLedger } from './core/ledger';
import { buildProfile, emptyProfile, topArtists } from './core/profile';
import { createLedgerStore } from './core/storeSqlite'; // web → storeMemory via metro redirect
import { SessionBrain } from './core/session';
import { estimateFeatures, calibrate, setLyricDeltaProvider } from './core/features';
import { loadFeatureTable, lookupBakedFeatures } from './core/featureTable';
import { Bandit } from './core/bandit';
import { moodToValenceDelta, scoreLyrics } from './core/lyricMood';
import { rankSoundAlike, tagVectorOf, type TagVector } from './core/similarity';
import { recordingKeyOf } from './core/bakedKeys';
import { TASTE_DNA, FOCUS, LYRIC_MOOD, SEARCH_VIBE, SIMILARITY, SMART_FOLDERS, HISTORY, RADAR, MOOD_JOURNEY, DECADE_RADIO, SESSION_MEMORY } from './core/constants';
import type { ListenRecord, ReasonCode, SessionRecord, SourceSurface, TasteProfile, TrackFeatures } from './core/types';
import type { PlayCountEntry, Track, WeeklyCrate } from '../types';
import { createPlaylist, getFavorites, getPlayCounts, getRecents, getSmartShuffleSetting, getWeeklyCrateCache, setWeeklyCrateCache, backfillFavoriteGenre } from '../storage/store';
import { buildRadioV2 } from './surfaces/radio';
import { buildShuffleRecs } from './surfaces/shuffle';
import { buildDailyMixesV2, shouldRefreshMixes, type DailyMixV2 } from './surfaces/mixes';
import { buildWeeklyCrate, weekKeyOf } from './surfaces/weekly';
import { buildNowSound, type NowSoundCard } from './surfaces/daylist';
import { buildOnTheRise, type OnTheRiseCard } from './surfaces/ontherise';
import { buildSmartFolders, type SmartFolders } from './smartFolders';
import { buildFocusArtistPool, isMutedRow } from './focusPicks';
import { buildTasteDna, computeBlend, decodeTasteDna, encodeTasteDna, type TasteBlend } from './tasteDna';
import { buildWrapped, type WrappedSummary } from './wrapped';
import { reasonLine } from './core/decision';
import { computeRadarAxes, type RadarAxes } from './radar';
import { pickThisDay, type HistoricalDay } from './core/historical';
import { planMoodPath, assignSlots, type MoodPoint, type MoodSlot } from './moodJourney';
import { decadeQuery, inDecade } from './decadeRadio';
import { mixResumeSession } from './sessionMemory';
import { searchSaavnClean, getArtistTracks } from '../api/saavn';
import { filterClean } from '../safety';
import { reconcileRecordings, recordingKey } from '../api/recording';

const CATALOG = {
  search: (q: string, limit = 20) => searchSaavnClean(q, limit),
  artistTracks: (a: string, limit = 14) => getArtistTracks(a, limit),
  trending: async () => [] as Track[],
};

type ProfileListener = (p: TasteProfile) => void;

class Mindbeat {
  ledger: EventLedger | null = null;
  brain: SessionBrain | null = null;
  profile: TasteProfile = emptyProfile(0);
  private store: Awaited<ReturnType<typeof createLedgerStore>> | null = null;
  private listeners = new Set<ProfileListener>();
  private initPromise: Promise<void> | null = null;
  private mixesCache: { at: number; mixes: DailyMixV2[]; yesterdayIds: Set<string>; sessionsAtBuild: number } | null = null;
  /** Session mirror of this week's crate — survives a storage write failure. */
  private weeklyMem: WeeklyCrate | null = null;
  private nowSoundCache: { at: number; card: NowSoundCard | null } | null = null;
  private riseCache: { at: number; card: OnTheRiseCard | null } | null = null;
  private sessionCountAtBoot = 0;
  private disabled = false;
  /** Phase 3 — the bandit (constructed cheap; hydrated POST-first-frame). */
  readonly bandit: Bandit = new Bandit({
    get: <T,>(key: string) => this.kvGet<T>(key),
    set: <T,>(key: string, value: T) => this.kvSet<T>(key, value),
  });
  /** Phase 2/5 lazy-warm state. */
  private warmStarted = false;
  private warmDone: Promise<void> | null = null;
  /** Tier-3 behavioral observations: trackId → recent (energy, completion). */
  private observations = new Map<string, Array<{ energy: number; completion: number }>>();
  /** Phase 5 — lyric mood deltas (recordingKey → ±0.25), kv-backed LRU. */
  private lyricDeltas = new Map<string, number>();
  private lyricDeltasLoaded = false;
  /** Phase 6 — sound-alike cache (same stability class as On The Rise). */
  private alikeCache: { at: number; seedKey: string; tracks: Track[] } | null = null;

  /** Boot: open store, recover, start session. Profile builds async after. */
  init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      try {
        this.store = await createLedgerStore();
        this.ledger = new EventLedger(this.store);
        await this.ledger.init();
        await this.ledger.onAppActive();
        this.brain = new SessionBrain(Date.now(), this.ledger.activeSessionId || 's-live');
        // Kill switch must survive restarts (§10.4).
        this.disabled = (await this.kvGet<boolean>('intelligenceDisabled')) === true;
        // Instant profile from the snapshot while the full rebuild runs behind
        // it (cold-start budget <80ms, §10.3).
        const snapshot = await this.kvGet<TasteProfile>('profileSnapshot');
        if (snapshot && snapshot.builtAt) this.profile = snapshot;
        this.listeners.forEach((fn) => fn(this.profile));
        void this.rebuildProfile();
      } catch {
        // Intelligence layer must never block the app (fallback ladder §10.4).
        this.ledger = null;
      }
    })();
    return this.initPromise;
  }

  /** Await boot readiness (idempotent) — surfaces call this first. */
  ready(): Promise<void> {
    return this.initPromise ?? Promise.resolve();
  }

  /**
   * THE LAZY WARM (v4.2.0 law ⑦): everything heavy — the baked feature
   * table (7MB JSON parse), the bandit hydration, the lyric-delta cache —
   * happens HERE, after first paint, NEVER inside init(). Cold-start
   * budget untouched. Safe to call multiple times.
   */
  warmHeavyTables(): Promise<void> {
    if (this.warmDone) return this.warmDone;
    if (!this.warmStarted) {
      this.warmStarted = true;
      setTimeout(() => void this.warmInner(), 300); // after first paint
    }
    return this.warmDone ?? Promise.resolve();
  }

  private async warmInner(): Promise<void> {
    const run = (async () => {
      // 1. the baked knowledge table (the parse-once → Map → release path)
      await loadFeatureTable();
      // 2. the bandit arms (kv read + eviction)
      await this.bandit.hydrate();
      // 3. the lyric-delta cache + its estimator provider
      await this.hydrateLyricDeltas();
      setLyricDeltaProvider((key) => this.lyricDeltas.get(key));
      // 4. tier-3 observation feed for behavioral calibration
      this.rebuildObservations();
    })();
    this.warmDone = run;
    try {
      await run;
    } catch {
      /* the warm path never blocks the app */
    }
    return run;
  }

  /** Bounded per-track observation summaries from the last rebuild. */
  private rebuildObservations(): void {
    const next = new Map<string, Array<{ energy: number; completion: number }>>();
    void this.ledger
      ?.getListens(90)
      .then((listens) => {
        for (const l of listens) {
          const arr = next.get(l.trackId) ?? [];
          if (arr.length < 8) arr.push({ energy: l.energy, completion: l.completionRatio });
          next.set(l.trackId, arr);
        }
        if (next.size > 5000) {
          // Potato rule ⑧: trim to the 5000 most recent tracks.
          const keep = [...next.entries()].slice(-5000);
          next.clear();
          for (const [k, v] of keep) next.set(k, v);
        }
        this.observations = next;
      })
      .catch(() => undefined);
  }

  // ── Phase 5 — the lyric mood cache (kv LRU 1000 by recordingKey) ────

  private async hydrateLyricDeltas(): Promise<void> {
    if (this.lyricDeltasLoaded) return;
    this.lyricDeltasLoaded = true;
    try {
      const stored = await this.kvGet<Record<string, number>>('lyricMoodCache');
      if (stored) {
        for (const [k, v] of Object.entries(stored)) {
          if (typeof v === 'number') this.lyricDeltas.set(k, v);
        }
      }
    } catch {
      /* cache is an optimization */
    }
  }

  /**
   * The player lyric path calls this AFTER a fetch completes (off the
   * critical path): score the words, cache the bounded delta. Fire-and-
   * forget; failures are silent (the estimator just never sees a delta).
   */
  async noteLyricsFetched(track: { title: string; artist: string }, lyricsText: string): Promise<void> {
    try {
      const key = recordingKeyOf(track.title, track.artist.split(/,|&/)[0].trim());
      if (!key || !lyricsText) return;
      const delta = moodToValenceDelta(scoreLyrics(lyricsText));
      if (delta == null) return;
      // TRUE LRU: re-inserting moves the key to the tail of the Map's
      // insertion order (touch-on-write — reads are plain gets and do not
      // refresh); eviction drops the head.
      this.lyricDeltas.delete(key);
      this.lyricDeltas.set(key, delta);
      if (this.lyricDeltas.size > LYRIC_MOOD.cacheCap) {
        const excess = this.lyricDeltas.size - LYRIC_MOOD.cacheCap;
        const oldest = [...this.lyricDeltas.keys()].slice(0, excess);
        for (const k of oldest) this.lyricDeltas.delete(k);
      }
      // kv persistence is a full rewrite of the capped map (≤1000 floats
      // ≈ 30KB, once per lyric FETCH — not per frame); the kv tech has no
      // partial-write API, so this is the honest cost.
      const out: Record<string, number> = {};
      for (const [k, v] of this.lyricDeltas) out[k] = Math.round(v * 1000) / 1000;
      await this.kvSet('lyricMoodCache', out);
    } catch {
      /* best-effort */
    }
  }

  private rebuildChain: Promise<TasteProfile> = Promise.resolve(emptyProfile(0));
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;

  /** Debounced rebuild — rapid likes fire ONE rebuild, not three. */
  scheduleRebuild(delayMs = 1500): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      void this.rebuildProfile();
    }, delayMs);
  }

  /** Full profile rebuild from the ledger (serialized; callers may debounce). */
  async rebuildProfile(): Promise<TasteProfile> {
    const run = this.rebuildChain.then(() => this.rebuildProfileInner());
    this.rebuildChain = run.catch(() => this.profile);
    return run;
  }

  private async rebuildProfileInner(): Promise<TasteProfile> {
    if (!this.ledger) return this.profile;
    try {
      const t0 = Date.now();
      const [listens, sessions, events] = await Promise.all([
        this.ledger.getListens(180),
        this.ledger.getSessions(180),
        this.ledger.getEventsSince(Date.now() - 180 * 86400_000),
      ]);
      const favorites = await getFavorites().catch(() => [] as Track[]);
      const seeds = (await this.kvGet<string[]>('onboardingSeeds')) ?? [];
      const seedTs = (await this.kvGet<number>('onboardingSeedTs')) ?? Date.now();
      const seedGenres = (await this.kvGet<string[]>('onboardingGenres')) ?? [];
      const priorCorrections = this.profile?.corrections;
      const profile = buildProfile(listens, events, sessions, {
        now: Date.now(),
        onboardingSeeds: seeds,
        onboardingGenres: seedGenres,
        onboardingSeedTs: seedTs,
        corrections: priorCorrections,
      });
      // Liked songs are heart-tier evidence even before a TRACK_LIKE event lands.
      for (const f of favorites.slice(0, 200)) {
        const key = f.artist.trim().toLowerCase();
        if (key && profile.artists[key]?.source !== 'heart') {
          profile.artists[key] = profile.artists[key] ?? {
            w: 2.5,
            lastEventTs: Date.now(),
            evidenceCount: 1,
            source: 'heart',
          };
          if (!profile.artists[key]) continue;
          profile.artists[key]!.w = Math.max(profile.artists[key]!.w, 2.5);
          profile.artists[key]!.source = 'heart';
        }
      }
      this.profile = profile;
      this.sessionCountAtBoot = sessions.length;
      await this.kvSet('profileSnapshot', profile);
      this.listeners.forEach((fn) => fn(profile));
      void t0;
    } catch {
      /* keep last good profile */
    }
    return this.profile;
  }

  onProfile(fn: ProfileListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ── Player instrumentation (called by PlayerProvider / service) ──────

  async trackStarted(track: Track, surface: SourceSurface): Promise<void> {
    if (!this.ledger || this.disabled) return;
    // Tier-0..2 estimate, then tier-3 behavioral calibration on top
    // (bounded ±0.05 for dataset/lyric sources — BAR 2.2 lives in calibrate).
    let feats = estimateFeatures({ artist: track.artist, title: track.title, album: track.album });
    const obs = this.observations.get(track.id);
    if (obs?.length) feats = calibrate(feats, obs);
    await this.ledger.trackStarted(
      {
        trackId: track.id,
        artist: track.artist,
        artistId: track.artistId,
        title: track.title,
        language: track.language,
        genre: track.genre,
        year: track.year,
        durationMs: (track.duration || 210) * 1000,
        energy: feats.energy,
        valence: feats.valence,
        wasRecommended: !!track.isRecommended,
        reasonCode: track.reasonCode as ReasonCode | undefined,
        explorationSlot: !!track.exploration,
      },
      surface,
    );
    if (track.isRecommended) {
      await this.ledger.recExposed(track.id, surface, 0, !!track.exploration);
    }
    // Phase 1 — lazy genre backfill: an old favorite row without a genre
    // gets one the first time the track plays with a provider tag.
    if (track.genre) {
      void backfillFavoriteGenre(track.id, track.genre).catch(() => undefined);
    }
  }

  async heartbeat(elapsedMs: number): Promise<void> {
    await this.ledger?.heartbeat(elapsedMs);
  }

  async seek(fromMs: number, toMs: number): Promise<void> {
    await this.ledger?.seek(fromMs, toMs);
  }

  markPendingSkip(): void {
    this.ledger?.markPendingSkip();
  }

  /** Finalize + fold the listen into the session brain (skip storms etc.)
   *  + feed the bandit arm (Phase 3, single-owner finalization unchanged). */
  async trackFinished(userInitiated: boolean, cause: 'skip' | 'end' | 'jump' | 'background' = 'end'): Promise<void> {
    if (!this.ledger) return;
    const record = await this.ledger.finalizeTrack(userInitiated, cause);
    if (record && this.brain) this.brain.push(record);
    if (record) {
      this.bandit.observe(record);
      void this.bandit.scheduleFlush().catch(() => undefined);
      // Feed the tier-3 observation map (bounded per track).
      const arr = this.observations.get(record.trackId) ?? [];
      if (arr.length >= 8) arr.shift();
      arr.push({ energy: record.energy, completion: record.completionRatio });
      this.observations.set(record.trackId, arr);
    }
  }

  async appBackground(): Promise<void> {
    // The in-flight listen is NOT finalized here — audio typically keeps
    // playing in the background and the service keeps feeding heartbeats;
    // crash recovery covers the killed-mid-track case (§5.5).
    await this.ledger?.onAppBackground();
  }

  async appActive(): Promise<void> {
    await this.ledger?.onAppActive();
  }

  async liked(track: Track, surface: SourceSurface): Promise<void> {
    await this.ledger?.liked(track, surface);
    this.scheduleRebuild();
  }

  async unliked(track: Track): Promise<void> {
    await this.ledger?.unliked(track);
    this.scheduleRebuild();
  }

  async queueAdded(track: Track, surface: SourceSurface): Promise<void> {
    await this.ledger?.queueAdded(track, surface);
  }

  async queueRemoved(trackId: string, wasRecommended: boolean): Promise<void> {
    await this.ledger?.queueRemoved(trackId, wasRecommended);
  }

  async searchQueried(query: string, resultCount: number): Promise<void> {
    await this.ledger?.searchQueried(query, resultCount);
  }

  async searchClicked(trackId: string, rank: number): Promise<void> {
    await this.ledger?.searchClicked(trackId, rank);
  }

  /** SEARCH V2 (§5.6) — correlated, joinable search evidence.
   *  Kill-switch honored (§5.6: intelligenceDisabled pauses S5 writes). */
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
    if (!this.ledger || this.disabled) return;
    await this.ledger.searchQueriedV2(p);
  }

  async searchClickedV2(p: {
    trackId: string;
    rankInResults: number;
    query: string;
    normalizedQuery: string;
    correlationId: string;
    lyricVerified?: boolean;
  }): Promise<void> {
    if (!this.ledger || this.disabled) return;
    await this.ledger.searchClickedV2(p);
  }

  /** Raw-event reader for the search learning loop (S5). */
  async eventsSince(ts: number): Promise<
    Array<{ type: string; ts: number; trackId?: string; payload: Record<string, unknown> }>
  > {
    if (!this.ledger) return [];
    try {
      return await this.ledger.getEventsSince(ts);
    } catch {
      return [];
    }
  }

  /** Sync kill-switch read for the search engine deps (S5). */
  recsDisabled(): boolean {
    return this.disabled;
  }

  /** Ledger passthrough for the background service. */
  get ledgerApi(): EventLedger | null {
    return this.ledger;
  }

  async notForMe(track: Track, surface: SourceSurface): Promise<void> {
    await this.ledger?.notForMe(track.id, surface, track.reasonCode);
    // Explicit negative blocks immediately (§5.2).
    this.profile.corrections.mutedTracks.push(track.id);
    void this.rebuildProfile();
  }

  /** Taste DNA actions (§6.6): boost ×2, mute, un-mute. */
  async boostArtist(artist: string): Promise<void> {
    const key = artist.trim().toLowerCase();
    this.profile.corrections.boosts[key] = 2;
    await this.persistCorrections();
  }

  async muteArtist(artist: string): Promise<void> {
    const key = artist.trim().toLowerCase();
    if (!this.profile.corrections.mutedArtists.includes(key)) {
      this.profile.corrections.mutedArtists.push(key);
    }
    await this.persistCorrections();
  }

  async unmuteArtist(artist: string): Promise<void> {
    const key = artist.trim().toLowerCase();
    this.profile.corrections.mutedArtists = this.profile.corrections.mutedArtists.filter((a) => a !== key);
    await this.persistCorrections();
  }

  private async persistCorrections(): Promise<void> {
    await this.kvSet('corrections', this.profile.corrections);
    this.listeners.forEach((fn) => fn(this.profile));
  }

  async setOnboardingSeeds(artists: string[], genres: string[] = []): Promise<void> {
    await this.kvSet('onboardingSeeds', artists);
    await this.kvSet('onboardingGenres', genres);
    await this.kvSet('onboardingSeedTs', Date.now());
    // BAR 3.3 — cold-start bandit seeding: chosen artists get a trusted
    // arm (α=3, β=1) so Day-1 Smart Shuffle/Radio surface them instead
    // of burying them under uniform exploration.
    for (const a of artists) this.bandit.seedArtist(a);
    void this.bandit.scheduleFlush().catch(() => undefined);
    await this.rebuildProfile();
  }

  /** Kill switch: disable all recommendations (classic-only, §10.4). */
  async setDisabled(off: boolean): Promise<void> {
    this.disabled = off;
    await this.kvSet('intelligenceDisabled', off);
    // A dead intelligence layer never writes after death: pending bandit
    // arm updates + debounce timers die with the switch (ported from the
    // parallel gauntlet line's round-1 critic fix).
    if (off) this.bandit.cancelPendingWrites();
  }

  async isDisabled(): Promise<boolean> {
    if (this.disabled) return true;
    const v = await this.kvGet<boolean>('intelligenceDisabled');
    this.disabled = v === true;
    return this.disabled;
  }

  /** Reset the whole taste model (one button, §6.6). */
  async resetProfile(): Promise<void> {
    await this.kvSet('onboardingSeeds', []);
    await this.kvSet('onboardingGenres', []);
    await this.kvSet('onboardingSeedTs', Date.now());
    await this.kvSet('corrections', { mutedArtists: [], mutedTracks: [], boosts: {}, wrongLabels: [] });
    this.profile = emptyProfile(Date.now());
    try {
      await this.store?.deleteEventsBefore(Date.now());
      await this.store?.deleteListensBefore(Date.now());
    } catch {
      /* best-effort */
    }
    // Sessions + surface caches reset too — nothing pre-reset survives.
    try {
      const sessions = await this.store?.getSessions() ?? [];
      for (const s of sessions) {
        await this.store?.upsertSession({ ...s, trackCount: 0, totalListenMs: 0, endTs: s.startTs });
      }
    } catch {
      /* best-effort */
    }
    this.mixesCache = null;
    this.nowSoundCache = null;
    this.riseCache = null;
    this.brain = new SessionBrain(Date.now());
    this.listeners.forEach((fn) => fn(this.profile));
  }

  /** Export: full profile + ledger as JSON (the user's data, literally). */
  async exportJSON(): Promise<string> {
    const listens = this.ledger ? await this.ledger.getListens(180) : [];
    const sessions = this.ledger ? await this.ledger.getSessions(180) : [];
    return JSON.stringify({ profile: this.profile, listens, sessions, exportedAt: new Date().toISOString() }, null, 2);
  }

  // ── Surface queries (all degrade gracefully, §10.4) ──────────────────

  private surfaceCtx() {
    return {
      api: CATALOG,
      profile: this.profile,
      session: this.brain?.state ?? new SessionBrain(Date.now()).state,
      now: Date.now(),
      listens: [] as ListenRecord[],
      banditArms: this.bandit.snapshot(),
      onExposure: (trackId: string, surface: SourceSurface, rank: number, exploration: boolean) => {
        void this.ledger?.recExposed(trackId, surface, rank, exploration);
      },
    };
  }

  async radio(seed: Track, count = 12) {
    await this.ready();
    if (this.disabled || !this.ledger) return [];
    const ctx = this.surfaceCtx();
    ctx.listens = await this.ledger.getListens(7);
    try {
      return await buildRadioV2(ctx, seed, count);
    } catch {
      return [];
    }
  }

  async shuffleRecs(upcoming: Track[], healFrom?: Track | null) {
    await this.ready();
    if (this.disabled || !this.ledger) return [];
    const ctx = this.surfaceCtx();
    ctx.listens = await this.ledger.getListens(7);
    try {
      return await buildShuffleRecs(ctx, upcoming, { healFrom: healFrom ?? null });
    } catch {
      return [];
    }
  }

  /**
   * VIBE SHIFT (Task 28 · the felt-intelligence surface). The session brain
   * already tracks where the listener's energy is heading; this lets the
   * player SAY so and act on it: reads the session energy and queues 3 tracks
   * that pull the mood the other way (up when the session is low/flat, down
   * when it's peaking or winding down). Picks come ONLY from the user's own
   * affinity pools (seed artist + top profile artists) scored through the
   * proxy feature space — no social proof, nothing fabricated. Empty array =
   * not enough evidence yet; the chip shows the honest cold-start line.
   */
  async vibeShift(seed: Track | null, excludeIds: Set<string>): Promise<Track[]> {
    await this.ready();
    if (this.disabled || !this.ledger) return [];
    const energy = this.brain?.sessionEnergy ?? 0.5;
    const up = energy < 0.5; // low session → inject energy; high session → calm it
    const [lo, hi] = up ? [0.6, 0.98] : [0.08, 0.45];

    const artists: string[] = [];
    const pushArtist = (a?: string) => {
      const name = (a ?? '').split(/,|&/)[0].trim();
      if (name && !artists.some((x) => x.toLowerCase() === name.toLowerCase())) artists.push(name);
    };
    pushArtist(seed?.artist);
    for (const { artist } of topArtists(this.profile, Date.now(), 4)) pushArtist(artist);

    const out: Track[] = [];
    for (const a of artists) {
      if (out.length >= 3) break;
      let rows: Track[] = [];
      try {
        rows = await CATALOG.artistTracks(a, 14);
      } catch {
        rows = [];
      }
      for (const t of rows) {
        if (out.length >= 3) break;
        if (excludeIds.has(t.id) || out.some((x) => x.id === t.id)) continue;
        const f = estimateFeatures({ artist: t.artist, title: t.title, album: t.album });
        if (f.energy < lo || f.energy > hi) continue;
        out.push({ ...t, isRecommended: true });
      }
    }
    // Fallback ladder: affinity pool too narrow → seed-artist deep cuts only,
    // still flagged + explained (never silent-empty when the catalog has rows).
    if (!out.length && seed?.artist) {
      try {
        const rows = await CATALOG.artistTracks(seed.artist.split(/,|&/)[0].trim(), 6);
        for (const t of rows) {
          if (excludeIds.has(t.id) || out.some((x) => x.id === t.id)) continue;
          out.push({ ...t, isRecommended: true });
          if (out.length >= 3) break;
        }
      } catch {
        /* honest empty */
      }
    }
    // Phase 6 — the new BOTTOM rung: sound-alike from the seed. When the
    // affinity pools are all dry, the tag-overlap engine still finds the
    // neighborhood of what's playing (kill switch + honesty preserved).
    if (!out.length && seed) {
      try {
        const rows = await this.soundAlike(seed, 3);
        for (const t of rows) {
          if (excludeIds.has(t.id) || out.some((x) => x.id === t.id)) continue;
          out.push(t);
          if (out.length >= 3) break;
        }
      } catch {
        /* honest empty */
      }
    }
    return out;
  }

  /**
   * THE TEN F4 — the smart auto-playlists (live query folders). A factual
   * view of the listener's OWN data (not a recommendation), so the kill
   * switch does not gate it — same posture as stats(). Returns NULL when
   * the ledger is unavailable (an UNAVAILABLE crate — distinct from the
   * honest empty arrays a healthy ledger can legitimately produce).
   */
  async smartFolders(): Promise<SmartFolders | null> {
    await this.ready();
    try {
      const [listens, favorites, playCounts, recents] = await Promise.all([
        this.ledger ? this.ledger.getListens(SMART_FOLDERS.graveyardWindowDays) : Promise.resolve([]),
        getFavorites(),
        getPlayCounts(),
        getRecents(),
      ]);
      return buildSmartFolders({ listens, favorites, playCounts, recents, now: Date.now() });
    } catch {
      return null; // the UI renders an honest unavailable row
    }
  }

  /**
   * THE TEN F10 — the FOCUS playlist: low-energy picks for study
   * sessions, sourced ONLY from the listener's own affinity pool (the
   * seed's artist + profile top artists) and gated by the BAKED energy
   * ceiling (FOCUS.maxEnergy). A track with NO baked row is NOT
   * smuggled in — we cannot honestly claim it is calm. When the pool
   * is dry the vibe-search ladder runs. filterClean + reconcile
   * (law ⑨); kill switch honored (this IS a recommendation surface).
   */
  async focusPicks(seed: Track | null): Promise<Track[]> {
    await this.ready();
    if (this.disabled || !this.ledger) return [];
    // THE PURE POOL (src/ai/focusPicks.ts): seed first, profile second,
    // MUTED ARTISTS REMOVED — the mute list is honored end to end.
    const artists = buildFocusArtistPool({
      seedArtist: seed?.artist,
      topArtists: topArtists(this.profile, Date.now(), 6).map((a) => a.artist),
      mutedArtists: this.profile.corrections.mutedArtists,
    });
    const muted = this.profile.corrections.mutedArtists;
    const out: Track[] = [];
    const seen = new Set<string>();
    const pushCalm = (rows: Track[], requireBaked: boolean) => {
      for (const t of filterClean(reconcileRecordings(rows))) {
        if (out.length >= FOCUS.picksCount) break;
        if (isMutedRow(t.artist, muted)) continue; // a muted artist's rows never queue
        const key = recordingKey(t);
        if (seen.has(key) || out.some((x) => x.id === t.id)) continue;
        const f = lookupBakedFeatures({ title: t.title, artist: t.artist });
        if (f) {
          if (f.e > FOCUS.maxEnergy) continue; // a banger is never focus music
        } else if (requireBaked) {
          continue; // no baked evidence — never smuggled into the pool pass
        }
        seen.add(key);
        out.push(t);
      }
    };
    for (const a of artists) {
      if (out.length >= FOCUS.picksCount) break;
      try {
        pushCalm(await CATALOG.artistTracks(a, 10), true);
      } catch {
        /* keep filling below */
      }
    }
    // Vibe-search ladder: the affinity pool was too narrow for a session.
    if (!out.length) {
      try {
        pushCalm(await CATALOG.search('lofi focus study instrumental', FOCUS.picksCount), false);
      } catch {
        /* honest empty */
      }
    }
    return out.slice(0, FOCUS.picksCount);
  }

  /**
   * THE TEN F6 — the Local Rewind (Wrapped-grade, on-device). NULL when
   * the listener honestly hasn't streamed enough — the UI says so,
   * never zeros dressed up as stats.
   */
  async wrapped(rangeDays = 30): Promise<WrappedSummary | null> {
    await this.ready();
    // NULL = honest "not enough listening yet". Ledger failures THROW so
    // the UI can say "unavailable" — the two are never conflated.
    if (!this.ledger) throw new Error('ledger unavailable');
    const listens = await this.ledger.getListens(Math.max(rangeDays, 0) + 1);
    return buildWrapped(listens, rangeDays, Date.now());
  }

  /**
   * MAGNUM OPUS F9 — TIME MACHINE ("This Day Last Year"). Reads the
   * historical_summary table (the compaction pass's own aggregate —
   * NEVER a scan of the raw ledger). NULL = honest cold state ("Not
   * enough history yet") when no prior-year summary exists for this
   * local month-day. Factual user data — the kill switch does not gate
   * it (same posture as stats()/smartFolders()).
   */
  async thisDayLastYear(now: number = Date.now()): Promise<HistoricalDay | null> {
    await this.ready();
    if (!this.ledger) return null;
    try {
      const store = this.ledger.store_;
      if (!store.getHistoricalDays) return null; // pre-F9 store — honest null
      const since = now - HISTORY.lookbackYears * HISTORY.daysPerLookbackYear * 86400_000;
      const rows = await store.getHistoricalDays(since);
      return pickThisDay(rows, now);
    } catch {
      return null;
    }
  }

  /**
   * MAGNUM OPUS F8 — the Taste Radar's six axes, computed from the
   * listener's OWN graded listens (30-second rule applied). NULL when
   * the ledger is unavailable; zero axes when nothing has streamed —
   * the UI renders the honest cold caption either way.
   */
  async radarAxes(): Promise<RadarAxes | null> {
    await this.ready();
    if (!this.ledger) return null;
    try {
      const listens = await this.ledger.getListens(RADAR.windowDays);
      return computeRadarAxes(this.profile, listens, Date.now());
    } catch {
      return null;
    }
  }

  /**
   * MAGNUM OPUS F10/F11 — the track's proxy features (energy/valence/
   * tempoClass) for the haptic beat-tick and the pseudo-visualizer.
   * A SYNC passthrough to the pure estimator (tier-0..2, no ledger,
   * no cold-start impact — the player calls it after paint). The UI
   * never imports src/ai/core directly (law ②): this facade is the
   * only door.
   */
  featuresForTrack(track: { artist: string; title: string; album?: string }): TrackFeatures {
    return estimateFeatures({ artist: track.artist, title: track.title, album: track.album });
  }

  /**
   * MAGNUM OPUS F14 — MOOD JOURNEY. `count` slots drifting from `from`
   * to `to` (each step bounded to MOOD_JOURNEY.maxStep), candidates
   * sourced through the injected CatalogApi and matched to the path in
   * the proxy feature space. Kill switch → silent []. A slot the
   * catalog cannot fill is SKIPPED (the result simply has fewer rows
   * — honest absence, never fabricated). reconcileRecordings runs at
   * the merge point (house rule ⑥).
   */
  async moodJourney(
    from: MoodPoint,
    to: MoodPoint,
    count: number = MOOD_JOURNEY.defaultCount,
  ): Promise<{ tracks: Track[]; plan: MoodSlot[]; skippedSlots: number[] }> {
    await this.ready();
    if (this.disabled) return { tracks: [], plan: [], skippedSlots: [] }; // kill switch, silent
    const plan = planMoodPath(from, to, count);
    if (!plan.length) return { tracks: [], plan: [], skippedSlots: [] };

    // candidates: the listener's own affinity pool first (top artists),
    // deepened by the seed artist when the profile is young
    const artists: string[] = [];
    const pushArtist = (a?: string) => {
      const name = (a ?? '').split(/,|&/)[0].trim();
      if (name && !artists.some((x) => x.toLowerCase() === name.toLowerCase())) artists.push(name);
    };
    for (const { artist } of topArtists(this.profile, Date.now(), MOOD_JOURNEY.artistPool)) pushArtist(artist);

    let candidates: Track[] = [];
    for (const a of artists) {
      if (candidates.length >= MOOD_JOURNEY.candidateCap) break;
      try {
        const rows = await CATALOG.artistTracks(a, MOOD_JOURNEY.rowsPerArtist);
        candidates = candidates.concat(rows);
      } catch {
        /* one artist failing never kills the journey */
      }
    }
    candidates = reconcileRecordings(candidates);
    candidates = filterClean(candidates);
    if (!candidates.length) return { tracks: [], plan, skippedSlots: plan.map((s) => s.slot) };

    const featureOf = (t: Track): MoodPoint => {
      const f = estimateFeatures({ artist: t.artist, title: t.title, album: t.album });
      return { energy: f.energy, valence: f.valence };
    };
    const { picks, skippedSlots } = assignSlots(plan, candidates, featureOf);
    return { tracks: picks.map(({ track }) => ({ ...track, isRecommended: true })), plan, skippedSlots };
  }

  /**
   * MAGNUM OPUS F15 — RESUME SESSION. The snapshot's seed spine (the
   * session's queued queue, ≥70% of the result — v5.0.1 FIX-A2: the
   * honest claim is "your session's spine", not "heard") plus at most
   * 30% fresh catalog rows matching the vibe. NULL = the snapshot is
   * gone (FIFO) or its seeds cannot be resolved — the honest cold
   * state, never a fabricated session.
   */
  async resumeSession(id: string): Promise<Track[] | null> {
    await this.ready();
    if (this.disabled) return null;
    let seeds: Track[] = [];
    try {
      // Metro rewrites a DIRECT `require('...')` call into the bundle
      // graph (and the webmock redirect swaps appTables for Maps on
      // web); the lab's bun resolves it natively — the same pattern
      // featureTable.ts established. Aliasing the identifier would
      // BYPASS Metro's rewrite and throw on device (the blind critic's
      // P0: the string would reach the runtime unconverted, the catch
      // would disguise it as the honest cold state, and resume would
      // be dead code behind a smiling toast).
      const mod = require('../storage/appTables') as typeof import('../storage/appTables');
      const tables = await mod.getAppTables();
      const snapshot = await tables.sessions.get(id);
      if (!snapshot?.seedTrackIds.length) return null;
      const want = new Set(snapshot.seedTrackIds);
      // resolve seeds against the app's OWN local catalog (recents +
      // playCounts + favorites) — no network needed for the spine
      const [recents, counts, favs] = await Promise.all([getRecents(), getPlayCounts(), getFavorites()]);
      const local = [...recents, ...Object.values(counts).map((c) => c.track).filter(Boolean), ...favs];
      seeds = local.filter((t, i) => want.has(t.id) && local.findIndex((x) => x.id === t.id) === i);
    } catch {
      return null;
    }
    if (seeds.length < 2) return null; // a snapshot that lost its spine is not a session

    // fresh rows matching the vibe: the snapshot's top artists' catalogs
    const vibeArtist = seeds[0]?.artist ?? '';
    let fresh: Track[] = [];
    try {
      fresh = await CATALOG.artistTracks(vibeArtist.split(/,|&/)[0].trim(), SESSION_MEMORY.rowsPerArtist);
    } catch {
      fresh = [];
    }
    fresh = filterClean(reconcileRecordings(fresh));
    const seedIds = new Set(seeds.map((t) => t.id));
    const { mix } = mixResumeSession(
      seeds,
      fresh.filter((t) => !seedIds.has(t.id)),
      SESSION_MEMORY.resumeCount,
    );
    return mix.map((t, i) => ({ ...t, isRecommended: i >= seeds.length }));
  }

  /**
   * MAGNUM OPUS F16 — DECADE RADIO. The deterministic ladder
   * (decadeQuery) walked through the injected CatalogApi; rows filtered
   * by their OWN year metadata where present; kill switch → silent [].
   * A thin year returns fewer rows honestly (the UI says THIN, it does
   * not pad with unrelated eras).
   */
  async decadeRadio(year: number, count: number = DECADE_RADIO.defaultCount): Promise<{ tracks: Track[]; thin: boolean; ladder: ReturnType<typeof decadeQuery> }> {
    await this.ready();
    const ladder = decadeQuery(year);
    if (this.disabled) return { tracks: [], thin: true, ladder }; // kill switch, silent
    const seen = new Set<string>();
    let out: Track[] = [];
    for (const rung of [ladder.exact, ladder.decade, ladder.genre]) {
      if (out.length >= count) break;
      let rows: Track[] = [];
      try {
        rows = await CATALOG.search(rung, DECADE_RADIO.rowsPerRung);
      } catch {
        rows = [];
      }
      rows = filterClean(reconcileRecordings(rows));
      for (const t of rows) {
        if (out.length >= count) break;
        if (seen.has(t.id)) continue;
        if (!inDecade(t, ladder.decadeStart)) continue;
        seen.add(t.id);
        out.push({ ...t, isRecommended: true });
      }
    }
    return { tracks: out, thin: out.length < DECADE_RADIO.thinCount, ladder };
  }

  /**
   * THE TEN F7 — the shareable Taste DNA code (aggregates only, never
   * raw ledger events). NULL when the DNA is too young to share
   * (TASTE_DNA.minArtistsForShare): sharing a 0-artist code would make
   * every "blend" a one-sided playlist pretending to be a meeting of
   * tastes — the UI says so instead.
   */
  async tasteDnaCode(): Promise<string | null> {
    await this.ready();
    const dna = buildTasteDna(this.profile);
    if (dna.artists.length < TASTE_DNA.minArtistsForShare) return null;
    return encodeTasteDna(dna);
  }

  /**
   * THE TEN F7 — build the Blend playlist from a friend's code. Returns
   * NULL when the code is corrupt/wrong-version (the UI shows an honest
   * toast — never a crash, never a fabricated blend). The playlist is
   * resolved from the SHARED + BRIDGE artists, safety-filtered and
   * reconciled (law ⑨), and saved as a normal local playlist.
   */
  async buildBlendPlaylist(
    friendCode: string,
  ): Promise<
    | { status: 'ok'; name: string; added: number; shared: number; bridge: number; partial: boolean }
    | { status: 'bad_code' }
    | { status: 'nothing_resolved' }
    | { status: 'failed' }
  > {
    const theirs = decodeTasteDna(friendCode);
    if (!theirs) return { status: 'bad_code' };
    const mine = buildTasteDna(this.profile);
    const blend: TasteBlend = computeBlend(mine, theirs);
    const artists = [...blend.shared.map((s) => s.n), ...blend.bridge.map((b) => b.n)];
    const out: Track[] = [];
    const seen = new Set<string>();
    const deadline = Date.now() + TASTE_DNA.resolveBudgetMs;
    let partial = false;
    for (const artist of artists) {
      if (out.length >= TASTE_DNA.blendTracks) break;
      if (out.length > 0 && Date.now() > deadline) {
        partial = true; // an honest partial blend ships; the clock never lies
        break;
      }
      const name = artist.split(/,|&/)[0].trim();
      if (!name) continue;
      let rows: Track[] = [];
      try {
        rows = await CATALOG.artistTracks(name, 6);
      } catch {
        rows = [];
      }
      for (const t of filterClean(reconcileRecordings(rows))) {
        const key = recordingKey(t);
        if (seen.has(key) || out.some((x) => x.id === t.id)) continue;
        seen.add(key);
        out.push(t);
        if (out.length >= TASTE_DNA.blendTracks) break;
      }
    }
    if (!out.length) return { status: 'nothing_resolved' }; // offline or catalog dry — honest
    try {
      // Each import is a distinct DATED edition — two friends' codes are
      // different blends, and re-importing the same friend on another day
      // re-resolves the catalog. Deliberate, documented stance.
      const edition = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const pl = await createPlaylist(`Taste DNA Blend · ${edition}`, out);
      return { status: 'ok', name: pl.name, added: out.length, shared: blend.shared.length, bridge: blend.bridge.length, partial };
    } catch {
      return { status: 'failed' }; // storage refused — never a silent nothing
    }
  }

  /** Session readout for the player chip (nulls = cold session, honest). */
  sessionReadout(): { vibe: string; energy: number; listens: number } {
    const state = this.brain?.state;
    return {
      vibe: state?.vibe ?? 'WARMUP',
      energy: this.brain?.sessionEnergy ?? 0,
      listens: state?.window.length ?? 0,
    };
  }

  /**
   * THE TEN F1 — the track's RAW baked energy for the playback path
   * (Smart Volume's loudness curve). null = no baked row ⇒ the caller
   * no-ops (multiplier 1.0, byte-identical to the pre-feature app).
   * Reads the same lazy table as the estimator — call after
   * warmHeavyTables(); an early call simply returns null and the next
   * track picks it up (an honest no-op, never a blocker).
   */
  bakedEnergyFor(track: { title?: string; artist?: string }): number | null {
    const hit = lookupBakedFeatures({ title: track.title, artist: track.artist });
    return hit ? hit.e : null;
  }

  // ── Phase 6 — SOUND ALIKE (the tag-overlap similarity engine) ────────

  /**
   * "Sounds like <seed>" — tracks sharing ≥2 tag dimensions (artist,
   * genre, language, era, mood) with the seed, ranked by weighted tag
   * overlap. Candidates come ONLY from the injected CatalogApi; the
   * merged pool passes reconcileRecordings() BEFORE ranking (house law
   * ⑨ / BAR 1.4 — one row per recording) and filterClean() (law ⑨).
   * Kill switch + 7-day cache respected; empty pool ⇒ honest [].
   */
  async soundAlike(seed: Track, count = 8): Promise<Track[]> {
    await this.ready();
    if (this.disabled || !this.ledger) return [];
    const now = Date.now();
    const seedKey = recordingKeyOf(seed.title, seed.artist.split(/,|&/)[0].trim()) || seed.id;
    if (
      !this.alikeCache ||
      this.alikeCache.seedKey !== seedKey ||
      now - this.alikeCache.at > SIMILARITY.cacheDays * 86400_000
    ) {
      const tracks = await this.buildSoundAlike(seed, seedKey, count);
      if (tracks.length) this.alikeCache = { at: now, seedKey, tracks };
      return tracks;
    }
    return this.alikeCache.tracks.slice(0, count);
  }

  private async buildSoundAlike(seed: Track, seedKey: string, count: number): Promise<Track[]> {
    // ── The bounded candidate pool (60–120, never the world) ──
    // Sourcing limits: 30 seed-artist + 4×16 neighborhood + 40 genre = 134
    // requested; after id-dedup the practical ceiling sits ~115 (the
    // neighborhood loop stops early at poolMin 60) — poolMax 120 is the
    // hard backstop, not the everyday shape.
    const pool: Track[] = [];
    const push = (t: Track) => {
      if (pool.length >= SIMILARITY.poolMax) return;
      if (t.id === seed.id || t.id === `saavn-${seed.saavnId ?? ''}`) return;
      if (pool.some((p) => p.id === t.id)) return;
      pool.push(t);
    };
    try {
      // The seed's artist — the strongest single pool.
      const seedArtist = seed.artist.split(/,|&/)[0].trim();
      if (seedArtist) {
        const rows = await CATALOG.artistTracks(seedArtist, 30);
        rows.forEach(push);
      }
    } catch {
      /* pool keeps filling below */
    }
    try {
      // Profile top artists — the taste neighborhood.
      for (const { artist } of topArtists(this.profile, Date.now(), 4)) {
        if (pool.length >= SIMILARITY.poolMin) break;
        const rows = await CATALOG.artistTracks(artist, 16);
        rows.forEach(push);
      }
    } catch {
      /* honest partial pool */
    }
    try {
      // Genre search — when the seed carries a provider genre (Phase 1).
      if (seed.genre && pool.length < SIMILARITY.poolMax) {
        const rows = await CATALOG.search(`${seed.genre} songs`, 40);
        rows.forEach(push);
      }
    } catch {
      /* honest partial pool */
    }
    if (!pool.length) return [];

    // Law ⑨ — safety + one row per recording BEFORE ranking (BAR 1.4).
    const clean = filterClean(reconcileRecordings(pool));
    // Dedup against the seed by recording key (covers cross-id clones).
    const seedTags: TagVector = tagVectorOf(seed);
    const candidates = clean
      .filter((t) => (recordingKeyOf(t.title, t.artist.split(/,|&/)[0].trim()) || t.id) !== seedKey)
      .map((track) => ({ track, tags: tagVectorOf(track) }));
    const picks = rankSoundAlike(seedTags, candidates, count);
    const seedArtist = seed.artist.split(/,|&/)[0].trim();
    return picks.map(({ track }) => ({
      ...track,
      isRecommended: true,
      reasonCode: 'SOUND_ALIKE',
      reason: reasonLine('SOUND_ALIKE', seedArtist),
    }));
  }

  // ── BAR 3.7 — THE DYNAMIC FEED (the feed that reads the room) ────────

  /**
   * Dynamic song queries for the endless home feed: read from the
   * profile's real genre/language affinities + the session vibe. Empty
   * yield (cold start, kill switch) ⇒ the pager falls back to the
   * legacy hardcoded ladder — byte-identical behavior.
   */
  feedSongQueries(): string[] {
    if (this.disabled) return [];
    const queries: string[] = [];
    const vibe = this.brain?.state?.vibe ?? 'WARMUP';
    const vibeWords: Record<string, string[]> = {
      WIND_DOWN: ['lofi', 'soft', 'melancholy', 'unplugged'],
      PEAK: ['party', 'workout', 'high energy'],
      FLOW: ['hits', 'vibes'],
      SKIP_STORM: ['calm', 'smooth'],
    };
    const moodWords = vibeWords[vibe] ?? [];
    // Real genre affinities only (the __mood keys are internal buckets —
    // they make terrible search queries and are excluded on purpose).
    const genres = Object.entries(this.profile.genres)
      .filter(([g, e]) => !g.startsWith('__') && e.w > 0.5)
      .sort((a, b) => b[1].w - a[1].w)
      .slice(0, 3)
      .map(([g]) => g);
    const langs = Object.entries(this.profile.languages)
      .sort((a, b) => b[1].w - a[1].w)
      .slice(0, 2)
      .map(([l]) => l);
    // The mind-reading combos: mood × genre × language.
    for (const g of genres) {
      if (moodWords.length) queries.push(`${moodWords[0]} ${g}`);
      queries.push(`${g} songs`);
    }
    for (const l of langs) {
      if (moodWords[1]) queries.push(`${moodWords[1]} ${l} songs`);
      queries.push(`${l} ${vibe === 'PEAK' ? 'party' : 'hits'}`);
    }
    // Honest dedup + cap — the pager walks this as a ladder.
    return [...new Set(queries.map((q) => q.replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 12);
  }

  // ── BAR 3.8 — SESSION-AWARE SEARCH RANKING (the vibe aligner) ───────

  /**
   * The search ranker's vibe context: the session's target energy and
   * the bonus ceiling. Null when the room gives no signal (WARMUP,
   * cold start) — the ranker then behaves exactly as before.
   */
  searchVibeContext(): { targetEnergy: number; maxBonus: number } | null {
    if (this.disabled) return null;
    const vibe = this.brain?.state?.vibe;
    if (!vibe) return null;
    const target = SEARCH_VIBE.targetEnergy[vibe];
    if (typeof target !== 'number') return null;
    return { targetEnergy: target, maxBonus: SEARCH_VIBE.maxBonus };
  }


  async dailyMixes(force = false): Promise<DailyMixV2[]> {
    await this.ready();
    if (this.disabled || !this.ledger) return [];
    const now = Date.now();
    const sessions = await this.ledger.getSessions(1);
    const cacheAt = this.mixesCache?.at ?? 0;
    const since = this.mixesCache ? sessions.filter((s: SessionRecord) => s.startTs > cacheAt).length : 99;
    if (
      !force &&
      this.mixesCache &&
      !shouldRefreshMixes(cacheAt, since, now)
    ) {
      return this.mixesCache.mixes;
    }
    const ctx = this.surfaceCtx();
    ctx.listens = await this.ledger.getListens(7);
    try {
      const yesterdayIds = new Set((this.mixesCache?.mixes ?? []).flatMap((m) => m.tracks.map((t) => t.id)));
      const mixes = await buildDailyMixesV2(ctx, yesterdayIds);
      if (mixes.length) {
        this.mixesCache = { at: now, mixes, yesterdayIds, sessionsAtBuild: this.sessionCountAtBoot };
      }
      return mixes;
    } catch {
      return this.mixesCache?.mixes ?? [];
    }
  }

  /**
   * THE WEEKLY CRATE (§9.7) — one edition per ISO week, persisted.
   * Same week → the same crate comes back (restart-stable); a new week
   * rebuilds with last week's ids as the anti-repeat anchor.
   */
  async weeklyCrate(force = false): Promise<WeeklyCrate | null> {
    await this.ready();
    if (this.disabled || !this.ledger) return null;
    const weekKey = weekKeyOf(Date.now());
    if (!force) {
      try {
        const cached = await getWeeklyCrateCache();
        if (cached && cached.weekKey === weekKey) {
          this.weeklyMem = cached.crate;
          return cached.crate;
        }
      } catch {
        /* fall through to rebuild */
      }
    }
    const ctx = this.surfaceCtx();
    // 90d: "unheard" means never-listened in living memory, not merely
    // unserved this week (critic round — the 7d serve window was a lie).
    ctx.listens = await this.ledger.getListens(90);
    try {
      // The previous edition's ids — even a stale-week cache is the right
      // anti-repeat anchor (plus the engine's serve-recency on top).
      const prev = await getWeeklyCrateCache();
      const prevIds = new Set(prev?.prevIds ?? []);
      const crate = await buildWeeklyCrate(ctx, prevIds);
      if (crate) {
        this.weeklyMem = crate;
        await setWeeklyCrateCache({ weekKey: crate.weekKey, crate, prevIds: crate.tracks.map((t) => t.id) });
      }
      return crate;
    } catch {
      // Never let a cold/boot hiccup wipe a still-valid edition: the
      // memory mirror answers even when storage readback fails.
      return this.weeklyMem && this.weeklyMem.weekKey === weekKey ? this.weeklyMem : null;
    }
  }

  async nowSound(force = false): Promise<NowSoundCard | null> {
    await this.ready();
    if (this.disabled || !this.ledger) return null;
    const now = Date.now();
    const blockChanged = this.nowSoundCache && new Date(this.nowSoundCache.at).getHours() !== new Date(now).getHours();
    if (!force && this.nowSoundCache && !blockChanged) return this.nowSoundCache.card;
    const ctx = this.surfaceCtx();
    ctx.listens = await this.ledger.getListens(7);
    try {
      const card = await buildNowSound(ctx);
      this.nowSoundCache = { at: now, card };
      return card;
    } catch {
      return this.nowSoundCache?.card ?? null;
    }
  }

  async onTheRise(force = false): Promise<OnTheRiseCard | null> {
    await this.ready();
    if (this.disabled || !this.ledger) return null;
    const now = Date.now();
    const weekFresh = this.riseCache && now - this.riseCache.at < 7 * 86400_000;
    if (!force && weekFresh) return this.riseCache!.card;
    const ctx = this.surfaceCtx();
    ctx.listens = await this.ledger.getListens(30);
    try {
      const card = await buildOnTheRise(ctx);
      this.riseCache = { at: now, card };
      return card;
    } catch {
      return this.riseCache?.card ?? null;
    }
  }

  /** Ledger-derived stats (§9.7 — Your Sound v2). */
  async stats(): Promise<{
    minutes: number;
    streams: number; // 30-second rule
    topArtists: Array<{ artist: string; plays: number }>;
    topTracks: Array<{ track: Track; plays: number }>;
    byHour: number[]; // 24 buckets of stream counts
    streakDays: number;
    skipRate: number;
    sessions: number;
  } | null> {
    await this.ready();
    if (!this.ledger) return null;
    const listens = await this.ledger.getListens(180);
    const sessions = await this.ledger.getSessions(180);
    let minutes = 0;
    let streams = 0;
    let skipped = 0;
    const byHour = new Array(24).fill(0);
    const artistAgg = new Map<string, number>();
    const trackAgg = new Map<string, { track: Track; plays: number }>();
    const daySet = new Set<string>();
    for (const l of listens) {
      const listenedMin = l.listenedMs / 60000;
      const counted = l.listenedMs >= 30000; // the 30-second rule
      if (counted) {
        streams += 1;
        minutes += listenedMin;
        byHour[new Date(l.startedTs).getHours()] += 1;
        daySet.add(new Date(l.startedTs).toDateString());
        artistAgg.set(l.artist, (artistAgg.get(l.artist) ?? 0) + 1);
        const agg = trackAgg.get(l.trackId);
        if (agg) agg.plays += 1;
        else if (l.title) {
          trackAgg.set(l.trackId, {
            track: {
              id: l.trackId,
              title: l.title ?? 'Unknown',
              artist: l.artist,
              artwork: '',
              duration: Math.round(l.durationMs / 1000),
              source: 'saavn',
              previewOnly: false,
            },
            plays: 1,
          });
        }
      }
      if (l.grade === 'INSTANT_REJECT' || l.grade === 'EARLY_SKIP') skipped += 1;
    }
    // Streak: consecutive days ending today with ≥1 stream.
    let streakDays = 0;
    const today = new Date();
    for (let i = 0; i < 365; i++) {
      const d = new Date(today.getTime() - i * 86400_000).toDateString();
      if (daySet.has(d)) streakDays += 1;
      else if (i > 0) break;
    }
    return {
      minutes: Math.round(minutes),
      streams,
      topArtists: [...artistAgg.entries()].map(([artist, plays]) => ({ artist, plays })).sort((a, b) => b.plays - a.plays).slice(0, 8),
      topTracks: [...trackAgg.values()].sort((a, b) => b.plays - a.plays).slice(0, 10),
      byHour,
      streakDays,
      skipRate: listens.length ? skipped / listens.length : 0,
      sessions: sessions.length,
    };
  }

  /** Top artists (compat with v2.1 engine consumers). */
  topArtistNames(n = 6): string[] {
    return topArtists(this.profile, Date.now(), n).map((a) => a.artist);
  }

  // ── kv passthrough ────────────────────────────────────────────────────

  async kvGet<T>(key: string): Promise<T | null> {
    try {
      return (await this.store?.getKV<T>(`mb.${key}`)) ?? null;
    } catch {
      return null;
    }
  }

  async kvSet<T>(key: string, value: T): Promise<void> {
    try {
      await this.store?.setKV(`mb.${key}`, value);
    } catch {
      /* best-effort */
    }
  }
}

export const mindbeat = new Mindbeat();
void Platform;
