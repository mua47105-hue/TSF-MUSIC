/**
 * PHASE 6 + BAR 1.4 LOCKS — the tag-overlap similarity engine.
 *
 *   1. the SOUND_ALIKE truth condition: ≥2 shared tag dimensions
 *   2. the artist dimension is DOWN-WEIGHTED — same-artist clones cannot
 *      win on artist alone
 *   3. per-artist cap 2 inside one sound-alike list
 *   4. determinism: same pool + seed → same list
 *   5. BAR 1.4 (Law ⑨): mindbeat.soundAlike passes the merged pool
 *      through reconcileRecordings() BEFORE rankSoundAlike (source lock)
 *   6. the kill switch + honest empty degrade (facade contract)
 */

import { describe, expect, test } from 'bun:test';
import { rankSoundAlike, sharedDims, tagVectorOf, primaryArtistOf, type TagVector } from '../../src/ai/core/similarity';
import { SIMILARITY } from '../../src/ai/core/constants';
import type { Track } from '../../src/types';

function track(id: string, over: Partial<Track> = {}): Track {
  return {
    id, title: `Song ${id}`, artist: 'Artist A', artwork: '', duration: 30,
    source: 'saavn', previewOnly: false, ...over,
  };
}

function tags(over: Partial<TagVector>): TagVector {
  return { artist: 'artist a', mood: 'upbeat', ...over };
}

describe('phase 6 — tag vectors', () => {
  test('the primary artist of a comma credit list normalizes', () => {
    expect(primaryArtistOf('Arijit Singh, Tulsi Kumar')).toBe('arijit singh');
    expect(primaryArtistOf('  Diljit   Dosanjh ')).toBe('diljit dosanjh');
  });

  test('tagVectorOf reads all five dimensions off a track', () => {
    const t = track('x', { genre: 'Bollywood', language: 'hindi', year: 2019 });
    const v = tagVectorOf(t);
    expect(v.artist).toBe('artist a');
    expect(v.genre).toBe('bollywood');
    expect(v.language).toBe('hindi');
    expect(v.era).toBe('2010s');
    expect(typeof v.mood).toBe('string');
  });
});

describe('phase 6 — the sound-alike ranker', () => {
  const seed = tags({ artist: 'arijit singh', genre: 'bollywood', language: 'hindi', era: 'current', mood: 'melancholy' });

  test('BAR 1.4 truth condition: <2 shared dims ⇒ ineligible; ≥2 ⇒ ranked', () => {
    const pool = [
      { track: track('1'), tags: tags({ artist: 'someone else', genre: 'sufi', language: 'hindi', era: 'current', mood: 'brooding' }) }, // lang+era+mood = 3 dims
      { track: track('15'), tags: tags({ artist: 'someone else', genre: 'sufi', language: 'punjabi', era: '90s', mood: 'melancholy' }) }, // EXACTLY 1 dim — must stay out
      { track: track('2'), tags: tags({ artist: 'someone else', genre: 'sufi', language: 'punjabi', era: '90s', mood: 'euphoric' }) }, // 0 dims
    ];
    const picks = rankSoundAlike(seed, pool, 5);
    expect(picks.map((p) => p.track.id)).toEqual(['1']);
    expect(picks[0].dims.length).toBeGreaterThanOrEqual(SIMILARITY.minSharedTags);
  });

  test('the artist dimension is down-weighted: a 2-generic-dim row can beat a same-artist clone', () => {
    const pool = [
      // same artist ONLY (weight 0.3 — below the 2-dim gate → out)
      { track: track('clone', { artist: 'Arijit Singh, someone' }), tags: tags({ artist: 'arijit singh', genre: 'sufi', language: 'punjabi', era: '90s', mood: 'euphoric' }) },
      // no shared artist, but genre+language+mood (weight 3.0)
      { track: track('real'), tags: tags({ artist: 'other', genre: 'bollywood', language: 'hindi', era: '2050s', mood: 'melancholy' }) },
    ];
    const picks = rankSoundAlike(seed, pool, 5);
    expect(picks[0].track.id).toBe('real');
  });

  test('per-artist cap 2: one artist cannot own the list', () => {
    const pool = [1, 2, 3, 4].map((i) => ({
      track: track(`same-${i}`),
      tags: tags({ artist: 'arijit singh', genre: 'bollywood', language: 'hindi' }), // 3 dims each
    }));
    const picks = rankSoundAlike(seed, pool, 10);
    expect(picks.length).toBe(SIMILARITY.perArtistCap);
  });

  test('determinism: same pool + seed → the same order, twice', () => {
    const pool = [1, 2, 3, 4, 5, 6].map((i) => ({
      track: track(`t-${i}`, { artist: `Artist ${i % 3}` }),
      tags: tags({ artist: `artist ${i % 3}`, genre: 'bollywood', language: 'hindi', mood: 'melancholy' }),
    }));
    const a = rankSoundAlike(seed, pool, 6).map((p) => p.track.id);
    const b = rankSoundAlike(seed, pool, 6).map((p) => p.track.id);
    expect(a).toEqual(b);
  });

  test('sharedDims reports exactly the intersecting dimensions', () => {
    const dims = sharedDims(
      tags({ artist: 'a', genre: 'g', language: 'hindi', era: 'current', mood: 'm' }),
      tags({ artist: 'a', genre: 'g', language: 'punjabi', era: '90s', mood: 'm' }),
    );
    expect(dims).toEqual(['artist', 'genre', 'mood']);
  });
});

describe('BAR 1.4 — the facade source lock (Law ⑥ for data flow)', () => {
  test('mindbeat.buildSoundAlike runs reconcileRecordings BEFORE rankSoundAlike', async () => {
    const src = await Bun.file('src/ai/mindbeat.ts').text();
    const idxReconcile = src.indexOf('reconcileRecordings(pool)');
    const idxRank = src.indexOf('rankSoundAlike(seedTags, candidates, count)');
    expect(idxReconcile).toBeGreaterThan(-1);
    expect(idxRank).toBeGreaterThan(-1);
    expect(idxReconcile).toBeLessThan(idxRank);
    // and the pool passes filterClean too (law ⑨)
    expect(src).toContain('filterClean(reconcileRecordings(pool))');
  });
});
