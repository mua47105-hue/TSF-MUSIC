/**
 * SEARCH V2 · S0 support — deterministic query normalization.
 *
 * The single canonical text pipeline every search stage shares (S0 plan,
 * S2 verify, S3 rank, lyric containment). Pure functions, unit-tested;
 * same input → same output on every platform.
 *
 *   normalizeQuery(): NFC fold → lowercase → diacritic fold →
 *                     punctuation strip (keep ' inside words) →
 *                     Hinglish variance fold → whitespace collapse
 *   tokenize():        normalize → split on non-word → drop empties
 *   foldHinglish():    bounded variant map (hai/hain, kyun/kyu/kion…)
 */

/** Bounded Hinglish/common-romanization variance folds (cited, §5.1).
 *  Keys and values are already-normalized tokens. */
const HINGLISH_FOLDS: Record<string, string> = {
  // verb/copula variance
  hai: 'hai', hain: 'hai', hein: 'hai',
  hoon: 'hu', hun: 'hu',
  nahi: 'nahi', naheen: 'nahi', nahin: 'nahi', nai: 'nahi',
  kyun: 'kyu', kion: 'kyu', kyon: 'kyu', kiun: 'kyu',
  tum: 'tum', thum: 'tum', tho: 'tum',
  faya: 'faya', faaya: 'faya',
  pyar: 'pyaar',
  // english plural/style variance that matters for matching
  songs: 'song', gaane: 'gaana', gane: 'gaana',
};

/** Normalize a raw user string into canonical search text. */
export function normalizeQuery(raw: string): string {
  let s = String(raw ?? '');
  // 1. NFC + lowercase
  s = s.normalize('NFC').toLowerCase();
  // 2. Diacritic fold (é→e, ā→a …) — Devanagari passes through untouched
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');
  // 3. Strip punctuation EXCEPT apostrophes/hyphens inside words
  //    ("don't" / "plug-in" stay single tokens; repeats collapse)
  s = s.replace(/[.,/\\|!?;:()\[\]{}<>"“”‘’…—–_*#@$%^+=~`]/g, ' ');
  s = s.replace(/(['-])\s+/g, ' ').replace(/\s+(['-])/g, ' ');
  s = s.replace(/(['-]){2,}/g, '$1');
  // 4. Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** Tokenize a normalized string into word tokens. */
export function tokenize(normalized: string): string[] {
  return normalized.split(/[^a-z0-9'&\u0900-\u097f-]+/i).filter(Boolean);
}

/** Fold token-level Hinglish variance (bounded map above). */
export function foldToken(tok: string): string {
  return HINGLISH_FOLDS[tok] ?? tok;
}

/** Full pipeline: normalize → tokens (variance-folded). */
export function normalizeTokens(raw: string): string[] {
  return tokenize(normalizeQuery(raw)).map(foldToken);
}

/**
 * Version-cluster key for S2: normalized title with release/feat/remix/
 * cover decorations stripped, so "Tum Hi Ho (From "Aashiqui 2")" and
 * "Tum Hi Ho" share a key but "Tum Hi Ho Bandhu" never does.
 *
 * Decoration stripping runs on the RAW lowercase title (before the
 * punctuation-stripping normalizer — it would eat the parens/dashes
 * these patterns need to match).
 */
export function clusterKey(title: string): string {
  let t = String(title ?? '')
    .normalize('NFC')
    .toLowerCase();
  // drop parenthetical/suffix release decorations
  t = t.replace(/\(from[^)]*\)/g, ' ');
  t = t.replace(/\([^)]*(version|remix|cover|reprise|unplugged|mix|edit|live|acoustic|instrumental|motion picture|film|movie)[^)]*\)/g, ' ');
  t = t.replace(/\bfeat\b\.?\s.*$/, ' ').replace(/\bft\b\.?\s.*$/, ' ');
  t = t.replace(/\b(remix|cover|reprise|unplugged|acoustic|instrumental|karaoke|version|mix|edit|live)\b/g, ' ');
  t = t.replace(/\s*-\s*(cover|remix|live|acoustic)\b.*$/g, ' ');
  // normalize the remainder (strips leftover punctuation, folds variance)
  return normalizeQuery(t);
}

/** Type words that carry no entity signal (S4 relaxation strips them). */
export const TYPE_WORDS = new Set([
  'song', 'songs', 'gaana', 'gaane', 'track', 'video', 'mp3', 'mp4',
  'download', 'audio', 'lyrics', 'lyric',
]);

/**
 * Natural-language connectors (SIG M1.1): when a user phrases a request
 * like "tu chaiye OF atif aslam" the connector is grammar, not part of
 * the song title — it must never pollute the title probe. Stripped from
 * titleTokens + all probe strings; kept in `raw` for display.
 */
export const CONNECTOR_WORDS = new Set([
  'of', 'by', 'from', 'ka', 'ki', 'ke', 'se', 'and', 'with', 'feat', 'ft',
  'saath', 'the', 'a', 'an',
]);
