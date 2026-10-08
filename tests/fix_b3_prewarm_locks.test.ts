/**
 * v5.0.1 FIX-B3 — REAL NETWORK KIND + QUEUE FINGERPRINT LOCKS.
 *
 * The auditor's two P2s on F3: the runtime fed the pure gate a literal
 * 'unknown' (so the WiFi/cellular contract was dead in production), and
 * a queue change under the SAME active track never re-primed. The fix:
 * expo-network (the round's one new dependency, lazy-required) feeds a
 * cached real kind; the prime key is now (active id, queue
 * fingerprint) and a fingerprint change invalidates the warmed set.
 *
 * The pure gate's contract is untouched — these locks prove the
 * RUNTIME finally honors it.
 */

import { describe, expect, test, beforeEach, mock } from 'bun:test';

mock.module('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: 'active' },
  Platform: { OS: 'android', select: (o: any) => o.android, Version: 34 },
  NativeModules: {},
  Image: { prefetch: async () => true },
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
  currentNetworkKind,
  imagePrewarmSize,
  primeImagePrewarm,
  queueFingerprintOf,
  refreshNetworkKind,
  resetImagePrewarmForTests,
  setImagePrefetcherForTests,
  setNetworkKindForTests,
} from '../src/player/imagePrewarm';
import { setDataSaverActive } from '../src/player/audioQuality';
import { IMAGE_PREWARM } from '../src/ai/core/constants';
import type { Track } from '../src/types';

function row(i: number, art?: string): Track {
  return {
    id: `q${i}`,
    title: `t${i}`,
    artist: 'a',
    artwork: art ?? `https://art/${i}.jpg`,
    duration: 180,
    source: 'saavn',
  } as Track;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  resetImagePrewarmForTests();
  setDataSaverActive(false);
});

describe('FIX-B3 · the network kind is real (injectable production source)', () => {
  test('dataSaver + cellular → ZERO primes (the dead branch is alive at runtime)', async () => {
    setNetworkKindForTests('cellular');
    await setDataSaverActive(true);
    const fired: string[] = [];
    setImagePrefetcherForTests(async (uri) => {
      fired.push(uri);
      return true;
    });
    const q = Array.from({ length: 10 }, (_, i) => row(i));
    primeImagePrewarm(q, 0);
    await sleep(10);
    expect(fired).toEqual([]); // the auditor's dead contract, now enforced end-to-end
    expect(imagePrewarmSize()).toBe(0);
  });

  test('dataSaver + wifi → the full ahead list primes', async () => {
    setNetworkKindForTests('wifi');
    await setDataSaverActive(true);
    const fired: string[] = [];
    setImagePrefetcherForTests(async (uri) => {
      fired.push(uri);
      return true;
    });
    const q = Array.from({ length: 10 }, (_, i) => row(i));
    primeImagePrewarm(q, 0);
    await sleep(10);
    expect(fired).toHaveLength(IMAGE_PREWARM.ahead);
  });

  test('offline (none) → zero primes at runtime', async () => {
    setNetworkKindForTests('none');
    const fired: string[] = [];
    setImagePrefetcherForTests(async (uri) => {
      fired.push(uri);
      return true;
    });
    const q = Array.from({ length: 10 }, (_, i) => row(i));
    primeImagePrewarm(q, 0);
    await sleep(10);
    expect(fired).toEqual([]);
  });

  test('refreshNetworkKind degrades honestly when the native module is absent (never throws, kind stays unknown)', async () => {
    setNetworkKindForTests(null); // exercise the production source path
    // This file registers no expo-network mock of its own. ALONE, the
    // lazy require fails (the real package is native-only under bun) →
    // the honest-degradation branch. After the sibling mapping suite
    // runs, its v5.0.2 cleanup leaves the honest-unknown surface —
    // either way the kind must land 'unknown', never a fabricated wifi.
    await refreshNetworkKind(true);
    expect(currentNetworkKind()).toBe('unknown');
  });
});

describe('FIX-B3 · the queue fingerprint invalidates under the same active track', () => {
  test('changing the queue under the SAME active track re-primes the new art', async () => {
    setNetworkKindForTests('wifi');
    const fired: string[] = [];
    setImagePrefetcherForTests(async (uri) => {
      fired.push(uri);
      return true;
    });
    const q = Array.from({ length: 10 }, (_, i) => row(i));
    primeImagePrewarm(q, 0);
    await sleep(10);
    expect(fired).toHaveLength(IMAGE_PREWARM.ahead);
    // the queue changes UNDER the same active track (a row is inserted
    // ahead): the old warmed set is stale — the new next-5 must prime.
    const q2 = [row(0), row(90), ...q.slice(1)];
    primeImagePrewarm(q2, 0);
    await sleep(10);
    expect(fired).toContain('https://art/90.jpg'); // the newcomer was warmed
    expect(fired.filter((u) => u === 'https://art/90.jpg')).toHaveLength(1);
  });

  test('a pure seek (same track, same queue) still never re-warms (the F1 key survives)', async () => {
    setNetworkKindForTests('wifi');
    const fired: string[] = [];
    setImagePrefetcherForTests(async (uri) => {
      fired.push(uri);
      return true;
    });
    const q = Array.from({ length: 10 }, (_, i) => row(i));
    primeImagePrewarm(q, 0);
    await sleep(10);
    const first = fired.length;
    primeImagePrewarm(q, 0); // same id, same fingerprint
    await sleep(10);
    expect(fired.length).toBe(first);
  });

  test('the fingerprint is order-sensitive and deterministic (FNV-1a over ids, no Math.random)', () => {
    const a = Array.from({ length: 5 }, (_, i) => row(i));
    const b = [row(1), row(0), row(2), row(3), row(4)]; // reordered
    expect(queueFingerprintOf(a)).toBe(queueFingerprintOf([...a])); // stable
    expect(queueFingerprintOf(a)).not.toBe(queueFingerprintOf(b)); // order moves it
    expect(queueFingerprintOf([row(0), row(1)])).not.toBe(queueFingerprintOf([row(0), row(1), row(2)])); // append moves it
    expect(queueFingerprintOf([])).toBe(queueFingerprintOf([]));
  });
});
