/**
 * PHASE 1 LOCKS — captured (free) genre evidence.
 *
 *   1. itunes.ts captures primaryGenreName onto Track.genre
 *   2. a listen WITH genre pushes genre affinity at CAPTURED_GENRE_WEIGHT
 *      (= ONBOARDING.genreSeedWeight × 0.5 — half an onboarding pick)
 *   3. a listen WITHOUT genre leaves the profile BYTE-IDENTICAL
 *      (negative grades never feed the captured bump)
 *   4. toCandidate carries the genre into the decision engine
 *   5. the lazy favorites backfill writes a genre once, never overwrites
 */

import { describe, expect, test, mock } from 'bun:test';

// In-memory AsyncStorage so the favorites backfill has a real round-trip.
const kv = new Map<string, string>();
mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => kv.get(k) ?? null,
    setItem: async (k: string, v: string) => void kv.set(k, v),
    removeItem: async (k: string) => void kv.delete(k),
    multiRemove: async (ks: string[]) => void ks.forEach((k) => kv.delete(k)),
  },
}));

import { buildProfile } from '../../src/ai/core/profile';
import { CAPTURED_GENRE_WEIGHT, ONBOARDING } from '../../src/ai/core/constants';
import { toCandidate } from '../../src/ai/surfaces/deps';
import { listenOf } from './corpus';
import { backfillFavoriteGenre, getFavorites } from '../../src/storage/store';
import type { Track } from '../../src/types';

const DAY = 86400_000;
const NOW = 1750000000000;

describe('phase 1 — captured genre evidence', () => {
  test('captured weight = explicit seed × 0.5 (the stated contract)', () => {
    expect(CAPTURED_GENRE_WEIGHT).toBe(ONBOARDING.genreSeedWeight * 0.5);
  });

  test('a completed listen WITH a genre pushes affinity by the captured weight', () => {
    const base = listenOf('t-g', 'artist a', NOW - DAY, 's1', 1, { genre: 'bollywood' });
    const p = buildProfile([base], [], [], { now: NOW });
    const entry = p.genres['bollywood'];
    expect(entry).toBeDefined();
    // blame-split genre bump (w×0.3 = 2.0×0.3 = 0.6) + captured (1.1)
    expect(entry!.w).toBeCloseTo(2.0 * 0.3 + CAPTURED_GENRE_WEIGHT, 5);
  });

  test('a skipped listen NEVER earns the captured bump (skips are not genre evidence)', () => {
    const skip = listenOf('t-s', 'artist a', NOW - DAY, 's1', 0.02, { genre: 'bollywood' }); // INSTANT_REJECT
    expect(skip.grade).toBe('INSTANT_REJECT');
    const p = buildProfile([skip], [], [], { now: NOW });
    const entry = p.genres['bollywood'];
    // only the blame-split bump (negative) — no captured weight
    expect(entry!.w).toBeCloseTo(-3.0 * 0.3, 5);
  });

  test('REPLAY-test: removing the genre changes ONLY the genre map (byte-identical elsewhere)', () => {
    const withGenre = listenOf('t-1', 'arijit singh', NOW - DAY, 's1', 1, { genre: 'pop' });
    const withoutGenre = { ...listenOf('t-1', 'arijit singh', NOW - DAY, 's1', 1) };
    delete withoutGenre.genre;
    const sessions = [{ id: 's1', startTs: NOW - DAY, daypart: 'evening' as const, dayKind: 'weekday' as const, trackCount: 1, totalListenMs: 210000 }];
    const pWith = buildProfile([withGenre], [], sessions, { now: NOW });
    const pWithout = buildProfile([withoutGenre], [], sessions, { now: NOW });
    // genres differ
    expect(pWith.genres['pop']).toBeDefined();
    expect(pWithout.genres['pop']).toBeUndefined();
    // artists identical
    expect(JSON.stringify(pWith.artists)).toBe(JSON.stringify(pWithout.artists));
    // proxy + daypart identical
    expect(JSON.stringify(pWith.proxy)).toBe(JSON.stringify(pWithout.proxy));
    expect(JSON.stringify(pWith.daypart['evening|weekday']?.energyMean)).toBe(
      JSON.stringify(pWithout.daypart['evening|weekday']?.energyMean),
    );
    expect(pWith.sessionCount).toBe(pWithout.sessionCount);
  });

  test('toCandidate carries the captured genre into the engine', () => {
    const track = {
      id: 'saavn-1', title: 'X', artist: 'A', artwork: '', duration: 30,
      source: 'saavn' as const, previewOnly: false, genre: 'Punjabi',
    } as Track;
    const c = toCandidate(track, 'affinity');
    expect(c.genre).toBe('Punjabi');
  });
});

describe('phase 1 — lazy favorites genre backfill', () => {
  test('backfills a genre-less favorite row exactly once and never overwrites', async () => {
    const t: Track = {
      id: 'saavn-bf1', title: 'Old favorite', artist: 'A', artwork: '', duration: 30,
      source: 'itunes', previewOnly: true,
    };
    // seed the favorites list through the same storage module
    const { toggleFavorite } = await import('../../src/storage/store');
    await toggleFavorite(t);
    expect((await getFavorites()).some((x) => x.id === t.id)).toBe(true);

    const first = await backfillFavoriteGenre(t.id, 'Pop');
    expect(first).toBe(true);
    const rows = await getFavorites();
    expect(rows.find((x) => x.id === t.id)?.genre).toBe('Pop');

    const second = await backfillFavoriteGenre(t.id, 'Metal');
    expect(second).toBe(false); // already tagged — never overwritten
    expect((await getFavorites()).find((x) => x.id === t.id)?.genre).toBe('Pop');
  });
});
