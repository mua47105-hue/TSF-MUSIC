/**
 * PHASE 5 + BAR 1.2 LOCKS — the lyric mood reader.
 *
 *   1. BAR 1.2: the ±0.25 valence clamp is asserted with the HARDCODED
 *      LITERAL 0.25 — NOT LYRIC_MOOD.maxDelta (a constant-referencing
 *      test could silently widen with the constant).
 *   2. LRC timestamps + section tags strip clean.
 *   3. CHORUS DEDUP: a chorus sung three times counts ONCE.
 *   4. below minHits the read is null (no shift).
 *   5. ONLY valence moves — energy is byte-identical.
 *   6. the real VADER + romanized assets load and hit real words.
 */

import { describe, expect, test } from 'bun:test';
import {
  stripLyricMarkup,
  scoreLyrics,
  moodToValenceDelta,
  blendLyricValence,
  tokenScore,
} from '../../src/ai/core/lyricMood';
import { ROMANIZED_MOOD } from '../../src/ai/core/romanizedMood';
import { LYRIC_MOOD } from '../../src/ai/core/constants';
import type { TrackFeatures } from '../../src/ai/core/types';

const base: TrackFeatures = {
  energy: 0.7,
  valence: 0.4,
  tempoClass: 'mid',
  confidence: 0.5,
  source: 'prior',
};

describe('BAR 1.2 — the literal clamp', () => {
  test('the delta can NEVER exceed the literal 0.25 — even for an extreme read', () => {
    const extreme: import('../../src/ai/core/lyricMood').LyricMood = {
      score: 1, // maximally positive
      hits: 500,
      words: 500,
      lines: 40,
    };
    const delta = moodToValenceDelta(extreme)!;
    // THE LOCK — the literal, on purpose. Do not replace with the constant.
    expect(delta).toBeLessThanOrEqual(0.25);
    expect(delta).toBe(0.25);

    const dark: import('../../src/ai/core/lyricMood').LyricMood = { score: -1, hits: 500, words: 500, lines: 40 };
    expect(moodToValenceDelta(dark)).toBe(-0.25);
  });

  test('the blend output is bounded no matter what the base was', () => {
    const out = blendLyricValence(base, 0.25);
    expect(out.valence).toBeLessThanOrEqual(0.65);
    const out2 = blendLyricValence({ ...base, valence: 0.9 }, 0.25);
    expect(out2.valence).toBeLessThanOrEqual(1);
  });

  test('sanity: the shipped constant matches the literal it is locked to', () => {
    // if someone changes LYRIC_MOOD.maxDelta, this test plus the literal
    // assertions above both fail — the pair cannot drift silently.
    expect(LYRIC_MOOD.maxDelta).toBe(0.25);
  });
});

describe('phase 5 — lyric parsing', () => {
  test('LRC timestamps + section tags strip clean', () => {
    const lines = stripLyricMarkup(
      '[00:12.34]Tum hi ho\n[00:18.90]Ab tum hi ho\n[Chorus]\n[00:25.01]Zindagi kuch toh bata',
    );
    expect(lines).toEqual(['Tum hi ho', 'Ab tum hi ho', 'Zindagi kuch toh bata']);
  });

  test('CHORUS DEDUP: a chorus sung 3× scores once', () => {
    const chorus = 'I love you, I need you, happy days';
    const verse = 'walking down the lonely street at midnight';
    const sungThrice = [verse, chorus, verse + ' (reprise tail)', chorus, chorus].join('\n');
    const mood = scoreLyrics(sungThrice)!;
    // unique lines: verse, chorus, reprise-variant = 3 — the two chorus
    // repeats contribute ZERO extra lexicon hits
    expect(mood.lines).toBe(3);
  });

  test('a heavy sad read scores negative, a bright read positive', () => {
    const sad = scoreLyrics('tanhai judai dard aansu bewafa dhoka akela andhera\njudai judai dard');
    expect(sad).not.toBeNull();
    expect(sad!.hits).toBeGreaterThanOrEqual(LYRIC_MOOD.minHits);
    expect(sad!.score).toBeLessThan(0);

    const bright = scoreLyrics('pyaar khushi balle balle nach masti yaari\npyaar khushi');
    expect(bright!.score).toBeGreaterThan(0);
  });

  test('below minHits the read is null (no shift from noise)', () => {
    const mood = scoreLyrics('the quick brown fox jumps over the lazy dog'); // neutral words
    expect(mood!.hits).toBeLessThan(LYRIC_MOOD.minHits);
    expect(moodToValenceDelta(mood)).toBeNull();
  });

  test('the real lexicon assets ship and hit real words', () => {
    // VADER (English)
    expect(tokenScore('love')).not.toBeNull();
    expect(tokenScore('disaster')).not.toBeNull();
    // romanized Hindi/Punjabi table (generated, ~300 words)
    expect(ROMANIZED_MOOD['pyaar']).toBeGreaterThan(0.5);
    expect(ROMANIZED_MOOD['bewafa']).toBeLessThan(-0.5);
    // romanized wins when both lexicons know the token? 'judai' is only
    // in the romanized table; VADER-only tokens still resolve.
    expect(tokenScore('judai')).toBeLessThan(0);
  });
});

describe('phase 5 — the blend', () => {
  test('ONLY valence moves — energy is byte-identical', () => {
    const out = blendLyricValence(base, -0.2);
    expect(out.energy).toBe(base.energy);
    expect(out.valence).toBeCloseTo(base.valence - 0.2, 10);
    expect(out.tempoClass).toBe(base.tempoClass);
  });

  test('a heuristic base becomes source lyric at ≥0.6 confidence', () => {
    const out = blendLyricValence(base, 0.1);
    expect(out.source).toBe('lyric');
    expect(out.confidence).toBeGreaterThanOrEqual(LYRIC_MOOD.confidence);
  });

  test('a dataset base KEEPS the dataset carrier (BAR 2.2 caps calibration on it)', () => {
    const ds: TrackFeatures = { ...base, source: 'dataset', confidence: 0.8 };
    const out = blendLyricValence(ds, 0.15);
    expect(out.source).toBe('dataset');
    expect(out.valence).toBeCloseTo(ds.valence + 0.15, 10);
  });

  test('zero delta returns the base untouched', () => {
    expect(blendLyricValence(base, 0)).toBe(base);
  });
});
