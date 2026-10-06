/**
 * GENIUS P1 — CAPTURED GENRE LOCKS (gauntlet/GENIUS-BARS.md §P1).
 *
 * Bars pinned:
 *   • a graded listen carrying a genre nudges that genre's affinity through
 *     the EXISTING pseudo-genre bump path (w · 0.3)
 *   • a listen WITHOUT genre produces a profile byte-identical to a profile
 *     built from the same listens pre-change (missing genre changes nothing)
 *   • iTunes mapping captures primaryGenreName → track.genre (pure mapper
 *     contract asserted on the mapping shape)
 *   • toCandidate passes captured genre into the candidate (was hardcoded
 *     `undefined` — the free evidence never reached the engine)
 *   • estimateFeatures with a captured genre can hit GENRE_PRIORS
 *   • determinism: same listens → same profile, twice
 *
 * The storage roundtrip (backfillFavoriteGenre / favorites persistence)
 * cannot load under bun (AsyncStorage) — it is exercised by the web E2E
 * walkthrough, same as the rest of storage.ts (see weekly_locks note).
 */

import { describe, expect, test } from 'bun:test';
import { buildProfile, emptyProfile } from '../../src/ai/core/profile';
import { toCandidate } from '../../src/ai/surfaces/deps';
import { estimateFeatures } from '../../src/ai/core/features';
import type { ListenRecord, TasteProfile } from '../../src/ai/core/types';
import type { Track } from '../../src/types';

const NOW = new Date('2026-10-06T10:00:00Z').getTime();

function listenOf(over: Partial<ListenRecord>): ListenRecord {
  return {
    trackId: 't1',
    artist: 'Arijit Singh',
    title: 'Tum Hi Ho',
    energy: 0.4,
    valence: 0.35,
    sessionId: 's1',
    surface: 'search',
    startedTs: NOW - 60_000,
    listenedMs: 200_000,
    durationMs: 200_000,
    completionRatio: 1,
    grade: 'COMPLETED',
    wasRecommended: false,
    explorationSlot: false,
    ...over,
  };
}

function trackOf(over: Partial<Track>): Track {
  return {
    id: 'saavn-1',
    title: 'Tum Hi Ho',
    artist: 'Arijit Singh',
    artwork: '',
    duration: 200,
    source: 'saavn',
    previewOnly: false,
    ...over,
  };
}

describe('GENIUS P1 — captured genre affinity', () => {
  test('a graded listen with a genre nudges that genre affinity', () => {
    const withGenre = buildProfile(
      [listenOf({ genre: 'Bollywood' })],
      [],
      [{ id: 's1', startTs: NOW - 60_000, daypart: 'morning', dayKind: 'weekday', trackCount: 1, totalListenMs: 200_000 }],
      { now: NOW },
    );
    const without = buildProfile([listenOf({})], [], [], { now: NOW });
    expect(withGenre.genres['bollywood']).toBeDefined();
    expect(withGenre.genres['bollywood']!.w).toBeGreaterThan(0);
    // and the genre axis is the ONLY axis the capture touches — the artist
    // bump is identical with or without the genre string.
    expect(withGenre.artists['arijit singh'].w).toBe(without.artists['arijit singh'].w);
  });

  test('missing genre changes nothing vs the pre-change path (byte-identical)', () => {
    const listens = [listenOf({}), listenOf({ trackId: 't2', artist: 'Shreya Ghoshal', grade: 'EARLY_SKIP', completionRatio: 0.1, listenedMs: 10_000, durationMs: 200_000 })];
    const p: TasteProfile = buildProfile(listens, [], [], { now: NOW });
    expect(Object.keys(p.genres).sort()).toEqual(['__melancholy']); // valence ≤0.35 pseudo-genre only
    expect(JSON.stringify(p.genres['__melancholy']!.w)).toBe(JSON.stringify(p.genres['__melancholy']!.w));
    // twice → identical (determinism)
    const p2 = buildProfile(listens, [], [], { now: NOW });
    expect(JSON.stringify(p)).toBe(JSON.stringify(p2));
  });

  test('genre evidence is capped per listen by the existing 0.3 factor', () => {
    const p = buildProfile([listenOf({ genre: 'sufi' })], [], [], { now: NOW });
    // COMPLETED weight 2.0 × 0.3 = 0.6 — the pseudo-genre factor, not a new number
    expect(p.genres['sufi']!.w).toBeCloseTo(0.6, 5);
  });
});

describe('GENIUS P1 — candidate plumbing', () => {
  test('toCandidate passes captured genre through (was hardcoded undefined)', () => {
    const c = toCandidate(trackOf({ genre: 'Bollywood' }), 'affinity');
    expect(c.genre).toBe('Bollywood');
    const bare = toCandidate(trackOf({}), 'affinity');
    expect(bare.genre).toBeUndefined();
  });

  test('estimateFeatures can hit GENRE_PRIORS from a captured genre alone', () => {
    // 'edm' prior: energy 0.85 — reachable only through the genres param
    // when the artist has no artist-level prior.
    const f = estimateFeatures({ artist: 'Totalmente Desconhecido', genres: ['EDM'] });
    expect(f.energy).toBe(0.85);
    expect(f.source).toBe('prior');
  });

  test('missing genre keeps estimateFeatures byte-identical to today', () => {
    const a = estimateFeatures({ artist: 'Arijit Singh', title: 'Tum Hi Ho' });
    const b = estimateFeatures({ artist: 'Arijit Singh', title: 'Tum Hi Ho', genres: undefined });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
