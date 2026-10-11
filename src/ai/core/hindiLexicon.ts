/**
 * IITB HINDI SENTIMENT LEXICON (Wave C · C1) — the lazy expansion tier.
 *
 * The hand-curated table (romanizedMood.ts, weight 1.0) carries the
 * film-lyric vocabulary; this module carries the Hindi SentiWordNet
 * (HSWN — the IIT Bombay Hindi sentiment lexicon resource, MIT-licensed
 * mirror) baked by scripts/bake_hindi_lexicon.py into
 * assets/hindi_lexicon_iitb.json: { romanized_word: score in −1..+1 },
 * |score| >= 0.3 (strong sentiment only), 1,816 words, ~8 KB gzipped.
 *
 * LAZY + POST-PAINT (potato law ⑦): the JSON require never runs on the
 * cold-start path — mindbeat.warmHeavyTables() calls loadHindiLexicon()
 * after first paint, the same contract as the baked-features table.
 * Until then iitbScore() honestly returns null (the hand table and
 * VADER still answer).
 *
 * WEIGHT LAW: an IITB word scores at 0.6× its baked valence — the
 * academic table is evidence, not gospel; the hand-curated words keep
 * their 1.0 weight and win every tie (tokenScore checks them first).
 */

export const IITB_WEIGHT = 0.6;

let table: Record<string, number> | null = null;
let loadAttempted = false;

/** Load the baked HSWN table (idempotent; safe to call anywhere). */
export function loadHindiLexicon(): boolean {
  if (loadAttempted) return table !== null;
  loadAttempted = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    table = require('../../../assets/hindi_lexicon_iitb.json') as Record<string, number>;
  } catch {
    table = null; // honest degradation — the hand-curated table still works
  }
  return table !== null;
}

/**
 * O(1) lexicon read (X6): the word's HSWN valence in −1..+1 scaled by
 * IITB_WEIGHT, or null when the word is unknown / not yet loaded.
 */
export function iitbScore(token: string): number | null {
  if (!table) return null;
  const v = table[token];
  if (v === undefined) return null;
  return v * IITB_WEIGHT;
}

/** The loaded word count (0 until loadHindiLexicon() succeeds). */
export function hindiLexiconSize(): number {
  return table ? Object.keys(table).length : 0;
}

/** Test seam: forget the loaded table (locks re-exercise the lazy path). */
export function resetHindiLexiconForTests(): void {
  table = null;
  loadAttempted = false;
}
