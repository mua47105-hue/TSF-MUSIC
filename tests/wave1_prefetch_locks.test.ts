/**
 * MAGNUM OPUS WAVE 1 · F2 — SEARCH PREFETCH LOCKS.
 *
 * The bar (mission): prefetch at 3+ chars, cancel on empty/clear, cache
 * hit returns in <50ms; removing the prefetch leaves typeahead working
 * but 700ms slower (the debounce path is untouched — locked here by the
 * gate being additive, not a replacement). Single-owner discipline: the
 * prefetch ALWAYS reaches the engine with learning disabled (house rule
 * ③). Abort discipline: a newer generation aborts the older one; the
 * real search never does (it rides the same in-flight job).
 *
 * The <50ms integration lock runs the REAL orchestrator over a stubbed
 * global fetch (30ms latency) — the same seam search_sig_e2e uses —
 * proving prefetch → LRU-200 → instant answer end to end.
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach, mock } from 'bun:test';

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
  shouldPrefetch,
  prefetchDeps,
  prefetchSearch,
  cancelPrefetch,
  prefetchInFlight,
  setSearchEngineForTests,
  type SearchEngine,
} from '../src/search/prefetch';
import { SEARCH_PREFETCH } from '../src/ai/core/constants';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  setSearchEngineForTests(null);
  cancelPrefetch();
});

describe('F2 · shouldPrefetch (the gate)', () => {
  test('fires from 3 characters (trimmed)', () => {
    expect(shouldPrefetch('ab')).toBe(false);
    expect(shouldPrefetch('abc')).toBe(true);
    expect(shouldPrefetch('  abc  ')).toBe(true);
    expect(shouldPrefetch('')).toBe(false);
    expect(shouldPrefetch('   ')).toBe(false);
  });
});

describe('F2 · prefetchDeps (single-owner discipline)', () => {
  test('learning is ALWAYS disabled in the prefetch deps', () => {
    expect(prefetchDeps().disabled()).toBe(true);
    expect(prefetchDeps({ disabled: () => false } as any).disabled()).toBe(true);
  });

  test('kv plumbing passes through when real deps exist (lexicon restore stays honest)', async () => {
    const real = { kvGet: async () => 'snapshot', kvSet: () => undefined } as any;
    expect(await prefetchDeps(real).kvGet!('x')).toBe('snapshot');
  });

  test('crash-proof fallback when no real deps exist (initSearchEngine calls kvGet non-optionally)', async () => {
    const d = prefetchDeps();
    expect(await d.kvGet!('x')).toBeNull();
    expect(() => d.kvSet!('x', 1)).not.toThrow();
  });
});

describe('F2 · generation discipline (injected engine)', () => {
  const calls: Array<{ q: string; signal: AbortSignal; deps: any }> = [];
  const recorder: SearchEngine = (async (q: string, opts: any) => {
    calls.push({ q, signal: opts.signal, deps: opts.deps });
    return { tracks: [], degraded: false, latencyMs: 0 } as any;
  }) as unknown as SearchEngine;

  beforeEach(() => {
    calls.length = 0;
    setSearchEngineForTests(recorder);
  });

  test('fires once per query with disabled learning', async () => {
    prefetchSearch('tere bin');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.deps.disabled()).toBe(true);
    expect(calls[0]!.signal.aborted).toBe(false);
  });

  test('no double-fire while the same query is already flying', () => {
    prefetchSearch('tere bin');
    prefetchSearch('tere bin');
    prefetchSearch('tere bin');
    expect(calls).toHaveLength(1);
  });

  test('a newer prefetch aborts the older generation', () => {
    prefetchSearch('tere bin');
    const first = calls[0]!.signal;
    prefetchSearch('tere bintu');
    expect(calls).toHaveLength(2);
    expect(first.aborted).toBe(true);
    expect(calls[1]!.signal.aborted).toBe(false);
  });

  test('cancel on clear, and an edited-away-and-back query re-fires honestly', () => {
    prefetchSearch('tere bin');
    expect(prefetchInFlight()).toBe(true);
    cancelPrefetch();
    expect(prefetchInFlight()).toBe(false);
    expect(calls[0]!.signal.aborted).toBe(true);
    prefetchSearch('tere bin'); // "edited away and back"
    expect(calls).toHaveLength(2);
  });

  test('below the gate nothing fires', () => {
    prefetchSearch('ab');
    expect(calls).toHaveLength(0);
    expect(prefetchInFlight()).toBe(false);
  });
});

describe('F2 · BAR: prefetched query answers <50ms (real orchestrator, stubbed fetch)', () => {
  const PRISTINE_FETCH = globalThis.fetch;

  function saavnRow(id: string, title: string) {
    return {
      id,
      title,
      more_info: {
        encrypted_media_url: 'enc-' + id,
        '320kbps': 'true',
        language: 'hindi',
        year: '2020',
        artistMap: { primary_artists: [{ name: 'Atif Aslam' }], featured_artists: [] },
      },
      play_count: '1000',
    };
  }

  const SEARCH_BODY = {
    results: Array.from({ length: 8 }, (_, i) => saavnRow(`tb-${i}`, 'Tere Bin')),
  };

  beforeAll(() => {
    const impl = async (url: any) => {
      await sleep(30); // fake provider latency
      return new Response(JSON.stringify(SEARCH_BODY), { status: 200 });
    };
    (globalThis as any).fetch = impl as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = PRISTINE_FETCH;
  });

  test('prefetch warms the LRU-200; the real search answers from cache inside the budget', async () => {
    const { clearSearchCaches } = await import('../src/search/retrieve');
    const { searchMusicV2 } = await import('../src/api/music');
    clearSearchCaches();

    prefetchSearch('tere bin'); // the hook's fire-at-3-chars moment
    await sleep(320); // the fake provider (30ms × pipeline) settles
    expect(prefetchInFlight()).toBe(false); // engine promise is fire-and-forget

    const t0 = performance.now();
    const res = await searchMusicV2('tere bin');
    const hitMs = performance.now() - t0;
    expect(res.tracks.length).toBeGreaterThan(0); // real ranked rows
    expect(hitMs).toBeLessThan(SEARCH_PREFETCH.hitBudgetMs); // the BAR
  });

  test('without the prefetch, the same query pays the provider latency (the 700ms-class path)', async () => {
    const { clearSearchCaches } = await import('../src/search/retrieve');
    const { searchMusicV2 } = await import('../src/api/music');
    clearSearchCaches();

    const t0 = performance.now();
    await searchMusicV2('tere bin');
    const coldMs = performance.now() - t0;
    expect(coldMs).toBeGreaterThanOrEqual(30); // the cold path (mutation mirror)
  });
});
