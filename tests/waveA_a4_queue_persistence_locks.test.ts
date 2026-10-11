/**
 * WAVE A · A4 — the offline queue locks.
 *
 * Three evidence classes:
 *
 *  1. BEHAVIORAL over injected in-memory deps: the save → (kill) →
 *     load round-trip, house rule 14 (streamUrl/url/localUri/
 *     encryptedUrl unrepresentable on BOTH the write and the read —
 *     defense in depth), the 24h TTL, the corrupt/stale rejection, the
 *     50-row cap around the active row, and the empty-queue no-op.
 *
 *  2. THE DEBOUNCE LAW with hand-driven timers: a burst of saves
 *     coalesces into exactly ONE write carrying the LATEST queue;
 *     flush() writes the pending burst immediately.
 *
 *  3. WIRING locks in PlayerProvider: every mutation converges on the
 *     save effect (with the empty guard), the boot restores only when
     the engine came up empty, the background flush, and the togglePlay
 *     one-shot active-index handoff.
 *
 * Mutations proven RED (worklog):
 *  M-A4-1  the save effect removed from PlayerProvider → wiring locks fail;
 *  M-A4-2  the TTL check removed from loadQueue → the staleness bar fails;
 *  M-A4-3  the strip removed from sanitizeQueue → house rule 14 fails.
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import type { Track } from '../src/types';

const memKv = new Map<string, string>();
let NOW = 1_700_000_000_000;
const deps = {
  getRaw: async (k: string) => memKv.get(k) ?? null,
  setRaw: async (k: string, v: string) => {
    memKv.set(k, v);
  },
  now: () => NOW,
};

const {
  QUEUE_KEY,
  saveQueue,
  loadQueue,
  sanitizeQueue,
  stripForPersistence,
  createQueueSaver,
} = await import('../src/player/queuePersistence');

function row(id: string): Track {
  // a REALISTIC dirty row — everything a queue row can carry that must
  // never reach disk
  return {
    id,
    title: `Song ${id}`,
    artist: 'Artist',
    album: 'Album',
    artwork: 'https://example/art.jpg',
    duration: 200,
    source: 'saavn',
    previewOnly: false,
    streamUrl: `https://stream/${id}/ip-bound`,
    url: `https://engine/${id}/ip-bound`,
    localUri: `file:///docs/${id}.mp3`,
    encryptedUrl: `enc://${id}`,
  } as unknown as Track;
}

beforeEach(() => {
  memKv.clear();
  NOW = 1_700_000_000_000;
});

describe('WAVE A · A4 — the round-trip: save → kill → load', () => {
  test('the queue and the active row survive, in order', async () => {
    const q = ['a1', 'a2', 'a3', 'a4'].map(row);
    await saveQueue(deps, q, 'a3');
    // THE KILL — a fresh read from cold storage is all the next boot gets
    const loaded = await loadQueue(deps);
    expect(loaded).not.toBeNull();
    expect(loaded!.tracks.map((t) => t.id)).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(loaded!.activeId).toBe('a3'); // restore respects the active track
    expect(loaded!.savedAt).toBe(NOW);
  });

  test('house rule 14: streamUrl/url/localUri/encryptedUrl are stripped on WRITE and AGAIN on read', async () => {
    const q = [row('dirty')];
    await saveQueue(deps, q, 'dirty');
    const raw = JSON.parse(memKv.get(QUEUE_KEY)!);
    for (const t of raw.tracks) {
      expect(t.streamUrl).toBeUndefined();
      expect(t.url).toBeUndefined();
      expect(t.localUri).toBeUndefined();
      expect(t.encryptedUrl).toBeUndefined();
    }
    // even a payload written by a BUGGY writer gets scrubbed on load
    raw.tracks[0].streamUrl = 'https://smuggled';
    memKv.set(QUEUE_KEY, JSON.stringify(raw));
    const loaded = await loadQueue(deps);
    expect((loaded!.tracks[0] as unknown as Record<string, unknown>).streamUrl).toBeUndefined();
  });

  test('a stale queue (> 24h TTL) is not a promise — load returns null', async () => {
    await saveQueue(deps, [row('old')], 'old');
    NOW += 24 * 60 * 60 * 1000 + 1; // one ms past the freshness line
    expect(await loadQueue(deps)).toBeNull();
  });

  test('corrupt or malformed payloads are rejected honestly (never throw)', async () => {
    memKv.set(QUEUE_KEY, '{not json');
    expect(await loadQueue(deps)).toBeNull();
    memKv.set(QUEUE_KEY, JSON.stringify({ savedAt: NOW, activeId: null, tracks: 'not-an-array' }));
    expect(await loadQueue(deps)).toBeNull();
    memKv.set(QUEUE_KEY, JSON.stringify({ savedAt: NOW, activeId: null, tracks: [] }));
    expect(await loadQueue(deps)).toBeNull();
  });

  test('the cap: 120 rows with the active near the tail store the window (rewind + ALL remaining upcoming, ≤ 50)', () => {
    const q = Array.from({ length: 120 }, (_, i) => row(`t${i}`));
    const stored = sanitizeQueue(q, 't100');
    // the law: 10 rewind rows + the active + every remaining upcoming —
    // the tail leaves only 30 rows, and the cap is a MAXIMUM, not padding
    const ids = stored.map((t) => t.id);
    expect(ids).toEqual(Array.from({ length: 30 }, (_, i) => `t${90 + i}`));
    expect(ids).toContain('t100'); // the active row survives the cap
    expect(ids[0]).toBe('t90'); // the rewind context
    expect(ids[ids.length - 1]).toBe('t119'); // nothing upcoming is lost

    // mid-queue active: the window fills the cap, still active-anchored
    const mid = sanitizeQueue(q, 't70');
    expect(mid.map((t) => t.id)).toEqual(Array.from({ length: 50 }, (_, i) => `t${60 + i}`));
  });

  test('an empty queue is NEVER persisted (the boot restore can never be clobbered by a blank)', async () => {
    await saveQueue(deps, [], 'x');
    expect(memKv.get(QUEUE_KEY)).toBeUndefined();
    expect(stripForPersistence(row('s')).id).toBe('s'); // the stripper itself stays pure
  });
});

describe('WAVE A · A4 — the debounce law (hand-driven clock)', () => {
  test('a burst of saves coalesces into ONE write carrying the LATEST queue', async () => {
    let ticks: Array<() => void> = [];
    const saver = createQueueSaver(deps, {
      setTimer: (fn) => {
        ticks.push(fn);
        return ticks.length;
      },
      clearTimer: () => undefined,
    });
    saver.save([row('first')], 'first');
    saver.save([row('first'), row('second')], 'second'); // the burst — must NOT re-arm
    expect(ticks.length).toBe(1); // one fuse, not two
    ticks[0](); // the fuse burns
    ticks = [];
    const raw = JSON.parse(memKv.get(QUEUE_KEY)!);
    expect(raw.tracks.map((t: Track) => t.id)).toEqual(['first', 'second']); // the LATEST truth
    expect(raw.activeId).toBe('second');
    // after the burn, a new save arms a NEW fuse
    saver.save([row('third')], 'third');
    expect(ticks.length).toBe(1);
  });

  test('flush() writes the pending burst NOW (the backgrounding latch)', async () => {
    let ticks: Array<() => void> = [];
    const saver = createQueueSaver(deps, {
      setTimer: (fn) => {
        ticks.push(fn);
        return ticks.length;
      },
      clearTimer: () => undefined,
    });
    saver.save([row('pending')], 'pending');
    await saver.flush();
    const raw = JSON.parse(memKv.get(QUEUE_KEY)!);
    expect(raw.tracks.map((t: Track) => t.id)).toEqual(['pending']);
    expect(ticks.length).toBe(1); // the fuse was cleared, not burned
  });
});

// ── the wiring ──────────────────────────────────────────────────────────

describe('WAVE A · A4 — PlayerProvider wiring (source locks)', () => {
  const fs = require('fs');
  const src = fs.readFileSync('src/player/PlayerProvider.tsx', 'utf8');

  test('every mutation converges on the debounced save, behind the empty guard', () => {
    expect(src).toContain('getQueueSaver().save(queue, active?.id ?? null)');
    const saveEffect = src.slice(src.indexOf('// WAVE A (A4) — EVERY queue mutation'), src.indexOf('getQueueSaver().save'));
    expect(saveEffect).toContain('if (!queue.length) return;');
  });

  test('the boot restores ONLY when the engine came up empty (the service-survived case wins)', () => {
    const boot = src.slice(src.indexOf('Boot: rehydrate queue from RNTP'), src.indexOf('void mindbeat.init()'));
    expect(boot).toContain('loadQueue(makeAsyncStorageDeps())');
    const guardAt = boot.indexOf('if (!engineQueue.length)');
    const loadAt = boot.indexOf('loadQueue');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(loadAt);
  });

  test('togglePlay consumes the one-shot active handoff (restore respects the active track)', () => {
    expect(src).toContain('restoredActiveIdRef.current = null;');
    expect(src).toContain('await playQueue(queue, Math.max(0, idx))');
  });

  test('backgrounding flushes the pending debounced save (the OS may kill before the fuse burns)', () => {
    expect(src).toContain('void getQueueSaver().flush().catch(() => undefined)');
  });

  test('the saver is created on FIRST USE — never during provider mount (potato law)', () => {
    expect(src).toContain('if (!queueSaverRef.current) queueSaverRef.current = createQueueSaver(makeAsyncStorageDeps())');
  });
});
