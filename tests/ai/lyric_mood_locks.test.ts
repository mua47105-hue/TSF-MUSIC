/**
 * GENIUS P5 — LYRIC MOOD LOCKS (gauntlet/GENIUS-BARS.md §P5).
 *
 * Bars pinned:
 *   • LRC timestamps + section tags stripped; repeated chorus lines count
 *     ONCE (a chorus sung 3× must not triple-count)
 *   • known happy lyric → positive delta; known sad lyric → negative delta
 *   • instrumental/no lyrics/no hits → no stored score, behavior unchanged
 *   • boundedness: the pre-blend delta never leaves ±LYRIC_MOOD.maxDelta;
 *     the blend net shift never leaves ±0.15; VALENCE ONLY (energy frozen)
 *   • kv LRU: hard cap LYRIC_MOOD.maxEntries, oldest evicted
 *   • determinism: same text → same score, twice
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import {
  prepareLines,
  scoreLyrics,
  absorbScore,
  loadScoresFromKV,
  scoresToKV,
  scoreCount,
  lyricDeltaFor,
  loadLexiconsForTests,
  resetLyricMoodForTests,
  lexiconsReady,
} from '../../src/ai/core/lyricMood';
import { estimateFeatures } from '../../src/ai/core/features';
import { loadFeatureTableFromRaw } from '../../src/ai/core/featureTable';
import { LYRIC_MOOD } from '../../src/ai/core/constants';
import { recordingKey } from '../../src/api/recording';

// tiny deterministic lexicons — VADER-scale (±3) and Hindi-scale (±1)
const VADER = {
  love: 2.7, joy: 2.8, dance: 1.9, celebration: 2.4,
  cry: -2.4, tears: -2.2, lonely: -2.5, tragedy: -2.9,
};
const HINDI = {
  pyaar: 0.9, khushi: 0.9, balle: 0.9,
  judai: -0.9, dard: -0.9, tanhai: -0.8, bewafa: -0.9,
};

const HAPPY_LYRIC = `
[00:12.30]Love and joy in every breath
[00:16.10]We dance, dance, dance tonight
[Chorus]
[00:20.00]Love and joy in every breath
[00:24.00]Love and joy in every breath
`;

const SAD_LYRIC = `
[Verse]
[01:02.10]Judai, tanhai, dard remains
[01:08.44]I cry, tears fall, so lonely
[Chorus]
[01:20.00]Judai, tanhai, dard remains
[01:26.00]Judai, tanhai, dard remains
`;

beforeEach(() => {
  resetLyricMoodForTests();
  loadLexiconsForTests(VADER, HINDI);
  // the feature-space blend test needs the baked table tier loaded too
  loadFeatureTableFromRaw({
    _meta: { version: 1 },
    k: { [recordingKey({ title: 'Tum Hi Ho', artist: 'Arijit Singh' })]: { e: 0.45, v: 0.32, d: 0.53 } },
  });
});

describe('GENIUS P5 — LRC preparation', () => {
  test('stamps and section tags are stripped; repeated lines count ONCE', () => {
    const lines = prepareLines(HAPPY_LYRIC);
    // 4 lyric lines; "Love and joy..." appears 3× (chorus) → deduped to 1
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('Love and joy');
    expect(lines[1]).toContain('dance');
  });

  test('instrumental/stamp-only files → no lines → no score', () => {
    expect(prepareLines('[00:00.00]')).toEqual([]);
    expect(scoreLyrics('[00:12.00][Chorus]')).toBeNull();
  });
});

describe('GENIUS P5 — mood direction and bounds', () => {
  test('known happy lyric → positive delta; sad lyric → negative delta', () => {
    const happy = scoreLyrics(HAPPY_LYRIC)!;
    const sad = scoreLyrics(SAD_LYRIC)!;
    expect(happy.delta).toBeGreaterThan(0);
    expect(sad.delta).toBeLessThan(0);
    expect(happy.hits).toBeGreaterThanOrEqual(3);
    expect(sad.hits).toBeGreaterThanOrEqual(5);
  });

  test('bounded: even extreme text cannot leave ±maxDelta', () => {
    const extreme = Array.from({ length: 50 }, (_, i) => `${i % 2 ? 'tragedy tragedy' : 'joy joy joy'}`).join('\n');
    const s = scoreLyrics(extreme)!;
    expect(Math.abs(s.delta)).toBeLessThanOrEqual(LYRIC_MOOD.maxDelta + 1e-9);
    expect(s.delta).toBeGreaterThan(0);
  });

  test('no lexicon hits → null (no change stored, nothing shifts)', () => {
    expect(scoreLyrics('[00:01.00]la la la bamba')).toBeNull();
    expect(lyricDeltaFor('Some Song', 'Some Artist')).toBeNull();
  });

  test('determinism: same text → same score twice', () => {
    expect(JSON.stringify(scoreLyrics(SAD_LYRIC))).toBe(JSON.stringify(scoreLyrics(SAD_LYRIC)));
  });
});

describe('GENIUS P5 — the valence blend', () => {
  test('stored score shifts VALENCE ONLY; energy is frozen', () => {
    const key = recordingKey({ title: 'Tum Hi Ho', artist: 'Arijit Singh' });
    loadScoresFromKV({ [key]: { delta: -0.25, ts: Date.now(), hits: 9 } });
    const base = estimateFeatures({ artist: 'Arijit Singh', title: 'Tum Hi Ho' });
    expect(base.source).toBe('dataset'); // real table hit
    const unblended = estimateFeatures({ artist: 'Nobody Known', title: 'Unrelated Words' });
    // valence moved down by 0.6 × −0.25 = −0.15 (clamped at 0)
    expect(base.valence).toBeCloseTo(Math.max(0, 0.32 - 0.15), 5);
    expect(base.energy).toBe(0.45); // NEVER moves
    expect(unblended.source).toBe('prior');
  });

  test('no stored score → byte-identical estimate (kill-switch-shaped void)', () => {
    const a = estimateFeatures({ artist: 'Arijit Singh', title: 'Tum Hi Ho' });
    loadScoresFromKV({}); // hydrated, but empty
    const b = estimateFeatures({ artist: 'Arijit Singh', title: 'Tum Hi Ho' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('blend net shift bounded to ±(blendWeight × maxDelta)', () => {
    const key = recordingKey({ title: 'Happy Song', artist: 'Joy Singer' });
    loadScoresFromKV({ [key]: { delta: 0.25, ts: Date.now(), hits: 4 } });
    const f = estimateFeatures({ artist: 'Joy Singer', title: 'Happy Song' });
    // prior default valence 0.5 + 0.15 = 0.65 (never above 1 via clamp)
    expect(f.valence).toBeCloseTo(0.65, 5);
    expect(f.valence).toBeLessThanOrEqual(1);
  });
});

describe('GENIUS P5 — potato-phone kv discipline', () => {
  test('LRU: over maxEntries the OLDEST rows evict deterministically', () => {
    const t0 = 1_000_000;
    const kv: Record<string, { delta: number; ts: number; hits: number }> = {};
    for (let i = 0; i < LYRIC_MOOD.maxEntries + 25; i++) {
      kv[recordingKey({ title: `song${String(i).padStart(4, '0')}`, artist: 'a' })] = {
        delta: 0.1, ts: t0 + i, hits: 3,
      };
    }
    loadScoresFromKV(kv);
    absorbScore('pyaar and khushi everywhere', 'song0000', 'a'); // new row (now > all)
    // 26 oldest evicted after the insert (1026 → cap) → back at the cap
    expect(scoreCount()).toBe(LYRIC_MOOD.maxEntries);
    expect(lyricDeltaFor('song0000', 'a')).not.toBeNull(); // fresh insert survives
    expect(lyricDeltaFor('song0026', 'a')).not.toBeNull(); // newest of the old survive
    expect(lyricDeltaFor('song0025', 'a')).toBeNull(); // the oldest 26 evicted
  });

  test('kv roundtrip: scoresToKV → loadScoresFromKV keeps the deltas', () => {
    absorbScore('pyaar pyaar khushi', 'Roundtrip Song', 'RT');
    const kv = scoresToKV();
    resetLyricMoodForTests();
    loadLexiconsForTests(VADER, HINDI);
    loadScoresFromKV(kv);
    expect(lyricDeltaFor('Roundtrip Song', 'RT')).not.toBeNull();
  });

  test('lexiconsReady gates absorb (hydration contract)', () => {
    resetLyricMoodForTests();
    expect(lexiconsReady()).toBe(false);
    loadLexiconsForTests(VADER, HINDI);
    expect(lexiconsReady()).toBe(true);
  });
});
