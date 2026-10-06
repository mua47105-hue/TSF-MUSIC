/**
 * react-native-track-player background service — the piece that makes
 * this a real music app: lock-screen / notification controls, audio
 * focus handling, automatic recovery when a CDN stream URL has gone
 * stale (refetch → decrypt → reload), and ENDLESS RADIO:
 *
 * When the queue runs dry and Autoplay is on, MINDBEAT Radio v2 builds a
 * multi-seed, dedup-aware station from the last played track + session
 * context — even when the UI process is gone. Every pick carries a
 * truthful reason line.
 *
 * The 1s PlaybackProgressUpdated ticks also feed the Event Ledger's
 * heartbeats (10s cadence inside the ledger), so graded evidence survives
 * app kills mid-track (§5.5 crash recovery).
 */

import TrackPlayer, { Event } from 'react-native-track-player';
import { AppState } from 'react-native';
import { resolveStreamUrl, refreshStreamUrl } from '../api/saavn';
import { ytRefreshStream } from '../api/youtube';
import { getRadio } from '../ai/engine';
import { getAutoplay } from '../storage/store';
import { mindbeat } from '../ai/mindbeat';
import { crossfadeTick, initCrossfade, resetCrossfadeRamp } from './crossfade';
import { applySmartVolumeForTrack, initSmartVolume } from './smartVolume';
import { initPlaybackRate } from './playbackRate';
import type { Track } from '../types';

let refreshing = false;
let extending = false;
let lastTrackId = '';
let radioServedCount = 0;
let radioListenRatios: number[] = [];

export async function playbackService(): Promise<void> {
  // THE TEN wave 1 (critic R2): the headless context must honor persisted
  // preferences too — the UI provider may never run (app killed,
  // ContinuePlayback). All three are idempotent + catch-swallowed.
  initSmartVolume();
  initCrossfade();
  initPlaybackRate();

  TrackPlayer.addEventListener(Event.RemotePlay, () => TrackPlayer.play());
  TrackPlayer.addEventListener(Event.RemotePause, () => TrackPlayer.pause());

  // Remote/headset next = user-initiated skip (graded evidence §5.2).
  TrackPlayer.addEventListener(Event.RemoteNext, async () => {
    mindbeat.markPendingSkip();
    const idx = await TrackPlayer.getActiveTrackIndex().catch(() => null);
    if (idx != null) {
      const current = (await TrackPlayer.getTrack(idx).catch(() => null)) as unknown as Track | null;
      if (current?.id && current.id !== lastTrackId) {
        lastTrackId = current.id;
      }
    }
    await TrackPlayer.skipToNext();
  });
  TrackPlayer.addEventListener(Event.RemotePrevious, () => TrackPlayer.skipToPrevious());
  TrackPlayer.addEventListener(Event.RemoteSeek, (e) => TrackPlayer.seekTo(e.position));

  // THE TEN F2 — the transition INSTANT releases the crossfade ramp: the
  // 1s progress ticks would otherwise let the next track start near-silent
  // for up to one tick (critic round 1). Idempotent through the bus.
  TrackPlayer.addEventListener(Event.PlaybackActiveTrackChanged, () => {
    resetCrossfadeRamp();
  });

  // Heartbeat feed: 1s ticks → the ledger batches them at 10s cadence.
  // SINGLE-OWNER RULE: the UI provider owns track-start/finish while the
  // app is foregrounded; the service takes over ONLY in background/headless
  // playback, so a transition is never instrumented twice (which graded
  // every normal track change as a phantom skip — critic-verified P0).
  TrackPlayer.addEventListener(Event.PlaybackProgressUpdated, async (e) => {
    try {
      const idx = await TrackPlayer.getActiveTrackIndex();
      if (idx != null) {
        const t = (await TrackPlayer.getTrack(idx)) as unknown as Track | null;
        if (t?.id) {
          if (t.id !== lastTrackId) {
            lastTrackId = t.id;
            if (AppState.currentState !== 'active') {
              // Headless/background transition: finalize prev, start new.
              void mindbeat.trackFinished(false, 'jump');
              void mindbeat.trackStarted(t, t.isRecommended ? 'radio' : 'user_queue');
              // THE TEN F1 — headless transitions get Smart Volume too: the
              // UI provider may be dead (AppKilledPlaybackBehavior.
              // ContinuePlayback keeps audio alive), so the service owns
              // the multiplier here. THE TEN F3 — the persisted rate boots
              // lazily in the headless context (the provider never ran).
              applySmartVolumeForTrack(mindbeat.bakedEnergyFor({ title: t.title, artist: t.artist }));
              initPlaybackRate();
            }
            radioServedCount += t.isRecommended ? 1 : 0;
          }
          if (e.duration > 0 && e.position / Math.max(1, e.duration) < 1.05) {
            radioListenRatios.push(Math.min(1, e.position / Math.max(1, e.duration)));
            if (radioListenRatios.length > 400) radioListenRatios.shift();
          }
          // THE TEN F2 — the crossfade ramp is fed HERE so it works with
          // the UI killed (headless); the bus arbitrates with sleep/focus.
          crossfadeTick(e.position, e.duration);
          await mindbeat.heartbeat(e.position * 1000);
        }
      }
    } catch {
      /* heartbeat is best-effort */
    }
  });

  // Android: headphones unplugged → pause politely.
  TrackPlayer.addEventListener(Event.RemoteDuck, async (e) => {
    if (e.paused) await TrackPlayer.pause();
  });

  // A stale/expired stream URL failed to load → refresh & retry once;
  // if the fresh URL is dead too, move on instead of stalling forever.
  TrackPlayer.addEventListener(Event.PlaybackError, async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      const idx = await TrackPlayer.getActiveTrackIndex();
      if (idx == null) return;
      const current = await TrackPlayer.getTrack(idx);
      if (!current || current.source === 'itunes') return;
      // YOUTUBE SOURCE: re-resolve through the client ladder (module cache
      // invalidated first). Same contract as saavn recovery: fresh URL →
      // reload+play, else move on instead of stalling.
      const fresh =
        current.source === 'youtube'
          ? await ytRefreshStream(current as unknown as Track)
          : await refreshStreamUrl(current as unknown as Track);
      if (fresh) {
        await TrackPlayer.load({ ...current, url: fresh });
        await TrackPlayer.play();
      } else {
        await TrackPlayer.skipToNext().catch(() => undefined);
      }
    } catch {
      await TrackPlayer.skipToNext().catch(() => undefined);
    } finally {
      refreshing = false;
    }
  });

  // Queue finished → endless radio (Autoplay). Runs here — not in React —
  // so it survives the UI being killed. Radio v2: multi-seed, dedup-aware,
  // every pick explained; v2.1 single-artist radio is the fallback ladder.
  TrackPlayer.addEventListener(Event.PlaybackQueueEnded, async () => {
    // THE TEN F2 — the queue ended mid-fade: release the ramp so the
    // next session never starts silently (the bus restores the product).
    resetCrossfadeRamp();
    if (extending) return;
    extending = true;
    try {
      const autoplay = await getAutoplay();
      if (!autoplay) return;
      const rntpQueue = (await TrackPlayer.getQueue()) as unknown as Track[];
      const seed =
        [...rntpQueue].reverse().find((t) => !t.isRecommended && t.source === 'saavn') ??
        rntpQueue[rntpQueue.length - 1];
      if (!seed) return;

      // STATION_ENDED when a previous station session closes out (§5.1).
      if (radioServedCount > 0 && radioListenRatios.length) {
        const avg = radioListenRatios.reduce((a, b) => a + b, 0) / radioListenRatios.length;
        await mindbeat.ledgerApi?.stationEnded(radioServedCount, avg);
        radioServedCount = 0;
        radioListenRatios = [];
      }

      let radioTracks: Track[] = [];
      try {
        radioTracks = await mindbeat.radio(seed, 10);
      } catch {
        /* fall through to v2.1 radio */
      }
      if (!radioTracks.length) {
        radioTracks = await getRadio(seed, 10);
      }

      const existing = new Set(rntpQueue.map((t) => t.id));
      const fresh = radioTracks
        .filter((t) => !existing.has(t.id))
        .map((t) => ({ ...t, isRecommended: true }));
      if (!fresh.length) return;

      const playable = fresh
        .map((t) => {
          const url = resolveStreamUrl(t);
          if (!url) return null;
          return { ...(t as any), url };
        })
        .filter(Boolean);
      if (playable.length) {
        await TrackPlayer.add(playable as any);
        await TrackPlayer.play();
      }
    } catch {
      /* offline or API hiccup — stop silently, user can retry */
    } finally {
      extending = false;
    }
  });
}

export { resolveStreamUrl };
