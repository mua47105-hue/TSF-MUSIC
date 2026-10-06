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
import { GENRE_CAPTURE } from './core/constants';
import { createLedgerStore } from './core/storeSqlite'; // web → storeMemory via metro redirect
import { SessionBrain } from './core/session';
import { estimateFeatures } from './core/features';
import { loadFeatureTable } from './core/featureTable';
import { updateArms, type BanditArms } from './core/bandit';
import {
  hydrateLexicons,
  loadScoresFromKV,
  absorbScore,
  scoresToKV,
  lexiconsReady,
  type LyricScore,
} from './core/lyricMood';
import { rankSoundAlike, tagVectorOf } from './core/similarity';
import { BANDIT, LYRIC_MOOD, SIMILARITY } from './core/constants';
import type { ListenRecord, ReasonCode, SessionRecord, SourceSurface, TasteProfile } from './core/types';
import type { Track, WeeklyCrate } from '../types';
import { getFavorites, getSmartShuffleSetting, getWeeklyCrateCache, setWeeklyCrateCache, backfillFavoriteGenre } from '../storage/store';
import { buildRadioV2 } from './surfaces/radio';
import { buildShuffleRecs } from './surfaces/shuffle';
import { buildDailyMixesV2, shouldRefreshMixes, type DailyMixV2 } from './surfaces/mixes';
import { buildWeeklyCrate, weekKeyOf } from './surfaces/weekly';
import { buildNowSound, type NowSoundCard } from './surfaces/daylist';
import { buildOnTheRise, type OnTheRiseCard } from './surfaces/ontherise';
import { searchSaavnClean, getArtistTracks } from '../api/saavn';
import { recordingKey } from '../api/recording';

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
  /** GENIUS P3 — bandit arms (kv-backed, capped, debounced flush). */
  private banditArms: BanditArms = {};
  private banditDirty = false;
  private banditFlushTimer: ReturnType<typeof setTimeout> | null = null;

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
        this.warmAssets(); // GENIUS P2 — post-paint, never blocks boot
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
   * GENIUS P2 — warm the lazy intelligence assets AFTER first paint.
   * Nothing here may touch the cold-start budget (house rule 7): the
   * loader is deferred until interactions settle, runs async, and a
   * failure only means the feature lookups miss into the priors path.
   * InteractionManager resolves lazily (the bun test shim lacks it) with
   * a plain post-turn timer as the fallback — still off the boot path.
   */
  private warmAssets(): void {
    const warm = async () => {
      void loadFeatureTable().catch(() => undefined);
      // GENIUS P3 — bandit arms hydrate post-paint too (kv read, ≤80KB).
      try {
        const arms = await this.kvGet<BanditArms>('banditArms');
        if (arms && typeof arms === 'object') this.banditArms = arms;
      } catch {
        /* arms stay empty → the bandit term is 0 → legacy scoring */
      }
      // GENIUS P5 — lexicons + stored lyric scores hydrate post-paint.
      try {
        hydrateLexicons();
        const kv = await this.kvGet<Record<string, LyricScore>>('lyricMood');
        loadScoresFromKV(kv ?? null);
      } catch {
        /* no scores → every delta lookup misses → behavior unchanged */
      }
    };
    try {
      // Lazy require — a top-level named import breaks non-RN environments.
      const { InteractionManager } = require('react-native');
      if (InteractionManager?.runAfterInteractions) {
        InteractionManager.runAfterInteractions(warm);
        return;
      }
    } catch {
      /* fall through to the timer */
    }
    setTimeout(warm, 0);
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
      // GENIUS P1: a favorite's captured genre is heart-class genre evidence
      // too (the user chose to keep the song) — one bounded bump per genre,
      // recomputed from scratch on every rebuild (deterministic, no drift).
      // Kill switch: the genre evidence mirror is intelligence work — skip it.
      const favGenres = new Map<string, number>();
      for (const f of this.disabled ? [] : favorites.slice(0, 200)) {
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
        const g = f.genre?.toLowerCase().trim();
        if (g) favGenres.set(g, (favGenres.get(g) ?? 0) + 1);
      }
      const genreEntries = [...favGenres.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, GENRE_CAPTURE.maxAffinityEntries);
      for (const [g] of genreEntries) {
        const cur = profile.genres[g];
        if (cur) {
          cur.w = Math.max(cur.w, GENRE_CAPTURE.favoriteBackfillWeight);
          cur.evidenceCount += 1;
          cur.lastEventTs = Math.max(cur.lastEventTs, Date.now());
        } else {
          profile.genres[g] = {
            w: GENRE_CAPTURE.favoriteBackfillWeight,
            lastEventTs: Date.now(),
            evidenceCount: 1,
            source: 'organic',
          };
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
    const feats = estimateFeatures({ artist: track.artist, title: track.title, album: track.album });
    await this.ledger.trackStarted(
      {
        trackId: track.id,
        artist: track.artist,
        artistId: track.artistId,
        title: track.title,
        language: track.language,
        year: track.year,
        durationMs: (track.duration || 210) * 1000,
        energy: feats.energy,
        valence: feats.valence,
        // GENIUS P1: captured genre rides into the graded listen — the
        // profile's genre-affinity path reads ListenRecord.genre.
        genre: track.genre,
        wasRecommended: !!track.isRecommended,
        reasonCode: track.reasonCode as ReasonCode | undefined,
        explorationSlot: !!track.exploration,
      },
      surface,
    );
    if (track.isRecommended) {
      await this.ledger.recExposed(track.id, surface, 0, !!track.exploration);
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

  /** Finalize + fold the listen into the session brain (skip storms etc.). */
  async trackFinished(userInitiated: boolean, cause: 'skip' | 'end' | 'jump' | 'background' = 'end'): Promise<void> {
    if (!this.ledger) return;
    const record = await this.ledger.finalizeTrack(userInitiated, cause);
    if (record && this.brain) this.brain.push(record);
    // GENIUS P3 — single-owner bandit update: exactly the same finalization
    // event the session brain consumes. Kill switch = no writes at all.
    if (record && !this.disabled) {
      this.banditArms = updateArms(
        this.banditArms,
        record.trackId,
        record.grade,
        new Set(this.profile.corrections.mutedArtists.map((a) => a.toLowerCase())),
        record.artist.trim().toLowerCase(),
      );
      this.banditDirty = true;
      this.scheduleBanditFlush();
    }
  }

  /** Debounced kv flush — one write per quiet window, never per skip. */
  private scheduleBanditFlush(): void {
    if (this.banditFlushTimer) clearTimeout(this.banditFlushTimer);
    this.banditFlushTimer = setTimeout(() => {
      this.banditFlushTimer = null;
      if (!this.banditDirty) return;
      this.banditDirty = false;
      void this.kvSet('banditArms', this.banditArms);
    }, BANDIT.flushDebounceMs);
  }

  /**
   * GENIUS P5 — absorb fetched lyrics: score the mood (bounded valence
   * delta) and persist under the recording key. Fire-and-forget from the
   * player's lyric path — never on a critical path; the kill switch
   * blocks writes; a lexicon/asset failure degrades to a silent no-op.
   */
  async absorbLyrics(track: Track, text: string | null | undefined): Promise<void> {
    if (this.disabled || !text || !lexiconsReady()) return;
    try {
      const score = absorbScore(text, track.title, track.artist);
      if (!score) return;
      this.lyricDirty = true;
      this.scheduleLyricFlush();
    } catch {
      /* best-effort — lyrics are a hint */
    }
  }

  private lyricDirty = false;
  private lyricFlushTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleLyricFlush(): void {
    if (this.lyricFlushTimer) clearTimeout(this.lyricFlushTimer);
    this.lyricFlushTimer = setTimeout(() => {
      this.lyricFlushTimer = null;
      if (!this.lyricDirty) return;
      this.lyricDirty = false;
      void this.kvSet('lyricMood', scoresToKV());
    }, LYRIC_MOOD.flushDebounceMs);
  }

  async appBackground(): Promise<void> {
    // The in-flight listen is NOT finalized here — audio typically keeps
    // playing in the background and the service keeps feeding heartbeats;
    // crash recovery covers the killed-mid-track case (§5.5).
    await this.ledger?.onAppBackground();
    // GENIUS P3 — checkpoint pending bandit state before suspension.
    if (this.banditDirty) {
      this.banditDirty = false;
      if (this.banditFlushTimer) clearTimeout(this.banditFlushTimer);
      this.banditFlushTimer = null;
      void this.kvSet('banditArms', this.banditArms);
    }
    // GENIUS P5 — checkpoint pending lyric scores too.
    if (this.lyricDirty) {
      this.lyricDirty = false;
      if (this.lyricFlushTimer) clearTimeout(this.lyricFlushTimer);
      this.lyricFlushTimer = null;
      void this.kvSet('lyricMood', scoresToKV());
    }
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

  /**
   * GENIUS P1 — lazy genre backfill: an old stored favorite that predates
   * genre capture has no genre; when the same recording shows up in a fresh
   * result row that carries one, write it back (exactly once — rows that
   * already have a genre are never overwritten). Fire-and-forget from the
   * search paths; never blocks the UI and honors the kill switch.
   */
  async backfillGenresFrom(tracks: Track[]): Promise<number> {
    if (this.disabled || !tracks.length) return 0;
    try {
      const favorites = await getFavorites();
      if (!favorites.length) return 0;
      const freshByRecording = new Map<string, Track>();
      for (const t of tracks) {
        if (!t.genre) continue;
        const key = recordingKey(t);
        if (!freshByRecording.has(key)) freshByRecording.set(key, t);
      }
      if (!freshByRecording.size) return 0;
      let n = 0;
      for (const fav of favorites) {
        if (fav.genre) continue;
        const fresh = freshByRecording.get(recordingKey(fav));
        if (!fresh) continue;
        if (await backfillFavoriteGenre(fav.id, fresh.genre!)) n += 1;
      }
      return n;
    } catch {
      return 0; // best-effort — never break the caller
    }
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
    await this.rebuildProfile();
  }

  /** Kill switch: disable all recommendations (classic-only, §10.4). */
  async setDisabled(off: boolean): Promise<void> {
    this.disabled = off;
    await this.kvSet('intelligenceDisabled', off);
    if (off) {
      // G7 letter-and-spirit: a pending debounced write must not land
      // after the switch is thrown — cancel both timers, drop the flags.
      if (this.banditFlushTimer) clearTimeout(this.banditFlushTimer);
      this.banditFlushTimer = null;
      this.banditDirty = false;
      if (this.lyricFlushTimer) clearTimeout(this.lyricFlushTimer);
      this.lyricFlushTimer = null;
      this.lyricDirty = false;
    }
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
      banditArms: this.disabled ? undefined : this.banditArms,
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
    // Fallback ladder rung 1 — GENIUS P6 SOUND_ALIKE: tag-cousins of the
    // seed (genre/language/era/mood/artist overlap ≥2 dims), pulled from
    // the catalog. A real "close to this song" rung BEFORE the plain
    // deep-cuts rung; every returned row carries the truthful reason.
    if (!out.length && seed) {
      const alike = await this.soundAlike(seed, 3, excludeIds);
      if (alike.length) return alike;
    }
    // Fallback ladder rung 2 (legacy): seed-artist deep cuts only,
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
    return out;
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

  /** GENIUS P6 — per-seed 7-day cache (same freshness law as onTheRise). */
  private alikeCache: { at: number; seedKey: string; tracks: Track[] } | null = null;

  /**
   * SOUND_ALIKE (§ similarity) — "songs like this one" via tag overlap.
   * Candidates come from the EXISTING injected CatalogApi (search by the
   * seed's artist + genre), bounded to SIMILARITY.candidatePoolCap; the
   * ranking scan is linear over that bounded pool (core/similarity).
   * Kill-switched; 7-day cached per seed (only when the pool actually
   * yielded candidates — a transient catalog failure is NOT cached as
   * "no sound-alikes" for a week, critic fix 10); empty when the
   * catalog/seed carries too few tags (honest).
   */
  async soundAlike(seed: Track, count = 3, excludeIds?: Set<string>): Promise<Track[]> {
    await this.ready();
    if (this.disabled || !this.ledger) return [];
    const seedKey = `${seed.id}:${seed.title}:${seed.artist}`;
    const now = Date.now();
    if (
      !this.alikeCache ||
      this.alikeCache.seedKey !== seedKey ||
      now - this.alikeCache.at > SIMILARITY.cacheTtlMs
    ) {
      this.alikeCache = null; // stale/foreign seed — rebuild below
      const queries: string[] = [];
      const primary = seed.artist.split(/,|&/)[0].trim();
      if (primary) queries.push(primary);
      if (seed.genre) queries.push(seed.genre);
      const pool: Track[] = [];
      const seen = new Set<string>();
      for (const q of queries) {
        if (pool.length >= SIMILARITY.candidatePoolCap) break;
        let rows: Track[] = [];
        try {
          rows = await CATALOG.search(q, SIMILARITY.catalogSearchLimit);
        } catch {
          rows = [];
        }
        for (const t of rows) {
          if (pool.length >= SIMILARITY.candidatePoolCap) break;
          if (seen.has(t.id) || excludeIds?.has(t.id)) continue;
          seen.add(t.id);
          pool.push(t);
        }
      }
      const seedVec = tagVectorOf(seed);
      const ranked = rankSoundAlike(seedVec, seed.id, pool);
      if (!pool.length) return []; // catalog unreachable — try again next call
      this.alikeCache = {
        at: now,
        seedKey,
        tracks: ranked.map(({ track, shared }) => ({
          ...track,
          isRecommended: true,
          reasonCode: 'SOUND_ALIKE',
          reason: `Close to ${seed.title}`, // truthful: the shared-tag evidence was computed
          sharedTagsWithSeed: shared,
        })),
      };
    }
    return this.alikeCache.tracks.slice(0, count);
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
