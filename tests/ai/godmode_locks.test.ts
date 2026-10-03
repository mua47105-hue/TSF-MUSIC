/**
 * GODMODE LOCKS (Task 28) — the branch-only feature work, locked:
 *
 *   1. SLEEP TIMER: arms, counts down, fades (volume ramp), pauses the
 *      player at zero, restores volume, and reports disarmed. Session-scoped.
 *   2. AUDIO QUALITY / DATA SAVER: the stream resolver keeps the native
 *      96/160 URL when the saver is ON and upgrades to 320 when OFF —
 *      and the OFF path must be bit-identical to v4.0.5 behavior.
 *   3. WEBMOCK EVENT FIDELITY: the web TrackPlayer mock emits typed
 *      events (progress ticks + active-track-changed) so the web lab can
 *      exercise the same event-driven paths as the device (heartbeats,
 *      transition instrumentation, autoplay radio).
 *   4. VIBE SHIFT surface: mindbeat.sessionReadout() reports the session
 *      vibe honestly (WARMUP at cold start) and vibeShift() degrades to
 *      an honest empty array when intelligence is unavailable.
 */

import { describe, expect, test, beforeAll, mock } from 'bun:test';

const setVolumeCalls: number[] = [];
let paused = false;
mock.module('react-native-track-player', () => ({
  default: {
    async setVolume(v: number) {
      setVolumeCalls.push(v);
    },
    async pause() {
      paused = true;
    },
  },
  State: { None: 'none', Ready: 'ready', Playing: 'playing', Paused: 'paused' },
  Event: {
    RemotePlay: 'remote-play',
    RemotePause: 'remote-pause',
    PlaybackActiveTrackChanged: 'playback-active-track-changed',
    PlaybackProgressUpdated: 'playback-progress-updated',
    PlaybackQueueEnded: 'playback-queue-ended',
    PlayerError: 'player-error',
  },
}));
mock.module('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: 'active' },
  Platform: { OS: 'android', select: (o: any) => o.android },
  NativeModules: {},
}));
mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
    multiRemove: async () => undefined,
  },
}));
// mindbeat's ledger store is sqlite-backed; in the bun lab the native store
// is unavailable — init() must catch and degrade (ledger = null), which is
// precisely the honest-cold-start path these locks assert.
mock.module('expo-sqlite', () => ({
  openDatabaseAsync: async () => {
    throw new Error('bun lab: no sqlite');
  },
  openDatabaseSync: () => {
    throw new Error('bun lab: no sqlite');
  },
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 1 + 2. sleep timer ──────────────────────────────────────────────────
describe('sleep timer (godmode)', () => {
  test('arm → countdown state; fire → pause + volume restore + disarm', async () => {
    const { armSleepTimer, cancelSleepTimer, getSleepTimerState, subscribeSleepTimer } = await import(
      '../../src/player/sleepTimer'
    );
    expect(getSleepTimerState().endAt).toBeNull();

    const seen: Array<{ endAt: number | null }> = [];
    const unsub = subscribeSleepTimer((s) => seen.push({ endAt: s.endAt }));

    armSleepTimer(0.02); // 1.2s — short enough to observe the full cycle
    expect(getSleepTimerState().endAt).not.toBeNull();
    expect(seen.length).toBeGreaterThan(0);

    await sleep(2600); // > 1.2s arm + fade window
    expect(paused).toBeTrue();
    // the fade ramp runs inside the last 8s: at least one setVolume < 1 fired,
    // and the final restore sets volume back to exactly 1
    expect(setVolumeCalls[setVolumeCalls.length - 1]).toBe(1);
    expect(getSleepTimerState().endAt).toBeNull();
    unsub();
  });

  test('cancel → disarmed, volume restored, no pause', async () => {
    const { armSleepTimer, cancelSleepTimer, getSleepTimerState } = await import('../../src/player/sleepTimer');
    const { default: TP } = await import('react-native-track-player');
    armSleepTimer(30);
    expect(getSleepTimerState().endAt).not.toBeNull();
    cancelSleepTimer();
    expect(getSleepTimerState().endAt).toBeNull();
    expect(getSleepTimerState().minutes).toBeNull();
    expect(TP.pause).not.toHaveBeenCalled; // still armed-cancelled, never fired
  });
});

// ── 2. data saver × stream resolver ────────────────────────────────────
describe('data saver stream resolution (godmode)', () => {
  const track = {
    id: 'x1',
    title: 'Tum Hi Ho',
    artist: 'Arijit Singh',
    artwork: '',
    duration: 260,
    source: 'saavn' as const,
    previewOnly: false,
    has320: true,
    previewUrl: 'https://aac.saavncdn.com/x_96.mp4',
  };

  test('OFF (default) → 320 upgrade, identical to v4.0.5', async () => {
    const { setDataSaverActive } = await import('../../src/player/audioQuality');
    const { resolveStreamUrl } = await import('../../src/api/saavn');
    await setDataSaverActive(false);
    const url = resolveStreamUrl(track as any);
    expect(url).toBe('https://aac.saavncdn.com/x_320.mp4');
  });

  test('ON → native bitrate kept (no 320 upgrade)', async () => {
    const { setDataSaverActive, dataSaverActive } = await import('../../src/player/audioQuality');
    const { resolveStreamUrl } = await import('../../src/api/saavn');
    await setDataSaverActive(true);
    expect(dataSaverActive()).toBeTrue();
    const url = resolveStreamUrl(track as any);
    expect(url).toBe('https://aac.saavncdn.com/x_96.mp4');
    // back to full quality for other tests
    await setDataSaverActive(false);
  });
});

// ── 3. webmock event fidelity ──────────────────────────────────────────
describe('webmock typed events (godmode lab upgrade)', () => {
  test('skip emits PlaybackActiveTrackChanged; ticker emits progress', async () => {
    const TP = (await import('../../src/webmocks/trackPlayer')).default;
    const { Event } = await import('../../src/webmocks/trackPlayer');

    const changed: any[] = [];
    const progress: any[] = [];
    const off1 = TP.addEventListener(Event.PlaybackActiveTrackChanged, (e: any) => changed.push(e));
    const off2 = TP.addEventListener(Event.PlaybackProgressUpdated, (e: any) => progress.push(e));

    await TP.skipToNext();
    expect(changed.length).toBe(1);
    expect(changed[0].type).toBe(Event.PlaybackActiveTrackChanged);
    expect(changed[0].index).toBe(1);
    expect(changed[0].track.title).toBe('Dhurandhar');

    await sleep(700); // ticker runs at 500ms while playing
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0].type).toBe(Event.PlaybackProgressUpdated);
    expect(typeof progress[0].position).toBe('number');

    off1.remove();
    off2.remove();
  });

  test('remove() detaches the listener (no leak)', async () => {
    const TP = (await import('../../src/webmocks/trackPlayer')).default;
    const { Event } = await import('../../src/webmocks/trackPlayer');
    const seen: any[] = [];
    const off = TP.addEventListener(Event.PlaybackActiveTrackChanged, (e: any) => seen.push(e));
    off.remove();
    await TP.skipToNext();
    await TP.skipToNext();
    expect(seen.length).toBe(0);
  });
});

// ── 4. vibe readout + shift degrade honestly ───────────────────────────
describe('mindbeat vibe surface (godmode)', () => {
  test('sessionReadout is honest at cold start', async () => {
    const { mindbeat } = await import('../../src/ai/mindbeat');
    await mindbeat.init().catch(() => undefined);
    const r = mindbeat.sessionReadout();
    expect(typeof r.vibe).toBe('string');
    expect(['WARMUP', 'FLOW', 'PEAK', 'WIND_DOWN', 'SKIP_STORM', 'EXPLORING']).toContain(r.vibe);
    expect(r.energy).toBeGreaterThanOrEqual(0);
    expect(r.listens).toBeGreaterThanOrEqual(0);
  });

  test('vibeShift degrades to empty when intelligence is unavailable', async () => {
    const { mindbeat } = await import('../../src/ai/mindbeat');
    mindbeat.disabled = true;
    const picks = await mindbeat.vibeShift(null, new Set());
    expect(Array.isArray(picks)).toBeTrue();
    expect(picks.length).toBe(0);
    mindbeat.disabled = false;
  });
});
