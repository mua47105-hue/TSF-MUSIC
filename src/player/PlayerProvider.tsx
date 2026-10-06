/**
 * PlayerProvider v2 — wraps react-native-track-player into the app-level
 * player API. Beyond v1 (queue, shuffle, repeat, likes), it adds:
 *
 *  • playNext / addToQueue / removeFromQueue  (real queue control)
 *  • Smart Shuffle — injects AI recommendations between upcoming tracks
 *  • Autoplay radio toggle (the endless extension itself runs in the
 *    background service so it keeps working when the UI is killed)
 *  • Play-count tracking that powers the AI listening graph
 *  • Toast feedback for every queue mutation
 *
 * Design notes (gauntlet-inherited):
 *  - setup failures are never cached — next interaction retries cleanly
 *  - the RNTP queue is the single source of truth; React mirrors it
 *  - progress is NOT in this context so playback doesn't re-render rows
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState, PermissionsAndroid, Platform, StyleSheet, View } from 'react-native';
import TrackPlayer, {
  Capability,
  RepeatMode,
  usePlaybackState,
  useActiveTrack,
  AppKilledPlaybackBehavior,
  type Track as RNTrack,
} from 'react-native-track-player';
import type { Track } from '../types';
import { resolveStreamUrl } from '../api/saavn';
import { ytStreamUrlForTrack, ytLastDiagnostics } from '../api/youtube';
import { YtPoTokenBridge } from '../api/ytPoToken';
import { playbackService } from './service';
import { getRecommendations } from '../ai/engine';
import { mindbeat } from '../ai/mindbeat';
import type { SourceSurface } from '../ai/core/types';
import { useToast } from '../components/Toast';
import {
  getAutoplay,
  getDownloadIndex,
  getFavorites,
  getSmartShuffleSetting,
  incrementPlayCount,
  pushRecent,
  setAutoplay as persistAutoplay,
  setSmartShuffleSetting as persistSmartShuffle,
  toggleFavorite as storeToggleFavorite,
} from '../storage/store';
import { perfMark } from '../perf/perf';
import { initDataSaver } from './audioQuality';

let setupPromise: Promise<void> | null = null;
let notifAsked = false;

async function askNotificationPermission(): Promise<void> {
  if (notifAsked) return;
  notifAsked = true;
  if (Platform.OS === 'android' && Platform.Version >= 33) {
    try {
      await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    } catch {
      /* denied → playback still works, controls just won't show */
    }
  }
}

async function ensureSetup(): Promise<void> {
  if (!setupPromise) {
    setupPromise = (async () => {
      TrackPlayer.registerPlaybackService(() => playbackService);
      try {
        await TrackPlayer.setupPlayer({ autoHandleInterruptions: true });
      } catch (e: any) {
        // "already initialized" is fine; anything else must be retryable.
        if (!String(e?.message ?? '').includes('already')) throw e;
      }
      await TrackPlayer.updateOptions({
        android: {
          appKilledPlaybackBehavior: AppKilledPlaybackBehavior.ContinuePlayback,
        },
        capabilities: [
          Capability.Play,
          Capability.Pause,
          Capability.SkipToNext,
          Capability.SkipToPrevious,
          Capability.SeekTo,
        ],
        notificationCapabilities: [
          Capability.Play,
          Capability.Pause,
          Capability.SkipToNext,
          Capability.SkipToPrevious,
          Capability.SeekTo,
        ],
        compactCapabilities: [Capability.Play, Capability.Pause, Capability.SkipToNext],
        progressUpdateEventInterval: 1,
      });
    })();
    setupPromise.catch(() => {
      setupPromise = null;
    });
  }
  return setupPromise;
}

function shuffleArray<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

interface PlayerState {
  active: Track | null;
  /** Optimistic plant (Task 29): the tapped row shows in the mini bar
   *  the instant it is pressed, BEFORE the stream resolves. Cleared when
   *  the real track mounts, on failure, or after 8s. */
  optimistic: Track | null;
  isPlaying: boolean;
  loading: boolean;
  queue: Track[];
  shuffle: boolean;
  smartShuffle: boolean;
  autoplay: boolean;
  repeat: 'off' | 'queue' | 'track';
  favorites: Set<string>;
  playQueue: (tracks: Track[], startIndex?: number, surface?: SourceSurface) => Promise<void>;
  togglePlay: () => Promise<void>;
  next: () => Promise<void>;
  prev: () => Promise<void>;
  seek: (seconds: number) => Promise<void>;
  setShuffle: (on: boolean) => Promise<void>;
  setSmartShuffle: (on: boolean) => Promise<void>;
  setAutoplay: (on: boolean) => Promise<void>;
  cycleRepeat: () => Promise<void>;
  toggleLike: (track: Track) => Promise<void>;
  playNext: (track: Track) => Promise<void>;
  addToQueue: (track: Track) => Promise<void>;
  /** Vibe shift (Task 28): batch-insert recommended tracks after the current
   *  one with a single toast (the caller owns the copy). Returns count queued. */
  queueVibeShift: (tracks: Track[]) => Promise<number>;
  removeFromQueue: (trackId: string) => Promise<void>;
  refreshQueue: () => Promise<void>;
}

const PlayerContext = createContext<PlayerState | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [queue, setQueue] = useState<Track[]>([]);
  // INSTANT TAP (Task 29): the row the user last asked to play, planted
  // BEFORE any network work so the mini bar answers the tap immediately.
  const [optimistic, setOptimistic] = useState<Track | null>(null);
  // the 8s stale-plant timer (critic IT-3): cleared before every new plant
  const staleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [shuffle, setShuffleState] = useState(false);
  const [smartShuffle, setSmartShuffleState] = useState(false);
  const [autoplay, setAutoplayState] = useState(true);
  const [repeat, setRepeat] = useState<'off' | 'queue' | 'track'>('off');
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const originalQueue = useRef<Track[]>([]);
  const recentPushed = useRef<string>('');
  const booted = useRef(false);
  const surfaceRef = useRef<SourceSurface>('user_queue');
  const pendingSkip = useRef(false);

  const refreshQueue = useCallback(async () => {
    try {
      const rntpQueue = (await TrackPlayer.getQueue()) as unknown as Track[];
      if (rntpQueue.length) setQueue(rntpQueue);
      else setQueue([]);
    } catch {
      /* player not ready */
    }
  }, []);

  // Boot: rehydrate queue from RNTP (app-kill-relaunch continuity) + settings.
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    (async () => {
      try {
        await ensureSetup();
        await refreshQueue();
      } catch {
        /* first cold start: empty queue */
      }
    })();
    // MINDBEAT boots behind the UI (cold-start budget §10.3): store opens,
    // partial listens recover, profile builds async, sessions start.
    void mindbeat.init();
    // v4.2.0 — heavy tables (baked features, bandit, lyric cache) load
    // AFTER first paint, never on the cold-start path (law ⑦).
    void mindbeat.warmHeavyTables();
    getFavorites().then((list) => setFavorites(new Set(list.map((t) => t.id))));
    getSmartShuffleSetting().then(setSmartShuffleState);
    getAutoplay().then(setAutoplayState);
    initDataSaver(); // sync bridge for the stream resolver (Task 28)
  }, [refreshQueue]);

  // The background service may extend the queue with radio tracks while the
  // UI is backgrounded — resync whenever the app comes back.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void refreshQueue();
        void mindbeat.appActive();
      } else if (state === 'background') {
        void mindbeat.appBackground();
      }
    });
    return () => sub.remove();
  }, [refreshQueue]);

  const playback = usePlaybackState();
  const activeRN = useActiveTrack();

  const active: Track | null = useMemo(() => {
    if (!activeRN) return null;
    return activeRN as unknown as Track;
  }, [activeRN]);

  // Record play history + play counts (sanitized — no stream URLs in storage)
  // + the graded MINDBEAT listen (L1 ledger: the previous track finalizes,
  // the new one starts, surface-tagged).
  const prevTrackId = useRef<string>('');
  useEffect(() => {
    // INSTANT TAP: a real track mounting means the plant is obsolete —
    // clear it no matter which song won (covers retry + service starts)
    if (active?.id) setOptimistic((cur) => (cur ? null : cur));
    if (!active?.id || active.id === prevTrackId.current) return;
    perfMark('track-active', String(active.id));
    // SINGLE-OWNER RULE (mirror of the service gate): the provider owns
    // track transitions only while FOREGROUNDED; the background service
    // owns them otherwise — otherwise both instrument the same change and
    // the second finalize manufactures a phantom 0ms INSTANT_REJECT.
    if (AppState.currentState !== 'active') {
      prevTrackId.current = active.id; // stay in sync; service owns grading
      return;
    }
    const prevId = prevTrackId.current;
    prevTrackId.current = active.id;

    // Finalize the in-flight listen (skip vs jump distinction captured by
    // pendingSkip; grading itself is ratio-driven so it stays honest).
    if (prevId) {
      void mindbeat.trackFinished(pendingSkip.current, pendingSkip.current ? 'skip' : 'jump');
      pendingSkip.current = false;
    }

    if (active.id !== recentPushed.current) {
      recentPushed.current = active.id;
      const { url, localUri, ...meta } = active as any;
      void localUri;
      void url;
      pushRecent(meta as Track).catch(() => undefined);
      incrementPlayCount(meta as Track).catch(() => undefined);
    }
    void mindbeat.trackStarted(active as Track, surfaceRef.current);
  }, [active?.id]);

  const state = playback?.state;
  const isPlaying = state === 'playing';
  const loading = state === 'loading' || state === 'buffering';

  // [TSF-PERF] fires on every pause/resume→playing transition; the lab pairs
  // the first unconsumed one after each play/skip request into the
  // time-to-audio and skip-latency metrics (scripts/e2e/parse_perf.py).
  const wasPlayingRef = useRef(false);
  useEffect(() => {
    const now = state === 'playing';
    if (now && !wasPlayingRef.current) perfMark('audio-playing', String(active?.id ?? ''));
    wasPlayingRef.current = now;
  }, [state, active?.id]);

  async function buildPlayable(tracks: Track[]): Promise<RNTrack[]> {
    const downloads = await getDownloadIndex();
    const byId = new Map(downloads.map((d) => [d.id, d]));
    // YOUTUBE SOURCE: resolve stream URLs BEFORE queue construction
    // (RNTP needs a real url per item). Concurrency-limited (4) so a
    // 25-row YT queue costs ~ceiling(25/4) probes; the module's LRU
    // makes repeats free. Failures drop the row — never stall the queue.
    const ytUrls = new Map<string, string | null>();
    const ytTracks = tracks.filter((t) => t.source === 'youtube');
    if (ytTracks.length > 0) {
      let cursor = 0;
      const CONCURRENCY = 4;
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, ytTracks.length) }, async () => {
          while (cursor < ytTracks.length) {
            const t = ytTracks[cursor];
            cursor += 1;
            const url = t.streamUrl ?? (await ytStreamUrlForTrack(t).catch(() => null));
            ytUrls.set(t.id, url);
          }
        }),
      );
    }
    const playable: RNTrack[] = [];
    for (const t of tracks) {
      const local = byId.get(t.id);
      const url =
        t.source === 'youtube'
          ? t.streamUrl || ytUrls.get(t.id) || null
          : local?.localUri || t.localUri || resolveStreamUrl(t);
      if (!url) continue;
      playable.push({
        id: t.id,
        url,
        title: t.title,
        artist: t.artist,
        artwork: t.artwork,
        duration: t.duration || 0,
        source: t.source,
        saavnId: t.saavnId,
        encryptedUrl: t.encryptedUrl,
        youtubeId: t.youtubeId,
        previewUrl: t.previewUrl,
        previewOnly: t.previewOnly,
        has320: t.has320,
        album: t.album,
        albumId: t.albumId,
        artistId: t.artistId,
        explicit: t.explicit,
        isRecommended: t.isRecommended,
        reason: (t as Track).reason,
        reasonCode: (t as Track).reasonCode,
        exploration: (t as Track).exploration,
        language: (t as Track).language,
        year: (t as Track).year,
        localUri: local?.localUri || t.localUri,
      } as unknown as RNTrack);
    }
    return playable;
  }

  async function playQueue(tracks: Track[], startIndex = 0, surface: SourceSurface = 'user_playlist'): Promise<void> {
    surfaceRef.current = surface;
    // INSTANT TAP (Task 29, critic IT-1): answer the press BEFORE any await
    // — ensureSetup/notification-permission must never sit between the tap
    // and the mini bar's TUNING IN.
    const planted = tracks[startIndex];
    if (planted?.id) {
      if (staleTimer.current) clearTimeout(staleTimer.current);
      setOptimistic(planted);
      staleTimer.current = setTimeout(() => {
        // stale plant = honest reset (resolution never came back)
        setOptimistic((cur) => (cur?.id === planted.id ? null : cur));
      }, 8000);
    }
    try {
      await ensureSetup();
      await askNotificationPermission();
      const wantedId = tracks[startIndex]?.id;
      perfMark('play-request', String(wantedId));
      const playable = await buildPlayable(tracks);
      if (!playable.length || !wantedId) {
        // HONEST FAILURE (no more blank player): if the tapped row was a
        // YouTube row that the ladder could not resolve, say so with the
        // diagnostics trail instead of silently doing nothing.
        const wanted = tracks[startIndex];
        if (wanted?.source === 'youtube') {
          const trail = ytLastDiagnostics().slice(0, 5).join(' | ');
          toast.show({
            message: 'YouTube stream unavailable right now — retrying via secure resolver in a moment',
            icon: 'alert-outline',
          });
          // second chance: the PO-token bridge may need one warm-up round
          await new Promise((r) => setTimeout(r, 1200));
          const retry = await buildPlayable(tracks);
          if (retry.length && retry.some((m) => m.id === wantedId)) {
            const startAt2 = Math.max(0, retry.findIndex((t) => t.id === wantedId));
            const mapped2 = retry as unknown as Track[];
            setQueue(mapped2);
            originalQueue.current = tracks.filter((t) => mapped2.some((m) => m.id === t.id));
            await TrackPlayer.reset();
            await TrackPlayer.add(retry);
            await TrackPlayer.skip(startAt2);
            await TrackPlayer.play();
            setOptimistic(null); // the real track takes over from the plant
            return;
          }
          // P1-3: the retry promise gets a FINAL honest answer, never silence
          toast.show({ message: 'That YouTube track is unavailable right now', icon: 'alert-outline' });
          if (__DEV__) console.warn('[yt] resolve failed:', trail);
        }
        setOptimistic(null); // honest failure: the plant comes down
        return;
      }
      // the WANTED row itself dropped (others survived) — never start on a
      // different song than the user asked for (P2-3: ALL sources, not
      // just YouTube — a dropped saavn row must not fall through to
      // startAt=0 and play some other song)
      if (!playable.some((m) => m.id === wantedId)) {
        toast.show({
          message:
            tracks[startIndex]?.source === 'youtube'
              ? 'That YouTube track is unavailable right now'
              : 'Could not queue that song',
          icon: 'alert-outline',
        });
        setOptimistic(null); // honest failure: the plant comes down
        return;
      }
      const startAt = Math.max(0, playable.findIndex((t) => t.id === wantedId));
      const mapped = playable as unknown as Track[];
      setQueue(mapped);
      originalQueue.current = tracks.filter((t) => mapped.some((m) => m.id === t.id));
      await TrackPlayer.reset();
      await TrackPlayer.add(playable);
      await TrackPlayer.skip(startAt);
      await TrackPlayer.play();
      if (staleTimer.current) clearTimeout(staleTimer.current);
      setOptimistic(null); // the real track takes over from the plant
      perfMark('queue-started', String(wantedId));
      if (smartShuffle) {
        void injectRecommendations(startAt);
      }
    } catch {
      /* transient setup/network failure — next tap retries */
      if (staleTimer.current) clearTimeout(staleTimer.current);
      setOptimistic(null); // honest failure: the plant comes down
    }
  }

  /**
   * Smart Shuffle v2 (§9.1): per-slot Decision Engine picks with
   * vibe-lock, truthful reasons and hygiene — via MINDBEAT. Falls back to
   * the v2.1 artist-mix engine when the intelligence layer is unavailable
   * (fallback ladder §10.4: never dumber than v2.1).
   */
  async function injectRecommendations(currentIdx: number, healFrom: Track | null = null): Promise<void> {
    try {
      await ensureSetup();
      const rntpQueue = (await TrackPlayer.getQueue()) as unknown as Track[];
      const base = rntpQueue.filter((t) => !t.isRecommended);
      if (base.length < 2 && !healFrom) return;
      const upcoming = rntpQueue.slice(currentIdx + 1);

      let recs: Track[] = await mindbeat.shuffleRecs(upcoming, healFrom);
      if (!recs.length) {
        recs = await getRecommendations(base.slice(currentIdx, currentIdx + 10), 6);
      }
      if (!recs.length) return;

      // Remove stale recs when healing so the reseed replaces them.
      if (healFrom) {
        const removeIdx = rntpQueue
          .map((t, i) => (t.isRecommended && i > currentIdx ? i : -1))
          .filter((i) => i >= 0)
          .sort((a, b) => b - a);
        for (const i of removeIdx) await TrackPlayer.remove(i).catch(() => undefined);
      }

      let insertAt = currentIdx + 1;
      for (const rec of recs.slice(0, 6)) {
        const playable = await buildPlayable([{ ...rec, isRecommended: true }]);
        if (playable.length) {
          await TrackPlayer.add(playable, insertAt);
          insertAt += 2;
        }
      }
      await refreshQueue();
    } catch {
      /* recommendations are best-effort */
    }
  }

  async function togglePlay(): Promise<void> {
    try {
      await ensureSetup();
      const current = await TrackPlayer.getActiveTrackIndex();
      if (current == null) {
        if (queue.length) await playQueue(queue, 0);
        return;
      }
      if (isPlaying) await TrackPlayer.pause();
      else await TrackPlayer.play();
    } catch {
      /* retry next tap */
    }
  }

  async function next(): Promise<void> {
    // Queue healing (§9.1): skipping a RECOMMENDED track immediately
    // re-seeds the remaining rec slots away from what was rejected.
    perfMark('skip-request');
    try {
      const idx = await TrackPlayer.getActiveTrackIndex();
      if (idx != null) {
        const current = (await TrackPlayer.getTrack(idx)) as unknown as Track | null;
        mindbeat.markPendingSkip();
        pendingSkip.current = true;
        if (current?.isRecommended && smartShuffle) {
          void mindbeat.trackFinished(true, 'skip');
          void injectRecommendations(idx, current as Track);
          await TrackPlayer.skipToNext().catch(() => undefined);
          return;
        }
      }
    } catch {
      /* fall through to plain skip */
    }
    await TrackPlayer.skipToNext().catch(() => undefined);
  }

  async function prev(): Promise<void> {
    try {
      const pos = (await TrackPlayer.getProgress()).position;
      if (pos > 3) {
        await TrackPlayer.seekTo(0);
        return;
      }
      await TrackPlayer.skipToPrevious();
    } catch {
      await TrackPlayer.seekTo(0).catch(() => undefined);
    }
  }

  async function seek(seconds: number): Promise<void> {
    try {
      const pos = (await TrackPlayer.getProgress().catch(() => null))?.position ?? 0;
      void mindbeat.seek(pos * 1000, Math.max(0, seconds) * 1000);
    } catch {
      /* seek evidence is best-effort */
    }
    await TrackPlayer.seekTo(Math.max(0, seconds)).catch(() => undefined);
  }

  /**
   * Classic shuffle reorders only the UPCOMING tracks — never restarts
   * the current song.
   */
  async function setShuffle(on: boolean): Promise<void> {
    setShuffleState(on);
    try {
      await ensureSetup();
      const rntpQueue = (await TrackPlayer.getQueue()) as unknown as Track[];
      const currentIdx = await TrackPlayer.getActiveTrackIndex();
      if (currentIdx == null || !rntpQueue.length) return;

      const currentId = rntpQueue[currentIdx]?.id;
      const upcoming = rntpQueue.filter((_, i) => i !== currentIdx);
      const reordered = on
        ? shuffleArray(upcoming)
        : originalQueue.current.filter((t) => t.id !== currentId);

      const removeIndices = rntpQueue
        .map((_, i) => i)
        .filter((i) => i !== currentIdx)
        .sort((a, b) => b - a);
      if (removeIndices.length) await TrackPlayer.remove(removeIndices);

      if (reordered.length) {
        const playable = await buildPlayable(reordered);
        if (playable.length) await TrackPlayer.add(playable);
      }

      const full = [rntpQueue[currentIdx], ...reordered].filter(Boolean) as Track[];
      setQueue(full);
    } catch {
      /* keep UI state anyway */
    }
  }

  /**
   * Smart Shuffle (Spotify-style): AI recommendations are interleaved
   * between upcoming tracks, badged with a sparkle in the queue UI.
   */
  async function setSmartShuffle(on: boolean): Promise<void> {
    setSmartShuffleState(on);
    persistSmartShuffle(on).catch(() => undefined);
    toast.show({
      message: on ? 'Smart Shuffle on — TSF AI is mixing in picks' : 'Smart Shuffle off',
      icon: 'sparkles',
    });
    try {
      await ensureSetup();
      if (!on) {
        const rntpQueue = (await TrackPlayer.getQueue()) as unknown as Track[];
        const removeIndices = rntpQueue
          .map((t, i) => (t.isRecommended ? i : -1))
          .filter((i) => i >= 0)
          .sort((a, b) => b - a);
        if (removeIndices.length) await TrackPlayer.remove(removeIndices);
        await refreshQueue();
        return;
      }
      const currentIdx = (await TrackPlayer.getActiveTrackIndex()) ?? 0;
      await injectRecommendations(currentIdx);
    } catch {
      /* best-effort */
    }
  }

  async function toggleAutoplay(on: boolean): Promise<void> {
    setAutoplayState(on);
    persistAutoplay(on).catch(() => undefined);
    toast.show({
      message: on ? 'Autoplay on — radio keeps the music going' : 'Autoplay off',
      icon: on ? 'radio-outline' : 'pause',
    });
  }

  async function cycleRepeat(): Promise<void> {
    const order: Array<'off' | 'queue' | 'track'> = ['off', 'queue', 'track'];
    const nextMode = order[(order.indexOf(repeat) + 1) % order.length];
    setRepeat(nextMode);
    const mode =
      nextMode === 'queue' ? RepeatMode.Queue : nextMode === 'track' ? RepeatMode.Track : RepeatMode.Off;
    await TrackPlayer.setRepeatMode(mode).catch(() => undefined);
  }

  async function toggleLike(track: Track): Promise<void> {
    const { url, localUri, ...meta } = track as any;
    void url;
    void localUri;
    const nowFav = await storeToggleFavorite(meta as Track);
    setFavorites((prev) => {
      const nextSet = new Set(prev);
      if (nowFav) nextSet.add(track.id);
      else nextSet.delete(track.id);
      return nextSet;
    });
    // Heart evidence into the ledger (+4.0, slowest-decaying tier §5.2).
    if (nowFav) void mindbeat.liked(track, surfaceRef.current);
    else void mindbeat.unliked(track);
    toast.show({
      message: nowFav ? 'Added to Liked Songs' : 'Removed from Liked Songs',
      icon: nowFav ? 'heart' : 'heart-dislike-outline',
    });
  }

  async function playNext(track: Track): Promise<void> {
    try {
      await ensureSetup();
      const playable = await buildPlayable([track]);
      if (!playable.length) {
        toast.show({
          message: track.source === 'youtube' ? 'That YouTube track is unavailable right now' : 'Could not queue that song',
          icon: 'alert-outline',
        });
        return;
      }
      const currentIdx = await TrackPlayer.getActiveTrackIndex();
      await TrackPlayer.add(playable, (currentIdx ?? -1) + 1);
      await refreshQueue();
      void mindbeat.queueAdded(track, surfaceRef.current);
      toast.show({ message: `Playing next: ${track.title}`, icon: 'play' });
    } catch {
      toast.show({ message: 'Could not queue that song', icon: 'alert-outline' });
    }
  }

  async function addToQueue(track: Track): Promise<void> {
    try {
      await ensureSetup();
      const playable = await buildPlayable([track]);
      if (!playable.length) {
        toast.show({
          message: track.source === 'youtube' ? 'That YouTube track is unavailable right now' : 'Could not queue that song',
          icon: 'alert-outline',
        });
        return;
      }
      await TrackPlayer.add(playable);
      await refreshQueue();
      toast.show({ message: `Added to queue: ${track.title}`, icon: 'add' });
    } catch {
      toast.show({ message: 'Could not queue that song', icon: 'alert-outline' });
    }
  }

  async function removeFromQueue(trackId: string): Promise<void> {
    try {
      const rntpQueue = (await TrackPlayer.getQueue()) as unknown as Track[];
      const idx = rntpQueue.findIndex((t) => t.id === trackId);
      if (idx >= 0) {
        const wasRec = !!rntpQueue[idx]!.isRecommended;
        await TrackPlayer.remove(idx);
        await refreshQueue();
        // Removing a recommendation is a negative signal (§5.1 QUEUE_REMOVE).
        void mindbeat.queueRemoved(trackId, wasRec);
        toast.show({ message: 'Removed from queue', icon: 'remove' });
      }
    } catch {
      /* noop */
    }
  }

  /** Vibe shift batch insert (Task 28): all picks land after the current
   * track IN ORDER with no per-track toasts — the caller toasts once. */
  async function queueVibeShift(tracks: Track[]): Promise<number> {
    try {
      if (!tracks.length) return 0;
      await ensureSetup();
      const playable = await buildPlayable(tracks);
      if (!playable.length) return 0;
      const currentIdx = await TrackPlayer.getActiveTrackIndex();
      await TrackPlayer.add(playable, (currentIdx ?? -1) + 1);
      await refreshQueue();
      for (const t of playable) void mindbeat.queueAdded(t as unknown as Track, surfaceRef.current);
      return playable.length;
    } catch {
      return 0;
    }
  }

  const value: PlayerState = useMemo(
    () => ({
      active,
      optimistic,
      isPlaying,
      loading,
      queue,
      shuffle,
      smartShuffle,
      autoplay,
      repeat,
      favorites,
      playQueue,
      togglePlay,
      next,
      prev,
      seek,
      setShuffle,
      setSmartShuffle,
      setAutoplay: toggleAutoplay,
      cycleRepeat,
      toggleLike,
      playNext,
      queueVibeShift,
      addToQueue,
      removeFromQueue,
      refreshQueue,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active, optimistic, isPlaying, loading, queue, shuffle, smartShuffle, autoplay, repeat, favorites],
  );

  return (
    <PlayerContext.Provider value={value}>
      {children}
      {/* hidden BotGuard PO-token minter — the YouTube attested rung.

          R7 HOST WRAPPER — the v3.4.0–v3.4.3 half-screen bug: the bridge's
          WebView library renders its own container View, and whatever that
          container's style ends up being (v14: flex:1 IN-FLOW unless the
          caller passes containerStyle), an in-flow sibling under the app
          root splits the screen 50/50 in Yoga. Hosting the bridge inside
          an absolute, sub-pixel, touch-transparent View makes that entire
          failure class structurally impossible — for ANY webview version
          or future refactor of the bridge. */}
      <View style={styles.poTokenHost} pointerEvents="none">
        <YtPoTokenBridge />
      </View>
    </PlayerContext.Provider>
  );
}

export function usePlayer(): PlayerState {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer outside PlayerProvider');
  return ctx;
}

const styles = StyleSheet.create({
  /** Absolute, sub-pixel, touch-transparent host for the hidden PO-token
   *  WebView — see the R7 comment at the mount site. Out-of-flow by
   *  construction: it can never take part in the app's flex layout. */
  poTokenHost: {
    position: 'absolute',
    width: 1,
    height: 1,
    top: 0,
    left: 0,
    opacity: 0.01,
  },
});
