/**
 * MAGNUM OPUS WAVE 1 · F1 — PREWARM LOCKS.
 *
 * The bar (mission): prewarmStrategy is the pure contract —
 *   offline / dataSaver+cellular → NO prewarm; dataSaver+WiFi → next 2;
 *   normal → next 2. A prewarmed URL consumed within 30s saves ≥500ms
 *   vs a fresh resolve (measured here with a 600ms fake resolver).
 * Plus the runtime discipline: single-use store, TTL discard, LRU cap,
 * no re-prime on the same active id (seek safety), reset on queue change,
 * and the production wiring evidence (provider + service + buildPlayable).
 */

import { describe, expect, test, beforeEach, mock } from 'bun:test';

mock.module('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: 'active' },
  Platform: { OS: 'android', select: (o: any) => o.android, Version: 34 },
  NativeModules: {},
}));
mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
    multiRemove: async () => undefined,
    multiGet: async () => [],
  },
}));

import {
  prewarmStrategy,
  needsPrewarm,
  primePrewarm,
  takePrewarmed,
  consumePrewarm,
  resetPrewarm,
  resetPrewarmForTests,
  prewarmSize,
  setPrewarmResolverForTests,
  type NetworkKind,
} from '../src/player/prewarm';
import { PREWARM } from '../src/ai/core/constants';
import type { Track } from '../src/types';

function row(id: string, over: Partial<Track> = {}): Track {
  return {
    id,
    title: `t-${id}`,
    artist: 'a',
    artwork: '',
    duration: 180,
    source: 'saavn',
    ...over,
  } as Track;
}

function queue(n: number, over: Partial<Track> = {}): Track[] {
  return Array.from({ length: n }, (_, i) => row(`q${i}`, over));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  resetPrewarmForTests();
});

describe('F1 · prewarmStrategy (pure bar contract)', () => {
  test('offline → no prewarm (regardless of data saver)', () => {
    const q = queue(6);
    expect(prewarmStrategy(q, 0, false, 'none')).toEqual([]);
    expect(prewarmStrategy(q, 0, true, 'none')).toEqual([]);
  });

  test('dataSaver + cellular → no prewarm', () => {
    expect(prewarmStrategy(queue(6), 0, true, 'cellular')).toEqual([]);
  });

  test('dataSaver + WiFi → next 2', () => {
    expect(prewarmStrategy(queue(6), 0, true, 'wifi')).toEqual(['q1', 'q2']);
  });

  test('normal (no saver) → next 2 on any live network', () => {
    expect(prewarmStrategy(queue(6), 0, false, 'wifi')).toEqual(['q1', 'q2']);
    expect(prewarmStrategy(queue(6), 0, false, 'cellular')).toEqual(['q1', 'q2']);
    // the runtime answer ('unknown') without the saver also rides
    expect(prewarmStrategy(queue(6), 0, false, 'unknown')).toEqual(['q1', 'q2']);
  });

  test('short tail: strategy returns only what exists, never duplicates', () => {
    const q = queue(3);
    expect(prewarmStrategy(q, 1, false, 'wifi')).toEqual(['q2']);
    expect(prewarmStrategy(q, 2, false, 'wifi')).toEqual([]);
    expect(prewarmStrategy(q, -1, false, 'wifi')).toEqual([]);
    expect(prewarmStrategy(q, 99, false, 'wifi')).toEqual([]);
  });
});

describe('F1 · needsPrewarm (what is worth parking)', () => {
  test('a downloaded row never prewarms', () => {
    expect(needsPrewarm(row('d', { localUri: 'file:///x.mp4' }))).toBe(false);
  });

  test('youtube rows always prewarm — their URLs rot between build and transition', () => {
    expect(needsPrewarm(row('y', { source: 'youtube' }))).toBe(true);
    expect(needsPrewarm(row('y', { source: 'youtube', streamUrl: 'https://old.googlevideo.com/v' }))).toBe(true);
  });

  test('saavn rows with a sync-resolvable URL do not prewarm; URL-less rows do (rescue)', () => {
    // NOTE: a decryptable encryptedUrl can't be fabricated honestly in a
    // fixture (DES-ECB under the provider key) — the previewUrl fallback
    // exercises the same sync-resolve branch in resolveStreamUrl.
    expect(needsPrewarm(row('s', { previewUrl: 'https://prev' }))).toBe(false);
    expect(needsPrewarm(row('s', { encryptedUrl: 'garbage-not-decryptable', previewUrl: 'https://prev' }))).toBe(false);
    expect(needsPrewarm(row('s', {}))).toBe(true); // ledger/crate row → rescue path
  });
});

describe('F1 · runtime store (park / consume / expire / cap)', () => {
  test('BAR: prewarmed URL consumed within 30s saves ≥500ms vs fresh resolve', async () => {
    const FRESH_MS = 600;
    let inflight = 0;
    setPrewarmResolverForTests(async (t) => {
      inflight += 1;
      await sleep(FRESH_MS);
      return { url: `https://fresh/${t.id}.m4a` };
    });
    const q = queue(3);
    const t0 = Date.now();
    primePrewarm(q, 0); // parks q1, q2 with a 600ms fake ladder
    await sleep(FRESH_MS + 80); // the resolve settles long before N ends
    const parked = takePrewarmed('q1');
    expect(parked).not.toBeNull();
    const got = await parked!;
    const consumeMs = Date.now() - (t0 + FRESH_MS + 80);
    expect(got?.url).toBe('https://fresh/q1.m4a');
    expect(consumeMs).toBeLessThan(50); // effectively instant
    const freshMs = FRESH_MS; // what a cold resolve would have cost
    expect(freshMs - consumeMs).toBeGreaterThanOrEqual(PREWARM.minSavedMs);
    expect(inflight).toBe(2); // exactly the strategy window, no more
  });

  test('single-use: a consumed entry is gone', async () => {
    setPrewarmResolverForTests(async (t) => ({ url: `u/${t.id}` }));
    const q = queue(3);
    primePrewarm(q, 0);
    const first = takePrewarmed('q1');
    expect(first).not.toBeNull();
    expect(await first!).not.toBeNull();
    expect(takePrewarmed('q1')).toBeNull();
  });

  test('TTL: a parked URL past 30s is discarded, never handed to the player', async () => {
    setPrewarmResolverForTests(async (t) => ({ url: `u/${t.id}` }));
    const q = queue(3);
    primePrewarm(q, 0);
    const parked = takePrewarmed('q1', Date.now() + PREWARM.ttlMs + 1);
    expect(parked).toBeNull();
  });

  test('LRU cap: the store never exceeds PREWARM.cap entries', () => {
    setPrewarmResolverForTests(async (t) => ({ url: `u/${t.id}` }));
    const q = queue(12);
    for (let i = 0; i < 10; i++) primePrewarm(q, i); // walk the queue
    expect(prewarmSize()).toBeLessThanOrEqual(PREWARM.cap);
  });

  test('seek safety: consuming then re-priming the same active id never re-resolves', async () => {
    // BLIND-CRITIC M4 RELOCK: the original probe stayed green with the
    // guard removed (the store.has() dedupe masked it). The honest
    // probe CONSUMES the parked entries between primes — exactly the
    // double-resolve the guard exists to prevent.
    let calls = 0;
    setPrewarmResolverForTests(async (t) => {
      calls += 1;
      return { url: `u/${t.id}` };
    });
    const q = queue(6);
    primePrewarm(q, 0);
    expect(calls).toBe(2); // ahead window
    // consume everything parked (the rebuild/seek-window scenario)
    for (const id of prewarmStrategy(q, 0, false, 'wifi')) await takePrewarmed(id);
    expect(calls).toBe(2);
    primePrewarm(q, 0); // SAME active id — a seek/re-render, not a transition
    expect(calls).toBe(2); // MUTATION HERE (remove primedForId) → 4 → RED
    primePrewarm(q, 0);
    expect(calls).toBe(2);
  });

  test('a REAL transition (new active id) primes again after consumption', async () => {
    let calls = 0;
    setPrewarmResolverForTests(async (t) => {
      calls += 1;
      return { url: `u/${t.id}` };
    });
    const q = queue(6);
    primePrewarm(q, 0);
    for (const id of prewarmStrategy(q, 0, false, 'wifi')) await takePrewarmed(id);
    primePrewarm(q, 1); // the track changed — priming is correct here
    expect(calls).toBe(4); // 2 + 2 (q2 re-parked? no — q2 was consumed, so yes)
  });

  test('queue change: resetPrewarm drops everything', async () => {
    setPrewarmResolverForTests(async (t) => ({ url: `u/${t.id}` }));
    primePrewarm(queue(4), 0);
    expect(prewarmSize()).toBeGreaterThan(0);
    resetPrewarm();
    expect(prewarmSize()).toBe(0);
    expect(takePrewarmed('q1')).toBeNull();
  });

  test('buildPlayable contract: consumePrewarm returns null when nothing is parked', async () => {
    expect(await consumePrewarm(row('nothing'))).toBeNull();
  });
});

describe('F1 · production wiring evidence (BAR X7c)', () => {
  const { readFileSync } = require('node:fs');
  const read = (p: string) => readFileSync(`${import.meta.dir}/../${p}`, 'utf8');

  test('PlayerProvider primes on track change, resets on queue change, consumes in buildPlayable', () => {
    const src = read('src/player/PlayerProvider.tsx');
    expect(src).toContain("from './prewarm'");
    expect(src).toContain('primePrewarm(q, idx)');
    expect(src).toContain('resetPrewarm()');
    expect(src).toContain('await consumePrewarm(t)');
  });

  test('BLIND-CRITIC M20 RELOCK: the YT batch consumes prewarm AND the per-row selection prefers it over the stale build-time URL', () => {
    const src = read('src/player/PlayerProvider.tsx');
    // the YT batch loop consumes the parked URL…
    expect(src).toMatch(/const pre = await consumePrewarm\(t\);\s*\n\s*const url = pre\?\.url \?\? t\.streamUrl/);
    // …and the per-row selection reads the batch map BEFORE streamUrl
    // (the P1-1 bug: parked URL consumed then discarded for the stale one)
    expect(src).toContain('? ytUrls.get(t.id) || t.streamUrl || null');
    expect(src).not.toContain('? t.streamUrl || ytUrls.get(t.id)');
  });

  test('BLIND-CRITIC P2-b RELOCK: priming fires only on a real transition, never on the first active-set', () => {
    const src = read('src/player/PlayerProvider.tsx');
    // the prime call must sit behind the prevId (real-transition) gate
    expect(src).toMatch(/if \(prevId\) void primeWave1\(active\.id\)/);
    expect(src).not.toMatch(/void primeWave1\(active\.id\); \/\/ [^\n]*hot path/);
  });

  test('the background service primes headless transitions too', () => {
    const src = read('src/player/service.ts');
    expect(src).toContain("from './prewarm'");
    expect(src).toContain('primePrewarm(q, idx)');
  });
});
