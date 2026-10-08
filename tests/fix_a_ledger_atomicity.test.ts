/**
 * v5.0.1 FIX-A1 — THE ATOMIC FOLD LOCKS (the auditor's P1).
 *
 * The reproduced bug: ledger.ts advanced the fold watermark BEFORE the
 * summary upserts and maybeCompact deleted the raw events regardless —
 * a failing upsertHistoricalDay meant empty history, gone raw events,
 * advanced watermark: PERMANENT DATA LOSS.
 *
 * The bars (mission FIX-A1):
 *  - upsertHistoricalDay failure → raw events RETAINED, watermark
 *    UNCHANGED (the next compaction retries).
 *  - Successful fold → the watermark advances only AFTER every upsert
 *    succeeded (order is locked, not just the outcome).
 *  - A later recovery pass commits: fold → watermark → delete.
 *
 * Fixture style matches tests/wave2_historical_locks.test.ts (memory
 * store + fixed clock + the listen-table join for artist names).
 */

import { describe, expect, test } from 'bun:test';
import { EventLedger } from '../src/ai/core/ledger';
import { createLedgerStore as createMemoryStore } from '../src/ai/core/storeMemory';
import type { LedgerStore } from '../src/ai/core/store';
import type { LedgerEvent, ListenRecord } from '../src/ai/core/types';
import { RETENTION } from '../src/ai/core/constants';

const DAY = 86400_000;
const localMidnight = (y: number, m: number, d: number) => new Date(y, m, d, 0, 0, 0, 0).getTime();
const NOW = localMidnight(2025, 5, 15) + 8 * 3600_000;
const WATERMARK = 'historical.foldedThroughTs';

let n = 0;
function ev(ts: number, type: LedgerEvent['type'], trackId: string, payload: Record<string, unknown>): LedgerEvent {
  n += 1;
  return { id: `${ts}-${String(n).padStart(4, '0')}`, ts, type, sessionId: 's1', trackId, payload };
}

/** One finished 120s listen ~4 months before NOW (90d-doomed). */
async function seedDoomedDay(store: LedgerStore): Promise<void> {
  const doomedDay = localMidnight(2025, 1, 10) + 12 * 3600_000;
  await store.appendEvents([
    ev(doomedDay, 'TRACK_START', 'old1', { title: 'Memory', artistId: 'ar-old' }),
    ev(doomedDay + 2000, 'TRACK_END', 'old1', { elapsedMs: 120000 }),
  ]);
  await store.appendListen({
    trackId: 'old1', artist: 'Past Artist', title: 'Memory', sessionId: 's1',
    surface: 'player', startedTs: doomedDay, listenedMs: 120000, durationMs: 200000,
    completionRatio: 0.6, grade: 'COMPLETED', wasRecommended: false, explorationSlot: false,
  } as ListenRecord);
}

/** Proxy a store, replacing ONE method (functions re-bound like wave2). */
function sabotage(store: LedgerStore, prop: keyof LedgerStore, impl: unknown): LedgerStore {
  return new Proxy(store, {
    get(target, p, recv) {
      if (p === prop) return impl;
      const v = Reflect.get(target, p, recv);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as LedgerStore;
}

describe('FIX-A1 · the atomic fold (F9 data-loss bug)', () => {
  test('THE P1 BAR: upsert failure → raw events RETAINED, watermark NOT advanced, nothing deleted', async () => {
    const store = await createMemoryStore();
    await seedDoomedDay(store);
    const bomb = sabotage(store, 'upsertHistoricalDay', async () => {
      throw new Error('injected: the summary table is unwritable');
    });
    await new EventLedger(bomb, () => NOW).maybeCompact();
    // the raw events SURVIVE — the irreplaceable copy is never dropped
    expect((await store.getEvents()).length).toBe(2);
    // the watermark never moved
    expect(await store.getKV<number>(WATERMARK)).toBeNull();
    // the summary holds nothing (the single upsert failed)
    expect(await store.getHistoricalDays!()).toEqual([]);
  });

  test('ORDER LOCK: the watermark is the fold\u2019s LAST write — every upsert precedes setKV', async () => {
    const store = await createMemoryStore();
    await seedDoomedDay(store);
    const ops: string[] = [];
    const recording = sabotage(store, 'upsertHistoricalDay', async (day: unknown) => {
      ops.push(`upsert:${(day as { dayKey: string }).dayKey}`);
      await store.upsertHistoricalDay(day as never);
    });
    const recording2 = new Proxy(recording, {
      get(target, p, recv) {
        if (p === 'setKV') {
          return async (k: string, v: unknown) => {
            ops.push(`setKV:${k}=${String(v)}`);
            return store.setKV(k, v as never);
          };
        }
        const v = Reflect.get(target, p, recv);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as LedgerStore;
    await new EventLedger(recording2, () => NOW).maybeCompact();
    expect(ops.length).toBeGreaterThanOrEqual(2);
    expect(ops[ops.length - 1]).toMatch(/^setKV:historical\.foldedThroughTs=/); // the commit is last
    expect(ops.filter((o) => o.startsWith('upsert:')).length).toBe(1);
    expect(ops.indexOf(ops.find((o) => o.startsWith('upsert:'))!)).toBeLessThan(
      ops.findIndex((o) => o.startsWith('setKV:')),
    );
  });

  test('success path: watermark lands at cutoff-1, then the raw events are deleted', async () => {
    const store = await createMemoryStore();
    await seedDoomedDay(store);
    await new EventLedger(store, () => NOW).maybeCompact();
    const cutoff = NOW - RETENTION.rawEventDays * DAY;
    expect(await store.getKV<number>(WATERMARK)).toBe(cutoff - 1); // committed exactly through the fold
    expect((await store.getEvents()).length).toBe(0); // deleted AFTER the commit
    expect((await store.getHistoricalDays!()).length).toBe(1); // and the summary is real
  });

  test('RECOVERY: a fold that failed on day one commits on the next compaction — events are never lost in between', async () => {
    const store = await createMemoryStore();
    await seedDoomedDay(store);
    let throwing = true;
    const flaky = sabotage(store, 'upsertHistoricalDay', async (day: unknown) => {
      if (throwing) throw new Error('injected: still failing');
      return store.upsertHistoricalDay(day as never);
    });
    await new EventLedger(flaky, () => NOW).maybeCompact();
    expect((await store.getEvents()).length).toBe(2); // retained through the failure
    expect(await store.getKV<number>(WATERMARK)).toBeNull(); // never advanced past a failure
    // the store heals; the next compaction folds, commits, deletes
    throwing = false;
    await new EventLedger(flaky, () => NOW + DAY).maybeCompact();
    expect((await store.getEvents()).length).toBe(0);
    expect(await store.getKV<number>(WATERMARK)).toBe(NOW + DAY - RETENTION.rawEventDays * DAY - 1);
    const days = await store.getHistoricalDays!();
    expect(days.length).toBe(1);
    expect(days[0].streams).toBe(1);
  });

  test('pre-F9 store: the fold reports success and deletion proceeds byte-identically (L1/L4)', async () => {
    const store = await createMemoryStore();
    await seedDoomedDay(store);
    const preF9 = sabotage(store, 'upsertHistoricalDay', undefined);
    await new EventLedger(preF9, () => NOW).maybeCompact();
    expect((await store.getEvents()).length).toBe(0); // same retention behavior as pre-F9
    expect(await store.getKV<number>(WATERMARK)).toBeNull(); // nothing was written
  });
});
