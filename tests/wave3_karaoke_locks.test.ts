/**
 * MAGNUM OPUS WAVE 3 · F12 — KARAOKE LOCKS.
 *
 * The bar: fixture LRC → the correct word at each timestamp (the
 * character-weighted interpolation); graceful degradation (no span /
 * single word → line-level, structurally); the no-drift law (the word
 * index only ever operates WITHIN the line activeLrcIndex picked); the
 * LRC is parsed ONCE (memoized — never per tick).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseLrc, withWordSpans, activeWord, activeLrcIndex, type WordLine } from '../src/player/singalong';

const FIXTURE_LRC = [
  '[00:10.00]Tum hi ho ab tum hi ho',
  '[00:14.00]Channa mereya mereya',
  '[00:18.00]Beloved',
  '[00:25.50]Ve maahi ve maahi ve',
].join('\n');

const WORDS = withWordSpans(parseLrc(FIXTURE_LRC));

describe('F12 · withWordSpans — the honest interpolation', () => {
  test('line spans chain: endMs = next line start; only the LAST line owns the tail', () => {
    expect(WORDS[0].tMs).toBe(10000);
    expect(WORDS[0].endMs).toBe(14000); // next line's start
    expect(WORDS[2].text).toBe('Beloved');
    expect(WORDS[2].endMs).toBe(25500); // a middle line chains to its successor
    expect(WORDS[3].endMs).toBe(25500 + 6000); // the LAST line sings the 6000ms tail (literal)
  });

  test('character-weighted split: longer words hold the mic proportionally', () => {
    // line 0: "Tum hi ho ab tum hi ho" — 6 words, span 10.00→14.00 (4000ms)
    const line = WORDS[0];
    expect(line.words.map((w) => w.word)).toEqual(['Tum', 'hi', 'ho', 'ab', 'tum', 'hi', 'ho']);
    // weights: Tum(3) hi(2) ho(2) ab(2) tum(3) hi(2) ho(2) — total 16
    const total = line.words.reduce((s, w) => s + w.word.length, 0);
    expect(total).toBe(16);
    // first word: 3/16 of 4000 = 750ms → [10000, 10750]
    expect(line.words[0]).toEqual({ word: 'Tum', startMs: 10000, endMs: 10750 });
    // the spans chain word-to-word with no gaps
    for (let i = 1; i < line.words.length; i++) {
      expect(line.words[i].startMs).toBe(line.words[i - 1].endMs);
    }
    // and the last word owns the line's true end (rounding residue)
    expect(line.words[line.words.length - 1].endMs).toBe(14000);
  });

  test('degradation is STRUCTURAL: single-word and zero-span lines carry NO words', () => {
    expect(WORDS[2].words).toEqual([]); // "Beloved" — one word, nothing to interpolate
    expect(withWordSpans([{ tMs: 5000, text: 'one' }])[0].words).toEqual([]);
    // a zero/negative span (equal timestamps) degrades too
    expect(withWordSpans([{ tMs: 5000, text: 'a b' }, { tMs: 5000, text: 'c d' }])[0].words).toEqual([]);
  });
});

describe('F12 · activeWord — the selector', () => {
  test('the correct word at each timestamp (line 0, 4s span)', () => {
    const line: WordLine = WORDS[0];
    expect(activeWord(line, 9999)).toBe(-1); // before the line
    expect(activeWord(line, 10000)).toBe(0); // "Tum"
    expect(activeWord(line, 10750)).toBe(1); // "hi" (second word, 2/16 = 500ms → [10750,11250])
    expect(activeWord(line, 11000)).toBe(1);
    expect(activeWord(line, 11250)).toBe(2); // "ho"
    expect(activeWord(line, 13999)).toBe(6); // still the last word just before the line ends
    expect(activeWord(line, 14000)).toBe(-1); // the line is over
  });

  test('degraded lines return -1 (the renderer falls back to the line look)', () => {
    expect(activeWord(WORDS[2], 20000)).toBe(-1);
    expect(activeWord(WORDS[2], 21000)).toBe(-1);
  });

  test('NO DRIFT: the word index only exists INSIDE the activeLrcIndex pick', () => {
    const lines = parseLrc(FIXTURE_LRC);
    // at 12.5s the active line is 0; the word selector agrees
    const idx = activeLrcIndex(lines, 12500);
    expect(idx).toBe(0);
    const w = activeWord(WORDS[idx], 12500);
    expect(w).toBeGreaterThanOrEqual(0);
    expect(WORDS[idx].words[w].startMs).toBeLessThanOrEqual(12500);
    // and a position that would belong to line 1 NEVER gets a word from line 0
    expect(activeWord(WORDS[0], 14500)).toBe(-1);
  });

  test('the parse happens ONCE per song (memoized), never per tick', () => {
    const screen = readFileSync('src/screens/PlayerScreen.tsx', 'utf8');
    // exactly one parseLrc call site, inside the track-change effect
    expect(screen.match(/parseLrc\(/g)?.length).toBe(1);
    const sing = readFileSync('src/components/SingAlong.tsx', 'utf8');
    // the word timeline rides the SAME memo — withWordSpans inside useMemo
    expect(sing).toMatch(/useMemo\(\(\) => withWordSpans\(lines\), \[lines\]\)/);
  });
});
