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

import { describe, expect, test } from 'bun:test';
import { buildProfile, topArtists } from '../../src/ai/core/profile';
import { decide, artistAffinity } from '../../src/ai/core/decision';
import { SessionBrain } from '../../src/ai/core/session';
import { EventLedger } from '../../src/ai/core/ledger';
import { createLedgerStore } from '../../src/ai/core/storeMemory';
import type { Candidate } from '../../src/ai/core/types';
import type { BanditArms } from '../../src/ai/core/bandit';
import { ninetyDayLedger, listenOf } from './corpus';

const NOW = 1750000000000;

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
    expect(dt).toBeLessThan(3000);
    // Margin check: a mid-range phone is ~3-5× slower than this box.
    expect(dt).toBeLessThan(1000);
  });

  test('decision engine: < 150 ms p95 over 40 queries (500 candidates)', () => {
    const { listens, sessions } = ninetyDayLedger();
    const profile = buildProfile(listens, [], sessions, { now: NOW });
    const brain = new SessionBrain(NOW);
    for (const l of listens.slice(-12)) brain.push(l);
    const deps = { profile, session: brain.state, now: NOW };
    // GENIUS gauntlet (critic fix 3): the gate must exercise the NEW terms —
    // a populated bandit-arm table (several hundred learned arms) and real
    // directional transitions for the seed — or the potato-phone budget is
    // only ever verified on the legacy scoring path.
    const arms: BanditArms = {};
    for (let i = 0; i < 400; i++) {
      arms[`perf-${(i * 7) % 500}`] = { alpha: 1 + (i % 9), beta: 1 + (i % 5) };
    }
    profile.transitions = {
      x: Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [`perf-${i * 3}`, 1 - i * 0.1]),
      ),
    };
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
      }, deps, { banditArms: arms });
      durations.push(performance.now() - t0);
    }
    durations.sort((a, b) => a - b);
    const p95 = durations[Math.floor(durations.length * 0.95)]!;
    const med = durations[Math.floor(durations.length / 2)]!;
    console.log(`[perf] decide(): median ${med.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms (500 candidates → 12 picks)`);
    expect(p95).toBeLessThan(150);
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
    expect(dt).toBeLessThan(50);
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
    expect(dt).toBeLessThan(20);
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
    expect(dt).toBeLessThan(10);
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
});
