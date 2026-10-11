/**
 * WAVE C · C3 LOCKS — "✨ Surprise Me", the filter-bubble escape hatch.
 *
 * THE BAR (C3): the surprise track
 *   1. fits the vibe (energy within ±0.1 of the session mean);
 *   2. is from a rarely-played artist (affinity < 0.1);
 *   3. is from a non-top-5 genre;
 *   4. passes filterClean;
 *   and the pick is DETERMINISTIC — a seeded mulberry32 over
 *   `${session.id}:${now}`, never Math.random.
 *
 * MUTATION TARGETS (deterministic RED):
 *   M-C3-1 — the genre constraint removed → the top-genre bait track
 *            gets served where the law refuses → RED;
 *   M-C3-2 — the affinity constraint removed → the familiar-artist bait
 *            gets served where the law refuses → RED;
 *   M-C3-3 — the energy band removed → the out-of-band bait gets
 *            served where the law refuses → RED (bonus third).
 */

import { describe, expect, test } from 'bun:test';
import { pickSurprise, hashSeed, topGenres, SURPRISE_ENERGY_BAND } from '../src/ai/surfaces/surpriseMe';
import { mulberry32 } from '../src/ai/genreExplorer';
import { estimateFeatures } from '../src/ai/core/features';
import { sessionEnergyOf } from '../src/ai/core/decision';
import type { Track } from '../src/types';
import type { SessionState, TasteProfile, AffinityEntry } from '../src/ai/core/types';

const NOW = 1_700_000_000_000;

function affinity(w: number, source: AffinityEntry['source'] = 'organic'): AffinityEntry {
  return { w, lastEventTs: NOW, evidenceCount: 10, source };
}

/** The profile: loves Arijit + Bollywood/Pop/Punjabi/Rock/Classical top-5. */
function fixtureProfile(): TasteProfile {
  return {
    builtAt: NOW,
    sessionCount: 30,
    artists: {
      'arijit singh': affinity(0.9, 'heart'),
      'sonu nigam': affinity(0.85, 'heart'),
    },
    genres: {
      bollywood: affinity(0.9),
      pop: affinity(0.7),
      punjabi: affinity(0.6),
      rock: affinity(0.5),
      classical: affinity(0.4),
      jazz: affinity(0.15),
      afrobeat: affinity(0.1),
    },
    languages: {},
    eras: {},
    proxy: { energyPref: { mean: 0.5, std: 0.2 }, valencePref: { mean: 0.5, std: 0.2 }, tempoDist: { slow: 1, mid: 1, fast: 1 } },
    daypart: {},
    activities: {},
    skipProfiles: {},
    coplayTracks: {},
    coplayArtists: {},
    flowTracks: {},
    clusters: { artistClusters: [], moodCells: [] },
    exploration: {
      bucket: 0.3,
      lastServedTs: 0,
      streak: 0,
    } as unknown as TasteProfile['exploration'],
    corrections: { mutedArtists: [], mutedTracks: [], boosts: {}, wrongLabels: [] },
    boundaries: { weekday: {}, weekend: {} },
  };
}

/** The session: steady 0.5 energy trajectory (the session mean is 0.5). */
function fixtureSession(): SessionState {
  return {
    id: 'session-42',
    startTs: NOW - 600_000,
    daypart: 'EVENING' as SessionState['daypart'],
    dayKind: 'WEEKDAY' as SessionState['daykind'] as never,
    window: [],
    sessionArtists: new Map(),
    sessionGenres: new Map(),
    energyTrajectory: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
    instantRejects: [],
    completionRate: 0.8,
    dedupSet: new Map(),
    vibe: 'FLOW',
  };
}

function track(id: string, artist: string, title: string, genre?: string, explicit = false): Track {
  return {
    id,
    title,
    artist,
    genre,
    explicit,
    source: 'saavn',
  } as Track;
}

describe('wavec c3 — THE BAR: the four constraints', () => {
  test('the surprise meets all four constraints (the relational lock)', () => {
    const profile = fixtureProfile();
    const session = fixtureSession();
    // pool: in-band energy (unknown artists = 0.5), rare artists,
    // non-top genres — the ONLY kind of track that may win
    const catalog = [
      track('s1', 'mystery jazz trio', 'midnight wanderings', 'jazz'),
      track('s2', 'afrobeat collective', 'lagos nights', 'afrobeat'),
      // baits that must be refused:
      track('b1', 'some hitmaker', 'chart topper', 'bollywood'), // top genre
      track('b2', 'arijit singh', 'the usual', 'ghazal'), // high affinity
      track('b3', 'sukhwinder singh', 'too loud', 'jazz'), // energy 0.7 — out of band
    ];
    const pick = pickSurprise(profile, session, catalog, { now: NOW, seed: 'fixed-seed-1' });
    expect(pick).not.toBeNull();
    // 1. fits the vibe
    const energy = estimateFeatures({ artist: pick!.artist, title: pick!.title }).energy;
    const sEnergy = sessionEnergyOf(session);
    expect(Math.abs(energy - sEnergy)).toBeLessThanOrEqual(SURPRISE_ENERGY_BAND + 1e-9);
    // 2. rarely heard
    const { artistAffinity } = require('../src/ai/core/decision');
    expect(artistAffinity(profile, pick!.artist, NOW)).toBeLessThan(0.1);
    // 3. breaks the bubble
    expect(topGenres(profile, 5)).not.toContain((pick!.genre ?? '').toLowerCase());
    // 4. clean (nothing in this pool is flagged; the explicit law locks below)
    expect(pick!.explicit ?? false).toBeFalse();
  });

  test('filterClean: an explicit-flagged track can never be the surprise', () => {
    const profile = fixtureProfile();
    const session = fixtureSession();
    const catalog = [
      track('dirty', 'mystery jazz trio', 'unclean anthem', 'jazz', true),
    ];
    expect(pickSurprise(profile, session, catalog, { now: NOW, seed: 's' })).toBeNull();
  });

  test('queue exclusion: a track already queued is never the surprise', () => {
    const profile = fixtureProfile();
    const session = fixtureSession();
    const catalog = [track('s1', 'mystery jazz trio', 'midnight wanderings', 'jazz')];
    expect(pickSurprise(profile, session, catalog, { now: NOW, seed: 's', excludeIds: ['s1'] })).toBeNull();
  });

  test('the bubble breaker refuses when ONLY top-genre tracks qualify (mutation bait)', () => {
    const profile = fixtureProfile();
    const session = fixtureSession();
    // ONLY the bollywood track is in the energy band; the non-top-genre
    // candidates sit out of band (sukhwinder 0.7, prateek 0.25)
    const catalog = [
      track('b1', 'some hitmaker', 'chart topper', 'bollywood'),
      track('j1', 'sukhwinder singh', 'too loud', 'jazz'),
      track('j2', 'prateek kuhad', 'too quiet', 'jazz'),
    ];
    expect(pickSurprise(profile, session, catalog, { now: NOW, seed: 's' })).toBeNull();
  });

  test('the rarity law refuses when ONLY a familiar artist qualifies (mutation bait)', () => {
    const profile = fixtureProfile();
    const session = fixtureSession();
    // sonu nigam (prior energy 0.45 — IN the ±0.1 band, affinity 0.85 ≥
    // 0.1) is the only in-band, non-top-genre track: only the rarity law
    // refuses him. (arijit 0.35 is out of band — energy would mask it.)
    const catalog = [
      track('f1', 'sonu nigam', 'the usual', 'ghazal'),
      track('j1', 'sukhwinder singh', 'too loud', 'jazz'),
    ];
    expect(pickSurprise(profile, session, catalog, { now: NOW, seed: 's' })).toBeNull();
  });

  test('honest null: nothing qualifies → null, not a lying pick', () => {
    const profile = fixtureProfile();
    const session = fixtureSession();
    expect(pickSurprise(profile, session, [], { now: NOW, seed: 's' })).toBeNull();
    expect(
      pickSurprise(profile, session, [track('x', 'sukhwinder singh', 'loud', 'jazz')], { now: NOW, seed: 's' }),
    ).toBeNull();
  });
});

describe('wavec c3 — determinism (X5)', () => {
  test('the same seed picks the same track — twice, byte-identical', () => {
    const profile = fixtureProfile();
    const session = fixtureSession();
    const catalog = [
      track('s1', 'mystery jazz trio', 'midnight wanderings', 'jazz'),
      track('s2', 'afrobeat collective', 'lagos nights', 'afrobeat'),
      track('s3', 'unknown ska band', 'skanking free', 'ska'),
    ];
    const a = pickSurprise(profile, session, catalog, { now: NOW, seed: 'the-seed' });
    const b = pickSurprise(profile, session, catalog, { now: NOW, seed: 'the-seed' });
    expect(a).not.toBeNull();
    expect(a!.id).toBe(b!.id);
  });

  test('the default seed is `${session.id}:${now}` — no Math.random anywhere', () => {
    const profile = fixtureProfile();
    const session = fixtureSession();
    const catalog = [
      track('s1', 'mystery jazz trio', 'midnight wanderings', 'jazz'),
      track('s2', 'afrobeat collective', 'lagos nights', 'afrobeat'),
    ];
    // explicit now → deterministic even through the default seed path
    const a = pickSurprise(profile, session, catalog, { now: NOW });
    const b = pickSurprise(profile, session, catalog, { now: NOW });
    expect(a!.id).toBe(b!.id);
    // and the seed math is locked: hashSeed + mulberry32 reproduce the pick
    const idx = Math.floor(mulberry32(hashSeed(`session-42:${NOW}`))() * 2);
    expect(a!.id).toBe(['s1', 's2'][idx]);
  });

  test('hashSeed is a real 32-bit avalanche (not the identity)', () => {
    expect(hashSeed('session-42:1700000000000')).toBe(hashSeed('session-42:1700000000000'));
    expect(hashSeed('a')).not.toBe(hashSeed('b'));
    expect(Number.isInteger(hashSeed('x'))).toBeTrue();
  });
});

describe('wavec c3 — the top-5 genre boundary', () => {
  test('topGenres normalizes and sorts by weight', () => {
    const t = topGenres(fixtureProfile(), 5);
    expect(t).toEqual(['bollywood', 'pop', 'punjabi', 'rock', 'classical']);
    // the 6th genre (jazz) is OUTSIDE the bubble — the surprise may come
    // from there
    expect(topGenres(fixtureProfile(), 6)).toContain('jazz');
  });

  test('a genre-less profile passes the bubble check vacuously', () => {
    const profile = fixtureProfile();
    profile.genres = {};
    const session = fixtureSession();
    const catalog = [track('s1', 'mystery jazz trio', 'midnight wanderings', undefined)];
    expect(pickSurprise(profile, session, catalog, { now: NOW, seed: 's' })).not.toBeNull();
  });
});
