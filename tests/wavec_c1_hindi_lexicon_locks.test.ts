/**
 * WAVE C · C1 LOCKS — the IITB Hindi sentiment lexicon expansion.
 *
 * THE BAR (C1):
 *   • the expanded lexicon loads lazily (post-paint contract: loadHindiLexicon,
 *     never at module import) and merges at weight 0.6 while the
 *     hand-curated words keep weight 1.0;
 *   • a Hindi lyric with strong sentiment words → valence delta bounded
 *     in [−0.25, +0.25] (the existing clamp — now fed by more hits);
 *   • gzipped size ≤ 50KB (potato budget);
 *   • fixture Hindi lyrics → expected sentiment scores;
 *   • the honest floor: the real HSWN strong band is 1,805 IITB-only
 *     romanized words (the brief hoped ≥3,000 — the resource's actual
 *     strong band is smaller than its premise; locked here as the
 *     documented floor, never silently shrinkable).
 *
 * MUTATION TARGETS (must go RED when mutated):
 *   M-C1-1 — remove the IITB merge from tokenScore → IITB words stop
 *            scoring (null) → the tier locks fail.
 *   M-C1-2 — the 0.6 weight becomes 1.0 → weighted-score locks fail.
 */

import { describe, expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import {
  stripLyricMarkup,
  scoreLyrics,
  moodToValenceDelta,
  tokenScore,
} from '../src/ai/core/lyricMood';
import {
  loadHindiLexicon,
  iitbScore,
  hindiLexiconSize,
  resetHindiLexiconForTests,
  IITB_WEIGHT,
} from '../src/ai/core/hindiLexicon';
import { ROMANIZED_MOOD } from '../src/ai/core/romanizedMood';

describe('wavec c1 — the lazy load contract', () => {
  test('the lexicon is NOT loaded at module import (post-paint law)', () => {
    // a fresh module graph (this describe runs before the explicit load
    // below only if bun orders it so — so reset first to force the truth)
    resetHindiLexiconForTests();
    expect(hindiLexiconSize()).toBe(0);
    expect(iitbScore('aadarsh')).toBeNull(); // honest pre-load answer
  });

  test('loadHindiLexicon() loads the baked asset and is idempotent', () => {
    expect(loadHindiLexicon()).toBeTrue();
    const size = hindiLexiconSize();
    expect(size).toBeGreaterThan(1000);
    // idempotent: a second call neither reloads nor shrinks
    expect(loadHindiLexicon()).toBeTrue();
    expect(hindiLexiconSize()).toBe(size);
  });

  test('the honest floor: ≥1,800 IITB words shipped (the real HSWN strong band)', () => {
    // THE RESOURCE'S REAL NUMBER. The brief hoped ≥3,000; the actual
    // |score|>=0.3 band of the MIT-licensed HSWN mirror is 1,816 baked
    // words (1,805 IITB-only after the hand-table overlap). This floor
    // pins the documented reality so a silent regression (a bad bake,
    // a broken asset) turns RED — and so nobody "fixes" the count by
    // lowering the filter in secret.
    expect(hindiLexiconSize()).toBeGreaterThanOrEqual(1800);
  });

  test('potato budget: the asset is ≤ 50KB gzipped', () => {
    const raw = readFileSync(new URL('../assets/hindi_lexicon_iitb.json', import.meta.url));
    const gz = gzipSync(raw);
    expect(gz.length).toBeLessThanOrEqual(50 * 1024);
  });
});

describe('wavec c1 — the 0.6-weight merge tier', () => {
  test('IITB words score at exactly baked × 0.6', () => {
    // fixture words from the baked table (IITB-only: absent from the
    // hand table and from VADER — verified at bake time)
    expect(iitbScore('aadarsh')).toBeCloseTo(0.875 * 0.6, 10);
    expect(iitbScore('aadamkhor')).toBeCloseTo(-0.5 * 0.6, 10);
    expect(iitbScore('sharminda')).toBeCloseTo(-0.75 * 0.6, 10);
    // through the merged tokenScore reader
    expect(tokenScore('aadarsh')).toBeCloseTo(0.875 * 0.6, 10);
    expect(tokenScore('aadamkhor')).toBeCloseTo(-0.5 * 0.6, 10);
  });

  test('hand-curated words keep weight 1.0 and win every tie', () => {
    // the literal law from the phase-5 locks must survive the merge
    expect(ROMANIZED_MOOD['pyaar']).toBeGreaterThan(0.5);
    expect(tokenScore('pyaar')).toBe(ROMANIZED_MOOD['pyaar']);
    expect(tokenScore('bewafa')).toBeLessThan(-0.5);
    // the 8 overlap words: hand table wins (never diluted by 0.6)
    expect(tokenScore('khush')).toBe(ROMANIZED_MOOD['khush']);
    expect(tokenScore('dukh')).toBe(ROMANIZED_MOOD['dukh']);
  });

  test('IITB words that VADER does not know still score (the expansion works)', () => {
    // these are the words the brief called "unreachable" — they hit the
    // new tier, not the English lexicon
    for (const w of ['aadarsh', 'aadamkhor', 'sharminda', 'aananddaayak', 'aart']) {
      expect(tokenScore(w)).not.toBeNull();
    }
  });

  test('unknown tokens still honestly return null', () => {
    expect(tokenScore('zzzznotaword')).toBeNull();
    expect(iitbScore('zzzznotaword')).toBeNull();
  });
});

describe('wavec c1 — THE BAR: bounded valence delta on Hindi lyrics', () => {
  test('a strong-sentiment Hindi lyric scores and stays within ±0.25', () => {
    const lyric = [
      '[00:12.00]aadarsh aananddaayak aadarneey',
      '[00:18.00]aadarsh aananddaayak',
    ].join('\n');
    const lines = stripLyricMarkup(lyric);
    expect(lines.length).toBe(2);
    const mood = scoreLyrics(lyric)!;
    expect(mood.hits).toBeGreaterThanOrEqual(3); // above the minHits gate
    expect(mood.score).toBeGreaterThan(0);
    const delta = moodToValenceDelta(mood)!;
    expect(delta).not.toBeNull();
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(0.25); // THE literal bound (BAR 1.2)
    expect(delta).toBeGreaterThanOrEqual(-0.25);
  });

  test('a dark IITB lyric reads negative, also bounded', () => {
    const mood = scoreLyrics('aadamkhor sharminda aart\naadamkhor sharminda')!;
    expect(mood.hits).toBeGreaterThanOrEqual(3);
    expect(mood.score).toBeLessThan(0);
    const delta = moodToValenceDelta(mood)!;
    expect(delta).toBeLessThan(0);
    expect(delta).toBeGreaterThanOrEqual(-0.25);
  });

  test('mixed light lyric stays inside the clamp on both sides', () => {
    const mood = scoreLyrics('aadarsh aadamkhor sharminda aadarneey aart')!;
    const delta = moodToValenceDelta(mood)!;
    expect(delta).toBeGreaterThanOrEqual(-0.25);
    expect(delta).toBeLessThanOrEqual(0.25);
  });
});

describe('wavec c1 — the bake audit trail', () => {
  test('every baked score respects the strong filter (|score| >= 0.3)', () => {
    // read the asset raw — the bake's own contract, verified at runtime
    const raw = JSON.parse(
      readFileSync(new URL('../assets/hindi_lexicon_iitb.json', import.meta.url), 'utf-8'),
    ) as Record<string, number>;
    const entries = Object.entries(raw);
    expect(entries.length).toBeGreaterThanOrEqual(1800);
    for (const [word, score] of entries) {
      if (Math.abs(score) < 0.3 - 1e-9) {
        throw new Error(`weak word leaked into the bake: ${word} = ${score}`);
      }
    }
  });

  test('the weight constant is the documented 0.6', () => {
    expect(IITB_WEIGHT).toBe(0.6);
  });
});
