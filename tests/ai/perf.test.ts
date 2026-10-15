/**
 * §10.3 — Performance budget tests (mid-range Android is the target).
 *
 * The sandbox box is faster than a mid-range phone, so passing here must
 * come with margin: every budget asserts the plan number AND prints the
 * actual so regressions are visible. Budgets:
 *
 *   • Decision Engine query      < 150 ms p95 (post-candidates, in-memory)
 *   • Profile read + decay       < 50 ms
 *   • Profile rebuild (90d)      < 3 s
 *   • Co-play neighbor lookup    < 20 ms
 *   • Ledger write (batched)     < 10 ms amortized
 */

import { describe, expect, test, afterAll, mock } from 'bun:test';
import { rnMockSurface } from '../helpers/rnMockSurface';

// v5.2.1 FIX-C4 — the init-slice budget needs the intelligence facade, and
// the facade needs the lab surfaces (no RN, no sqlite, no storage in bun).
// File-scoped mocks, restored at afterAll (the C5 leak law).
mock.module('react-native', () => rnMockSurface());
mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
    multiRemove: async () => undefined,
  },
}));
mock.module('expo-sqlite', () => ({
  openDatabaseAsync: async () => {
    throw new Error('bun lab: no sqlite');
  },
  openDatabaseSync: () => {
    throw new Error('bun lab: no sqlite');
  },
}));

import { buildProfile, topArtists } from '../../src/ai/core/profile';
import { decide, artistAffinity } from '../../src/ai/core/decision';
import { SessionBrain } from '../../src/ai/core/session';
import { EventLedger } from '../../src/ai/core/ledger';
import { createLedgerStore } from '../../src/ai/core/storeMemory';
import type { Candidate } from '../../src/ai/core/types';
import { ninetyDayLedger, listenOf, PROMPT_CORPUS } from './corpus';
import { PERF_BUDGETS } from '../../src/ai/core/constants';
import { generatePlaylistV2 } from '../../src/ai/surfaces/playlist';
import type { Track } from '../../src/types';

const NOW = 1750000000000;

afterAll(() => {
  mock.module('react-native', () => rnMockSurface()); // keep the surface complete for later files
});

function candidates(n: number): Candidate[] {
  const artists = ['arijit singh', 'shreya ghoshal', 'diljit dosanjh', 'eminem', 'new artist'];
  return Array.from({ length: n }, (_, i) => ({
    trackId: `perf-${i}`,
    artist: artists[i % artists.length]!,
    language: 'hindi',
    features: { energy: (i % 10) / 10, valence: 0.5, tempoClass: 'mid', confidence: 0.6, source: 'prior' },
    pool: (i % 5 === 0 ? 'affinity' : i % 5 === 1 ? 'neighborhood' : i % 5 === 2 ? 'daypart' : i % 5 === 3 ? 'cultural' : 'discovery') as Candidate['pool'],
  }));
}

describe('§10.3 performance budgets', () => {
  test('profile rebuild: 90-day ~20k-event ledger < 3 s', () => {
    const { listens, sessions } = ninetyDayLedger(); // 6120 listens, 180 sessions
    expect(listens.length).toBeGreaterThan(5000);
    // ~14k synthetic raw events to reach the 20k-event scale.
    const events = Array.from({ length: 14000 }, (_, i) => ({
      id: `pe-${i}`,
      ts: NOW - 90 * 86400_000 + i * 500_000,
      type: 'TRACK_HEARTBEAT' as const,
      sessionId: 's90-0',
      trackId: `t-${i}`,
      payload: { elapsedMs: i },
    }));
    const t0 = performance.now();
    const profile = buildProfile(listens, events, sessions, { now: NOW });
    const dt = performance.now() - t0;
    console.log(`[perf] profile rebuild: ${dt.toFixed(0)} ms for ${listens.length} listens + ${events.length} events`);
    expect(profile.sessionCount).toBe(180);
    expect(dt).toBeLessThan(PERF_BUDGETS.profileRebuildMs);
    // Margin check: a mid-range phone is ~3-5× slower than this box.
    expect(dt).toBeLessThan(1000);
  });

  test('decision engine: < 150 ms p95 over 40 queries (500 candidates)', () => {
    const { listens, sessions } = ninetyDayLedger();
    const profile = buildProfile(listens, [], sessions, { now: NOW });
    const brain = new SessionBrain(NOW);
    for (const l of listens.slice(-12)) brain.push(l);
    // v4.2.0 — the gate runs with the bandit arms + the full flow graph
    // attached (the new additive terms must ride INSIDE the same budget,
    // not outside it — ported idea from the parallel gauntlet line).
    const arms = new Map();
    const artistNames = ['arijit singh', 'shreya ghoshal', 'diljit dosanjh', 'eminem', 'new artist'];
    for (const a of artistNames) arms.set(`a:${a}`, { alpha: 3, beta: 2 });
    const flowProfile = { ...profile, flowTracks: { 'perf-0': Object.fromEntries(candidates(8).map((c) => [c.trackId, 0.5])) } };
    const deps = { profile: flowProfile, session: brain.state, now: NOW, banditArms: arms };
    const durations: number[] = [];
    for (let q = 0; q < 40; q++) {
      const t0 = performance.now();
      decide(candidates(500), {
        surface: 'smart_shuffle',
        block: 'evening',
        dayKind: 'weekday',
        seedTrackIds: ['x'],
        seedArtists: ['arijit singh'],
        requested: 12,
      }, deps);
      durations.push(performance.now() - t0);
    }
    durations.sort((a, b) => a - b);
    const p95 = durations[Math.floor(durations.length * 0.95)]!;
    const med = durations[Math.floor(durations.length / 2)]!;
    console.log(`[perf] decide(): median ${med.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms (500 candidates → 12 picks)`);
    expect(p95).toBeLessThan(PERF_BUDGETS.decisionQueryMs);
    expect(med).toBeLessThan(50);
  });

  test('profile read + decay: top-10 artists < 50 ms', () => {
    const { listens, sessions } = ninetyDayLedger();
    const profile = buildProfile(listens, [], sessions, { now: NOW });
    const t0 = performance.now();
    const top = topArtists(profile, NOW, 10);
    const dt = performance.now() - t0;
    console.log(`[perf] topArtists read: ${dt.toFixed(2)} ms → ${top.length} artists`);
    expect(top.length).toBe(10);
    expect(dt).toBeLessThan(PERF_BUDGETS.profileReadMs);
  });

  test('co-play neighbor lookup: < 20 ms', () => {
    const { listens, sessions } = ninetyDayLedger();
    const profile = buildProfile(listens, [], sessions, { now: NOW });
    const keys = Object.keys(profile.coplayArtists);
    expect(keys.length).toBeGreaterThan(0);
    const t0 = performance.now();
    let hits = 0;
    for (const k of keys) {
      const n = profile.coplayArtists[k]!;
      const top5 = Object.entries(n).sort((a, b) => b[1] - a[1]).slice(0, 5);
      if (top5.length) hits += 1;
    }
    const dt = performance.now() - t0;
    console.log(`[perf] coplay lookups: ${dt.toFixed(2)} ms for ${keys.length} artists (${hits} with neighbors)`);
    expect(dt).toBeLessThan(PERF_BUDGETS.coplayLookupMs);
  });

  test('ledger writes: batched chain amortizes < 10 ms', async () => {
    const store = await createLedgerStore();
    let now = NOW;
    const ledger = new EventLedger(store, () => now);
    await ledger.init();
    const t0 = performance.now();
    const N = 300;
    for (let i = 0; i < N; i++) {
      now += 1000;
      await ledger.heartbeat((i % 210) * 1000 + 1000);
    }
    const dt = (performance.now() - t0) / N;
    console.log(`[perf] ledger write: ${dt.toFixed(3)} ms amortized over ${N} heartbeats`);
    expect(dt).toBeLessThan(PERF_BUDGETS.ledgerWriteAmortizedMs);
  });

  test('artist affinity read is sub-millisecond (hot path)', () => {
    const { listens, sessions } = ninetyDayLedger();
    const profile = buildProfile(listens, [], sessions, { now: NOW });
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      artistAffinity(profile, 'arijit singh', NOW);
    }
    const per = (performance.now() - t0) / 1000;
    console.log(`[perf] artistAffinity: ${per.toFixed(4)} ms/call`);
    expect(per).toBeLessThan(0.1);
  });

  test('single-listen grading + append stays off the UI thread budget', async () => {
    const store = await createLedgerStore();
    let now = NOW;
    const ledger = new EventLedger(store, () => now);
    await ledger.init();
    await ledger.onAppActive();
    const t0 = performance.now();
    await ledger.trackStarted({
      trackId: 't-ui',
      artist: 'arijit singh',
      title: 'UI thread',
      durationMs: 210000,
      energy: 0.4,
      valence: 0.4,
      wasRecommended: false,
    }, 'user_queue');
    const dt = performance.now() - t0;
    console.log(`[perf] trackStarted: ${dt.toFixed(2)} ms`);
    expect(dt).toBeLessThan(10);
  });

  test('end-to-end scripted session through the ledger grades correctly', async () => {
    const store = await createLedgerStore();
    let now = NOW;
    const ledger = new EventLedger(store, () => now);
    await ledger.init();
    await ledger.onAppActive();
    // 5 tracks: 2 completed, 1 instant skip, 1 early skip, 1 completed.
    const script: Array<[string, number, boolean]> = [
      ['t-1', 210000, false],
      ['t-2', 205000, false],
      ['t-3', 3000, true],
      ['t-4', 15000, true],
      ['t-5', 210000, false],
    ];
    for (const [id, listened, skip] of script) {
      await ledger.trackStarted({
        trackId: id,
        artist: 'arijit singh',
        durationMs: 210000,
        energy: 0.4,
        valence: 0.4,
        wasRecommended: false,
      }, 'user_queue');
      await ledger.heartbeat(listened);
      if (skip) ledger.markPendingSkip();
      await ledger.finalizeTrack(skip, skip ? 'skip' : 'end');
      now += 240000;
    }
    const listens = await store.getlistens();
    const grades = listens.map((l) => l.grade);
    expect(grades).toContain('COMPLETED');
    expect(grades).toContain('INSTANT_REJECT');
    expect(grades).toContain('EARLY_SKIP');
    void listenOf;
  });

  // v5.2.1 FIX-C4 — the two budgets the audit found UNASSERTED. Both now
  // carry measured values, with their scope stated honestly:
  //  • aiPlaylistEndToEndMs — the full local generation pipeline (plan →
  //    hunt → verify → polish) really runs here, so the p95 ceiling is a
  //    true gate.
  //  • coldStartDeltaMs — in the bun lab only the SYNCHRONOUS JS slice of
  //    the intelligence init is measurable (sqlite is unavailable, so the
  //    native I/O share is absent); the full on-device boot is enforced by
  //    the E2E perf gate (scripts/e2e/parse_perf.py cold_start bar). This
  //    assertion is the cheap tripwire for the X6 law: init() gains
  //    nothing synchronous.
  test('AI playlist end-to-end: p95 < 10 s over the prompt corpus', async () => {
    const catalog = {
      async search(_q: string, limit = 20): Promise<Track[]> {
        return candidates(limit).map((c, i) => ({
          id: `e2e-${i}`,
          title: `Track ${i}`,
          artist: c.artist,
          artwork: '',
          duration: 210,
          source: 'saavn' as const,
          previewOnly: false,
        }));
      },
    };
    const prompts = PROMPT_CORPUS.slice(0, 8).map((p) => p.prompt);
    expect(prompts.length).toBeGreaterThanOrEqual(6);
    const durations: number[] = [];
    for (const prompt of prompts) {
      const t0 = performance.now();
      const result = await generatePlaylistV2(catalog as any, prompt);
      durations.push(performance.now() - t0);
      expect(result.tracks.length).toBeGreaterThan(0); // the pipeline actually produced music
    }
    durations.sort((a, b) => a - b);
    const p95 = durations[Math.floor(durations.length * 0.95)]!;
    console.log(`[perf] ai playlist e2e: p95 ${p95.toFixed(0)} ms over ${prompts.length} prompts`);
    expect(p95).toBeLessThan(PERF_BUDGETS.aiPlaylistEndToEndMs);
  });

  test('intelligence init slice: the synchronous JS work stays under the 80 ms budget', async () => {
    const { mindbeat } = await import('../../src/ai/mindbeat');
    const t0 = performance.now();
    await mindbeat.init().catch(() => undefined); // degrades honestly in the lab (no sqlite)
    const readout = mindbeat.sessionReadout(); // the first sync read must not pay a hidden rebuild
    const dt = performance.now() - t0;
    console.log(`[perf] mindbeat init slice (lab, no native io): ${dt.toFixed(1)} ms, vibe ${readout.vibe}`);
    expect(dt).toBeLessThan(PERF_BUDGETS.coldStartDeltaMs);
  });
});
