/**
 * MAGNUM OPUS WAVE 4 · F15 — SESSION MEMORY LOCKS.
 *
 * The bar: a session below 3 tracks NEVER snapshots; FIFO eviction
 * keeps the 3 newest; the service round-trips on a fixture store; the
 * resume mix is ≥70% HEARD seeds (≤30% fresh, never duplicating a
 * seed); the snapshot fires ONLY on app background (source law).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  createSessionSnapshots,
  evictFIFO,
  mixResumeSession,
  shouldSnapshot,
  type SessionSnapshot,
  type SessionSnapshotsStore,
} from '../src/ai/sessionMemory';
import { SESSION_MEMORY } from '../src/ai/core/constants';

function fixtureStore(): SessionSnapshotsStore & { rows: Map<string, SessionSnapshot> } {
  const rows = new Map<string, SessionSnapshot>();
  return {
    rows,
    async put(s) {
      rows.set(s.id, { ...s });
    },
    async all() {
      return [...rows.values()];
    },
    async del(id) {
      rows.delete(id);
    },
  };
}

const snap = (id: string, endedAt: number, seeds = ['a', 'b', 'c']): SessionSnapshot => ({
  id,
  vibeLabel: 'FLOW',
  seedTrackIds: seeds,
  startedAt: endedAt - 3600_000,
  endedAt,
});

describe('F15 · the snapshot gate (pure)', () => {
  test('a session below 3 tracks never snapshots (literals)', () => {
    expect(shouldSnapshot(0)).toBeFalse();
    expect(shouldSnapshot(2)).toBeFalse();
    expect(shouldSnapshot(3)).toBeTrue(); // the boundary is inclusive
    expect(shouldSnapshot(25)).toBeTrue();
    expect(SESSION_MEMORY.minTracks).toBe(3);
  });

  test('FIFO eviction: the OLDEST memory makes room, at most 3 remain', () => {
    expect(evictFIFO([snap('a', 1000), snap('b', 2000), snap('c', 3000)])).toEqual([]); // 3 fit
    expect(evictFIFO([snap('a', 1000), snap('b', 2000), snap('c', 3000), snap('d', 4000)])).toEqual(['a']);
    expect(evictFIFO([snap('a', 1000), snap('b', 2000), snap('c', 3000), snap('d', 4000), snap('e', 5000)])).toEqual([
      'a',
      'b',
    ]);
    expect(SESSION_MEMORY.maxSnapshots).toBe(3);
  });
});

describe('F15 · the service over a fixture store', () => {
  test('save → list round-trip: newest-ended first (awaited, not tautological)', async () => {
    const store = fixtureStore();
    const svc = createSessionSnapshots(store);
    await svc.save(snap('a', 1000));
    await svc.save(snap('b', 2000));
    const listed = await svc.list();
    expect(listed.map((s) => s.id)).toEqual(['b', 'a']); // newest-ended first
  });

  test('THE P0 LOCK: resumeSession must call require() DIRECTLY (no aliasing — Metro only rewrites the bare identifier)', () => {
    // the blind critic traced Metro's dependency extractor: an aliased
    // `require_` bypasses the rewrite, the raw string reaches the
    // runtime, throws on device, and the catch disguises it as the
    // honest cold state — resume becomes dead code behind a smile.
    const src = readFileSync('src/ai/mindbeat.ts', 'utf8');
    expect(src).toMatch(/(?<!const require_ = )require\('\.\.\/storage\/appTables'\)/);
    expect(src).not.toContain('require_'); // the alias is banned outright
  });

  test('a short spine drags the fresh cap down: ≤30% unheard holds at EVERY size', async () => {
    // 3 seeds (a legal ≥3 session): fresh cap = min(3, 9, floor(3*3/7)=1) = 1
    const seeds3 = Array.from({ length: 3 }, (_, i) => ({ id: `s${i}` }));
    const freshPool = Array.from({ length: 10 }, (_, i) => ({ id: `f${i}` }));
    const r3 = mixResumeSession(seeds3, freshPool, 12);
    expect(r3.freshUsed).toBe(1);
    expect(r3.mix.length).toBe(4);
    // 2 seeds (the resume gate's floor): NO strangers at all
    const r2 = mixResumeSession([{ id: 'a' }, { id: 'b' }], freshPool, 12);
    expect(r2.freshUsed).toBe(0);
    // 8 seeds: the documented 8+3 case (unchanged by the share fix)
    const seeds8 = Array.from({ length: 8 }, (_, i) => ({ id: `seed${i}` }));
    const r8 = mixResumeSession(seeds8, freshPool, 12);
    expect(r8.freshUsed).toBe(3);
    expect(r8.mix.length).toBe(11);
  });

  test('the 4th save evicts the 1st (FIFO, service-level)', async () => {
    const store = fixtureStore();
    const svc = createSessionSnapshots(store);
    await svc.save(snap('a', 1000));
    await svc.save(snap('b', 2000));
    await svc.save(snap('c', 3000));
    await svc.save(snap('d', 4000));
    expect(await svc.count()).toBe(3);
    expect(await svc.get('a')).toBeNull(); // evicted
    expect((await svc.list()).map((s) => s.id)).toEqual(['d', 'c', 'b']); // newest first
    expect(await svc.remove('d')).toBeTrue();
    expect(await svc.remove('d')).toBeFalse(); // honest false
    expect(await svc.count()).toBe(2);
  });

  test('a long queue snapshots its first 25 ids (the spine, not the whale)', async () => {
    const store = fixtureStore();
    const svc = createSessionSnapshots(store);
    const saved = await svc.save({
      vibeLabel: 'FLOW',
      seedTrackIds: Array.from({ length: 60 }, (_, i) => `t${i}`),
      startedAt: 0,
      endedAt: 9999,
    });
    expect(saved.seedTrackIds.length).toBe(25); // SESSION_MEMORY.maxSeedTracks
    expect(saved.seedTrackIds[0]).toBe('t0');
  });
});

describe('F15 · mixResumeSession — ≤30% unheard', () => {
  test('8 heard seeds + fresh pool → 8 seeds + at most 3 fresh (target 12)', () => {
    const seeds = Array.from({ length: 8 }, (_, i) => ({ id: `seed${i}` }));
    const fresh = Array.from({ length: 10 }, (_, i) => ({ id: `fresh${i}` }));
    const { mix, freshUsed } = mixResumeSession(seeds, fresh, 12);
    expect(mix.length).toBe(11); // 8 seeds + 3 fresh (floor(12*0.3)=3)
    expect(freshUsed).toBe(3);
    // the seeds LEAD, in order — a resume that leads with strangers is not a resume
    expect(mix.slice(0, 8).map((t) => t.id)).toEqual(seeds.map((t) => t.id));
    expect(mix.slice(8).every((t) => t.id.startsWith('fresh'))).toBeTrue();
  });

  test('fresh rows that ARE seeds never sneak in; seeds dedupe (and the share law binds)', () => {
    // 5 raw seeds → 4 unique; maxFresh = min(3, 6, floor(4*3/7)=1) = 1
    const seeds = [{ id: 's1' }, { id: 's1' }, { id: 's2' }, { id: 's3' }, { id: 's4' }];
    const fresh = [{ id: 's2' }, { id: 'f1' }];
    const { mix, freshUsed } = mixResumeSession(seeds, fresh, 10);
    expect(mix.map((t) => t.id)).toEqual(['s1', 's2', 's3', 's4', 'f1']); // s1 deduped; s2-as-fresh excluded
    expect(freshUsed).toBe(1);
  });

  test('the literal bridge: freshShare 0.3', () => {
    expect(SESSION_MEMORY.freshShare).toBe(0.3);
    expect(SESSION_MEMORY.resumeCount).toBe(12);
  });
});

describe('F15 · source laws', () => {
  test('snapshots fire ONLY on app background (the background handler is the sole caller)', () => {
    const provider = readFileSync('src/player/PlayerProvider.tsx', 'utf8');
    expect(provider).toMatch(/state === 'background'[\s\S]{0,900}shouldSnapshot/);
    expect(provider).toMatch(/sessions\.save/);
    // and the gate is the same ≥3 bar the pure law states
    expect(provider).toMatch(/shouldSnapshot\(queue\.length\)/);
  });

  test('webmock parity: both appTables twins export the sessions service', () => {
    const native = readFileSync('src/storage/appTables.ts', 'utf8');
    const web = readFileSync('src/webmocks/appTables.ts', 'utf8');
    for (const src of [native, web]) {
      expect(src).toContain('sessions: createSessionSnapshots(');
      expect(src).toContain("from '../ai/sessionMemory'");
    }
  });
});
