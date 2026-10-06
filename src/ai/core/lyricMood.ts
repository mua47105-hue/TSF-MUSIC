/**
 * LYRIC MOOD READER (Phase 5 — "the words say how it feels").
 *
 * A pure, tiny sentiment read over fetched lyrics: VADER (MIT) carries
 * the English lexicon; a generated romanized Hindi/Punjabi table
 * (romanizedMood.ts) carries the catalog's mother tongue. The read:
 *
 *   • LRC timestamps + [Chorus]/[Verse] tags are stripped
 *   • REPEATED LINES ARE DEDUPED — a chorus sung three times must not
 *     count three times (the whole song's balance stays intact)
 *   • tokens hit the lexicons; the mean maps to a valence delta bounded
 *     at ±LYRIC_MOOD.maxDelta (±0.25) — a nudge, never a rewrite
 *   • ONLY valence moves. Energy is never touched by lyrics.
 *
 * Async discipline: scoring runs after the lyric fetch completes, off
 * the critical path; results cache per recordingKey (LRU 1000, kv).
 */

import { LYRIC_MOOD } from './constants';
import { ROMANIZED_MOOD } from './romanizedMood';
import type { TrackFeatures } from './types';
import { clamp } from './time';

/** The VADER JSON: word → mean valence in −4..4 (raw VADER scale). */
// eslint-disable-next-line @typescript-eslint/no-var-requires
let vader: Record<string, number> | null = null;
try {
  vader = require('../../../assets/vader_lexicon.json') as Record<string, number>;
} catch {
  vader = null; // honest degradation — the romanized table still works
}

export interface LyricMood {
  /** Mean lexicon valence in −1..1 (already normalized). */
  score: number;
  /** Tokens with a lexicon hit. */
  hits: number;
  /** Total word tokens read (post-dedup). */
  words: number;
  /** Lines that survived dedup (the unique lyric). */
  lines: number;
}

/** Strip LRC timestamps ([00:12.34] / [00:12]) and any [bracketed] tags. */
export function stripLyricMarkup(raw: string): string[] {
  const lines = String(raw ?? '')
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\]/g, ' ') // timestamps
        .replace(/\[[^\]]{0,40}\]/g, ' ') // section tags [Chorus] etc.
        .replace(/<\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?>/g, ' ') // word-sync tags
        .trim(),
    )
    .filter((line) => line.length > 0 && !/^\s*(作词|作曲|lyrics?\s*[:：]|composer\s*[:：])/i.test(line));
  return lines;
}

function tokenize(line: string): string[] {
  return line
    .toLowerCase()
    .split(/[^a-z0-9'\u0900-\u097f]+/i)
    .filter((t) => t.length > 1);
}

/** Lexicon score for one token in −1..1 (romanized table wins ties — it
 *  is the domain-specific reading; VADER normalizes by /4). */
export function tokenScore(token: string): number | null {
  const rom = ROMANIZED_MOOD[token];
  if (rom !== undefined) return rom;
  const v = vader?.[token];
  if (v !== undefined) return clamp(v / 4, -1, 1);
  return null;
}

/**
 * Score the lyrics. Chorus dedup: identical lines count ONCE (first
 * occurrence keeps the order; every repeat after that is dropped) —
 * the read is of the SONG, not of the singer's memory.
 */
export function scoreLyrics(raw: string): LyricMood | null {
  const lines = stripLyricMarkup(raw);
  if (!lines.length) return null;
  const seen = new Set<string>();
  let scoreSum = 0;
  let hits = 0;
  let words = 0;
  let uniqueLines = 0;
  for (const line of lines) {
    const key = line.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(key)) continue; // chorus repeat — counts once
    seen.add(key);
    uniqueLines += 1;
    for (const tok of tokenize(line)) {
      words += 1;
      const s = tokenScore(tok);
      if (s !== null) {
        hits += 1;
        scoreSum += s;
      }
    }
  }
  if (!hits || !words) return { score: 0, hits: 0, words, lines: uniqueLines };
  const mean = clamp(scoreSum / hits, -1, 1);
  return { score: mean, hits, words, lines: uniqueLines };
}

/**
 * Lyric read → bounded valence delta. Below LYRIC_MOOD.minHits lexicon
 * hits the read is noise and the answer is null (no shift).
 */
export function moodToValenceDelta(mood: LyricMood | null): number | null {
  if (!mood || mood.hits < LYRIC_MOOD.minHits) return null;
  return clamp(mood.score, -1, 1) * LYRIC_MOOD.maxDelta;
}

/**
 * Blend the lyric delta into a feature estimate. ONLY valence moves;
 * energy is byte-identical (mission law). Source: 'lyric' when the base
 * was a heuristic, preserved when the base was the baked table (the
 * dataset row remains the ground-truth-ish carrier — BAR 2.2 caps the
 * calibration applied ON TOP of either).
 */
export function blendLyricValence(base: TrackFeatures, delta: number): TrackFeatures {
  if (!delta) return base;
  return {
    energy: base.energy, // NEVER touched by lyrics
    valence: clamp(base.valence + delta, 0, 1),
    tempoClass: base.tempoClass,
    confidence: Math.max(base.confidence, LYRIC_MOOD.confidence),
    source: base.source === 'dataset' ? 'dataset' : 'lyric',
  };
}
