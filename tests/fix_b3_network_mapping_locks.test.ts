/**
 * v5.0.1 FIX-B3 · THE NETWORK MAPPING LOCKS (the critic's BLUE M6).
 *
 * The production type→kind mapping inside refreshNetworkKind was pinned
 * by no test — a flipped CELLULAR→'wifi' branch (a data-saver-breaking
 * lie) passed the whole 850-test suite. This file mocks expo-network
 * (the lazy require resolves the mock at refresh time) and pins the
 * mapping, the failure latches, and the PlayerProvider wiring.
 *
 * v5.0.2 FIX 1 — MOCK HYGIENE (the P0 ship-blocker): bun's mock.module
 * is PROCESS-GLOBAL, so this file's expo-network fake used to leak into
 * fix_b3_prewarm_locks.test.ts (alphabetically later, same process)
 * whose degradation test consumes the module's honest failure — the
 * leaked fake fed it a WIFI answer and turned CI red at the v5.0.1
 * tag. Scoping mechanism (verified empirically on bun 1.3.14):
 * mock.restore() does NOT unwind module mocks, but RE-REGISTERING a
 * module mock replaces it — so afterAll swaps the fake for the
 * honest-unknown surface the web build itself resolves.
 */

import { describe, expect, test, beforeEach, afterAll, mock } from 'bun:test';

let networkState: { type?: string; isConnected?: boolean } = { type: 'WIFI' };
let stateThrows = false;

mock.module('expo-network', () => ({
  getNetworkStateAsync: async () => {
    if (stateThrows) throw new Error('injected: transient native hiccup');
    return networkState;
  },
}));

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

import { currentNetworkKind, refreshNetworkKind, resetImagePrewarmForTests } from '../src/player/imagePrewarm';
import { IMAGE_PREWARM } from '../src/ai/core/constants';

beforeEach(() => {
  resetImagePrewarmForTests();
  networkState = { type: 'WIFI' };
  stateThrows = false;
});

describe('FIX-B3 · the expo-network mapping is the honest one (locked)', () => {
  test('WIFI → wifi', async () => {
    networkState = { type: 'WIFI' };
    await refreshNetworkKind(true);
    expect(currentNetworkKind()).toBe('wifi');
  });
  test('CELLULAR → cellular (the data-saver contract lives or dies here)', async () => {
    networkState = { type: 'CELLULAR' };
    await refreshNetworkKind(true);
    expect(currentNetworkKind()).toBe('cellular');
  });
  test('MOBILE (the Android alias) → cellular', async () => {
    networkState = { type: 'MOBILE' };
    await refreshNetworkKind(true);
    expect(currentNetworkKind()).toBe('cellular');
  });
  test('NONE → none', async () => {
    networkState = { type: 'NONE' };
    await refreshNetworkKind(true);
    expect(currentNetworkKind()).toBe('none');
  });
  test('an unrecognized type → unknown (never a fabricated wifi)', async () => {
    networkState = { type: 'VPN' };
    await refreshNetworkKind(true);
    expect(currentNetworkKind()).toBe('unknown');
  });
  test('a TRANSIENT state failure does not latch the session (critic P2d) — the kind stays and retries later', async () => {
    networkState = { type: 'WIFI' };
    await refreshNetworkKind(true);
    expect(currentNetworkKind()).toBe('wifi');
    stateThrows = true;
    await refreshNetworkKind(true);
    expect(currentNetworkKind()).toBe('wifi'); // kept — NOT latched to unknown
  });
  test('the refresh throttle is IMAGE_PREWARM.netRefreshMs (a pinned literal)', () => {
    expect(IMAGE_PREWARM.netRefreshMs).toBe(30_000);
  });
  test('the provider wires the boot refresh (FIX-B3 wiring evidence)', () => {
    const src = require('node:fs').readFileSync('src/player/PlayerProvider.tsx', 'utf8');
    expect(src).toContain("import { primeImagePrewarm, refreshNetworkKind } from './imagePrewarm'");
    expect(src).toContain('void refreshNetworkKind(true)');
  });

  // v5.0.2 FIX 1 (the P0 ship-blocker): scope the expo-network fake to
  // this file. Verified on bun 1.3.14: mock.restore() is a NO-OP for
  // module mocks (the cached fake stays live process-global), but a
  // fresh mock.module() REPLACES the old registration — so afterAll
  // swaps the fake for the honest-unknown surface (exactly what the
  // web build resolves via src/webmocks/network.ts). The sibling
  // degradation test then reads an honest 'unknown' in every file
  // order; deleting this cleanup re-leaks the WIFI fake and turns it
  // RED (mutation-proven).
  afterAll(() => {
    mock.module('expo-network', () => ({
      getNetworkStateAsync: async () => ({ type: 'unknown', isConnected: false, isInternetReachable: false }),
    }));
  });
});
