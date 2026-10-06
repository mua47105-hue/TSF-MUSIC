/**
 * GENIUS P5 — LYRIC MOOD READING (valence from words, not audio).
 *
 * When lyrics arrive (LRCLIB, already fetched by the app), score their
 * mood with the bundled lexicons — VADER (MIT, English) + the curated
 * romanized Hindi/Punjabi list — and store a per-recording valence DELTA
 * the feature space can blend in (VALENCE ONLY, never energy).
 *
 * Honesty contract:
 *   • lyrics are a HINT, not truth: the delta is bounded ±LYRIC_MOOD.maxDelta
 *     (pre-blend), and the blend weight (0.6) shrinks the net effect to ±0.15
 *   • repeated chorus lines are counted ONCE (a chorus sung 3× must not
 *     triple-count)
 *   • no lyrics / no lexicon hits → no stored delta → byte-identical behavior
 *   • runs ONLY async after the lyrics fetch completes — never on a
 *     critical path; the kill switch blocks every write
 *
 * Potato-phone contract: the kv table is keyed by recordingKey with a hard
 * cap of LYRIC_MOOD.maxEntries (LRU by ts) ≈ 60 KB worst case; the in-memory
 * mirror is the SAME map (no second copy); the lexicons hydrate once,
 * post-paint, and release their raw objects after the Maps are built.
 */

import { LYRIC_MOOD } from './constants';
import { clamp } from './time';
import { recordingKey } from '../../api/recording';
import { tokenize, foldToken } from '../../search/normalize';

export interface LyricScore {
  /** Bounded valence delta in [−maxDelta, +maxDelta]. */
  delta: number;
  /** When the score was computed (LRU ordering). */
  ts: number;
  hits: number; // evidence count — diagnostics/honesty
}

/** word → score map shape of the bundled lexicon assets. */
type Lexicon = Record<string, number>;

let vader: Map<string, number> | null = null;
let hindi: Map<string, number> | null = null;
let scores: Map<string, LyricScore> = new Map(); // recordingKey → score
let hydrated = false;
let hydrateStarted = false;

// ── LRC text preparation ────────────────────────────────────────────────

const LRC_STAMP = /\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/g;
const SECTION_TAG = /\[[^\]]*\]/g;

/** Normalize one line for dedupe: stamps/tags stripped, tokens sorted —
 *  reorderings of the same words count as the same line. */
function lineKey(line: string): string {
  const toks = tokenize(normalizeLine(line)).map(foldToken);
  return toks.sort().join(' ');
}

function normalizeLine(line: string): string {
  return line.replace(LRC_STAMP, ' ').replace(SECTION_TAG, ' ');
}

/**
 * Prepare lyrics: strip LRC timestamps + section tags, drop empties, and
 * DEDUPE repeated lines (the chorus sung 3× counts once). Returns the
 * unique lines in first-seen order.
 */
export function prepareLines(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = normalizeLine(rawLine).trim();
    if (!line) continue;
    const key = lineKey(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

// ── scoring ─────────────────────────────────────────────────────────────

/**
 * Score prepared lyric text → valence delta in [−maxDelta, +maxDelta],
 * or null when nothing usable hit (no lyrics, no lexicon words — the
 * caller stores nothing and behavior stays byte-identical).
 *
 * Per-hit normalization: VADER means span roughly ±3, so they are scaled
 * into the ±1 hint scale (LYRIC_MOOD.vaderScale) before averaging with
 * the Hindi list (already ±1). Deterministic: pure arithmetic.
 */
export function scoreLyrics(text: string): LyricScore | null {
  if (!vader && !hindi) return null;
  const lines = prepareLines(text);
  if (!lines.length) return null;
  let sum = 0;
  let hits = 0;
  for (const line of lines) {
    for (const tok of tokenize(line)) {
      const key = foldToken(tok);
      const hit = vader?.get(key) ?? hindi?.get(key);
      if (hit == null) continue;
      sum += clamp(hit / LYRIC_MOOD.vaderScale, -1, 1);
      hits += 1;
    }
  }
  if (!hits) return null;
  const avg = clamp(sum / hits, -1, 1);
  return { delta: round3(avg * LYRIC_MOOD.maxDelta), ts: Date.now(), hits };
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

// ── persistence (kv LRU) ────────────────────────────────────────────────

/** kv shape: recordingKey → score. Cap enforced on every write. */
type ScoreKV = Record<string, LyricScore>;

export function loadScoresFromKV(kv: ScoreKV | null): void {
  scores = new Map(Object.entries(kv ?? {}));
  hydrated = true;
}

export function scoresToKV(): ScoreKV {
  return Object.fromEntries(scores);
}

export function scoreCount(): number {
  return scores.size;
}

/** Absorb fetched lyrics for a track — compute + store (LRU-capped). */
export function absorbScore(text: string, title?: string, artist?: string): LyricScore | null {
  if (!hydrated) return null; // never write before the (post-paint) hydrate
  const key = recordingKey({ title: title ?? '', artist: artist ?? '' });
  if (!key || key.startsWith('anon|')) return null; // identity-less rows never score
  const score = scoreLyrics(text);
  if (!score) return null;
  score.ts = Date.now();
  scores.set(key, score);
  evictLRU();
  return score;
}

/** Read path for the feature space (sync, in-memory, O(1)). */
export function lyricDeltaFor(title?: string, artist?: string): number | null {
  if (!scores.size) return null;
  const key = recordingKey({ title: title ?? '', artist: artist ?? '' });
  const s = key ? scores.get(key) : undefined;
  return s?.delta ?? null;
}

function evictLRU(): void {
  if (scores.size <= LYRIC_MOOD.maxEntries) return;
  const oldest = [...scores.entries()]
    .sort((a, b) => a[1].ts - b[1].ts || (a[0] < b[0] ? -1 : 1))
    .slice(0, scores.size - LYRIC_MOOD.maxEntries);
  for (const [k] of oldest) scores.delete(k);
}

// ── lexicon hydration (post-paint, once) ────────────────────────────────

/** Lazy asset hydration — called AFTER first paint, never at import. */
export function hydrateLexicons(): void {
  if (hydrateStarted) return;
  hydrateStarted = true;
  try {
    // Deferred requires: materialized post-paint, moved into Maps, and the
    // raw object's entries deleted as they move (no second copy alive).
    const vaderRaw = require('../../../assets/vader_lexicon.json') as Lexicon;
    vader = moveLexicon(vaderRaw);
    const hindiRaw = require('../../../assets/hindi_lexicon.json') as Lexicon;
    hindi = moveLexicon(hindiRaw);
  } catch {
    // assets missing → scoring returns null → behavior unchanged
    vader = null;
    hindi = null;
  }
}

function moveLexicon(raw: Lexicon): Map<string, number> {
  const map = new Map<string, number>();
  for (const key of Object.keys(raw)) {
    const v = raw[key];
    if (typeof v === 'number' && Number.isFinite(v)) map.set(key, v);
    delete raw[key];
  }
  return map;
}

export function lexiconsReady(): boolean {
  return vader != null || hindi != null;
}

// ── test seams ──────────────────────────────────────────────────────────

export function loadLexiconsForTests(v: Lexicon | null, h: Lexicon | null): void {
  vader = v ? new Map(Object.entries(v)) : null;
  hindi = h ? new Map(Object.entries(h)) : null;
  hydrated = true;
}

export function resetLyricMoodForTests(): void {
  vader = null;
  hindi = null;
  scores = new Map();
  hydrated = false;
  hydrateStarted = false;
}
