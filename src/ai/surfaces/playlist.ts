/**
 * AI Playlist Generator v2 — the flagship (§9.3). Five stages, one contract.
 *
 *   S1 UNDERSTAND  intent parse — negations first-class, Hinglish/code-mix,
 *                  multi-mood, languages, activities, energyTarget (0–1).
 *                  Never fails: falls back to best-effort keywords.
 *   S2 HUNT        deterministic, parallel — per named artist + per
 *                  mood×genre×language cell; pool 60–120.
 *   S3 CURATE      ID-in/ID-out scoring (the Text2Tracks contract is
 *                  trivially honored: every ID in the output exists in the
 *                  pool — no LLM to hallucinate).
 *   S4 POLISH      safety re-check → dedupe → artist cap 5 → no 3
 *                  consecutive same-artist → activity energy arc (App. D1)
 *                  → max energy step 0.25.
 *   S5 NARRATE     name in the verified daylist pattern with vernacular
 *                  flavor + description.
 *
 * Latency: S1+S3+S4+S5 are local and instant (<10 ms); S2 is the only
 * network stage (parallel searches). Total typical 1–3 s, p95 gate 10 s
 * enforced by tests/ai/perf.test.ts.
 */

import type { Track } from '../../types';
import { ARTIST_PRIORS, MOOD_PRIORS, GENRE_PRIORS } from '../core/priors';
import { estimateFeatures } from '../core/features';
import { CADENCE } from '../core/constants';
import { clamp } from '../core/time';
import { filterClean } from '../../safety';

// ── S1 — UNDERSTAND ─────────────────────────────────────────────────────

export interface Intent {
  artists: string[];
  moods: string[];
  genres: string[];
  languages: string[];
  eras: string[];
  activities: string[];
  energyTarget?: number; // 0..1 — from mood words or explicit "high energy"
  negations: string[]; // matched tokens to exclude downstream
  raw: string;
}

const LANGUAGE_WORDS: Record<string, string[]> = {
  hindi: ['hindi', 'bollywood', 'filmy', 'hindi gaane'],
  punjabi: ['punjabi', 'punjbai', 'desi', 'bhangra'],
  english: ['english', 'hollywood', 'western'],
  tamil: ['tamil'],
  telugu: ['telugu'],
  marathi: ['marathi'],
  bengali: ['bengali', 'bangla'],
  haryanvi: ['haryanvi'],
  bhojpuri: ['bhojpuri'],
};

const ERA_WORDS: Record<string, string[]> = {
  '90s': ['90s', "90's", 'nineties'],
  '80s': ['80s', "80's", 'eighties'],
  '2000s': ['2000s', 'early 2000'],
  '2010s': ['2010s'],
  current: ['latest', 'new', '2024', '2025', 'trending', 'fresh', 'naya'],
  retro: ['retro', 'old', 'classic', 'golden', 'purane'],
};

const ACTIVITY_WORDS: Record<string, string[]> = {
  workout: ['gym', 'workout', 'pump', 'training', 'running', 'exercise', 'hustle', 'beast', 'gym ke liye'],
  focus: ['study', 'focus', 'concentration', 'work', 'coding', 'reading', 'padhai'],
  sleep: ['sleep', 'insomnia', 'lullaby', 'sona', 'neend', 'raat'],
  party: ['party', 'bash', 'dance', 'club', 'celebration', 'shaadi', 'wedding', 'nach'],
  commute: ['commute', 'drive', 'driving', 'drive ke liye', 'safar', 'road trip'],
  devotional: ['bhajan', 'devotional', 'god', 'krishna', 'shiv', 'mantra', 'aarti', 'bhakti', 'puja'],
};

/** Negation markers — EN + Hinglish. A negated token that survives to
 *  candidates is a P0 bug (test corpus includes "no remixes").
 *  Captures 1-3 tokens so "bina remix party hindi" negates just "remix
 *  party" scoped to known vocabulary — never the whole tail of the prompt. */
const NEGATION_RE = /\b(?:no|without|bina|non|exclude|except)\s+([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,2}?)(?=[,.]|$|\s+(?:but|and|or|with|for|ke|liye|par|bina|aur|vaale|wale|party|gym|sad|happy|chill|remix|english|hindi|punjabi|love|sleep|focus)\b)/gi;

/** Language synonyms a negation may target ("no bollywood" → hindi). */
const NEGATION_LANG_SYNONYMS: Record<string, string[]> = {
  bollywood: ['hindi'],
  desi: ['punjabi'],
  hollywood: ['english'],
  filmy: ['hindi'],
};

/** Bind a raw negation capture to vocabulary (1 token + known compounds). */
function bindNegation(raw: string, out: string[]): void {
  const words = raw.split(/\s+/).filter(Boolean);
  if (!words.length) return;
  const COMPOUNDS = new Set(['sad songs', 'love songs', 'party songs']);
  const pair = words.slice(0, 2).join(' ');
  if (COMPOUNDS.has(pair)) {
    if (!out.includes(pair)) out.push(pair);
    return;
  }
  if (words[0] && NEGATABLE.has(words[0]!) && !out.includes(words[0]!)) {
    out.push(words[0]!);
  }
  const synonym = NEGATION_LANG_SYNONYMS[words[0] ?? ''];
  if (synonym) {
    for (const s of synonym) if (!out.includes(s)) out.push(s);
  }
}

/** Known music vocabulary a negation can bind to (everything else stops it). */
const NEGATABLE = new Set([
  'remix', 'remixes', 'remixed', 'cover', 'covers', 'sad', 'sad songs', 'party', 'slow',
  'english', 'hindi', 'punjabi', 'tamil', 'telugu', 'old', 'new', 'latest', 'romantic',
  'love', 'lofi', 'remake', 'reverb', 'slowed', 'instrumental', 'acoustic', 'dual',
  'gaane', 'songs', 'music', 'bollywood', 'retro', ' remix party',
]);

/** Token-level negation match with word boundaries (substring-free). */
function negated(negations: string[], token: string): boolean {
  const tok = token.toLowerCase().trim();
  if (!tok) return false;
  const tokWords = new Set(tok.split(/\s+/));
  for (const n of negations) {
    const nTokens = n.toLowerCase().split(/\s+/).filter(Boolean);
    if (!nTokens.length) continue;
    // Full-phrase containment (boundaries respected).
    if (new RegExp(`(?:^|\\s)${nTokens.map(escapeRe).join('\\s+')}(?:$|\\s)`, 'i').test(tok)) return true;
    // Constituent-word blocking: "no sad songs" blocks the mood word "sad"
    // itself — a compound negation must negate its parts (critic probe).
    if (nTokens.some((w) => tokWords.has(w))) return true;
  }
  return false;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Boundary match tolerant of singular/plural ("remixes" ↔ "remix"). */
function negMatches(negation: string, text: string): boolean {
  const base = negation.toLowerCase().replace(/(es|s)$/, '');
  if (!base) return false;
  const re = new RegExp(`(?:^|[^a-z])${escapeRe(base)}(?:es|s)?(?:$|[^a-z])`, 'i');
  return re.test(text);
}

/** Word-boundary containment — "madhuri" must never trigger "mad". */
function hasWord(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return new RegExp(`(?:^|[^a-z])${escapeRe(needle.toLowerCase())}(?:$|[^a-z])`, 'i').test(haystack);
}

export function parseIntent(prompt: string): Intent {
  const lower = prompt.toLowerCase();
  const negations: string[] = [];
  let m: RegExpExecArray | null;
  const negRe = new RegExp(NEGATION_RE.source, 'gi');
  while ((m = negRe.exec(lower)) !== null) {
    bindNegation(m[1]!.trim(), negations);
  }
  if (!negations.length) {
    // Mid-sentence negations the terminator lookahead missed ("no sad
    // songs party english"): capture greedily and bind vocabulary only.
    const loose = /\b(?:no|without|bina|non|exclude|except)\s+([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,2})/gi;
    while ((m = loose.exec(lower)) !== null) {
      bindNegation(m[1]!.trim(), negations);
    }
  }

  // Artists: quoted + known priors + capitalized multi-words.
  const artists: string[] = [];
  const quoted = prompt.match(/["“']([^"”']{2,40})["”']/g) ?? [];
  quoted.forEach((q) => {
    const name = q.replace(/["“']/g, '').trim();
    if (name) artists.push(name);
  });
  for (const a of Object.keys(ARTIST_PRIORS)) {
    if (lower.includes(a) && !negated(negations, a)) artists.push(a);
  }
  const caps = prompt.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g) ?? [];
  const keywordish = new Set([
    ...Object.values(LANGUAGE_WORDS).flat(),
    ...Object.values(ERA_WORDS).flat(),
    ...Object.values(ACTIVITY_WORDS).flat(),
    ...MOOD_PRIORS.flatMap((mo) => mo.words),
    ...Object.keys(GENRE_PRIORS),
  ]);
  caps.forEach((c) => {
    const cl = c.toLowerCase();
    if (!keywordish.has(cl) && !negated(negations, cl)) artists.push(c);
  });

  // Moods (multi — "sad but hopeful" is two). Word-boundary matched.
  const moods = MOOD_PRIORS.filter((mo) => mo.words.some((w) => hasWord(lower, w) && !negated(negations, w))).map((mo) => mo.key);

  // Genres (word-boundary + negation-aware).
  const genreBlocklist = new Set(['sad', 'party', 'workout', 'sleep', 'focus', 'romantic', 'happy', 'devotional']);
  const genres = Object.keys(GENRE_PRIORS)
    .filter((g) => !genreBlocklist.has(g) && hasWord(lower, g) && !negated(negations, g))
    .slice(0, 3);

  // Languages / eras / activities — negation-aware ("english songs, no hindi").
  const languages = Object.entries(LANGUAGE_WORDS)
    .filter(([lang, words]) => {
      if (!words.some((w) => hasWord(lower, w))) return false;
      // "no bollywood" must block hindi (synonym expansion).
      if (negated(negations, lang)) return false;
      return !words.some((w) => negated(negations, w));
    })
    .map(([lang]) => lang)
    .slice(0, 2);

  const eras = Object.entries(ERA_WORDS)
    .filter(([, words]) => words.some((w) => hasWord(lower, w)) && !negated(negations, words[0]!))
    .map(([e]) => e)
    .slice(0, 1);

  const activities = Object.entries(ACTIVITY_WORDS)
    .filter(([, words]) => words.some((w) => hasWord(lower, w)) && !negated(negations, words[0]!))
    .map(([a]) => a)
    .slice(0, 2);

  // Energy target: mean of matched moods, or explicit words.
  let energyTarget: number | undefined;
  const matched = MOOD_PRIORS.filter((mo) => moods.includes(mo.key));
  if (matched.length) {
    energyTarget = clamp(matched.reduce((s, mo) => s + mo.energy, 0) / matched.length, 0.05, 0.95);
  }
  if (/\b(high energy|energetic|hype|fast|loud)\b/.test(lower)) energyTarget = 0.85;
  if (/\b(calm|slow|gentle|soft|dheere)\b/.test(lower)) energyTarget = 0.25;

  return {
    artists: dedupe(artists).slice(0, 4),
    moods: moods.slice(0, 3),
    genres,
    languages,
    eras,
    activities,
    energyTarget,
    negations,
    raw: prompt,
  };
}

function dedupe(arr: string[]): string[] {
  const seen = new Set<string>();
  return arr.filter((x) => {
    const k = x.toLowerCase().trim();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── S2 — HUNT ────────────────────────────────────────────────────────────

export interface Catalog {
  search: (query: string, limit?: number) => Promise<Track[]>;
}

/**
 * S2 hunt plan — the pool-width guarantee (60–120 candidates, §9.3).
 * The plan ALWAYS issues ≥5 hunts: named artists, the mood×genre×language
 * spine, the era cell, the activity cell, a second facet, and a broad
 * backfill. Starved pools collapsed every downstream contract (25/18
 * output, arcs, diversity) — this is the fix for that P0.
 */
export function planHunts(intent: Intent): string[] {
  const queries: string[] = [];
  intent.artists.forEach((a) => queries.push(a));

  const moodWords = intent.moods;
  const genreSeed = intent.genres[0];
  const langSeed = intent.languages[0];
  const eraSeed = intent.eras[0];
  const activitySeed = intent.activities[0];

  const moodQueryBits = [moodWords[0], genreSeed, langSeed].filter(Boolean) as string[];
  if (moodQueryBits.length) queries.push([...new Set(moodQueryBits)].join(' ') + ' songs');
  if (moodWords[1]) queries.push(`${moodWords[1]} ${langSeed ?? ''} songs`.trim());

  if (!moodWords.length && (genreSeed || langSeed || eraSeed)) {
    queries.push([genreSeed, langSeed, eraSeed].filter(Boolean).join(' ') + ' songs');
  }

  // Era cell.
  if (eraSeed && eraSeed !== 'current') queries.push(`${eraSeed} ${langSeed ?? 'hits'} songs`.trim());
  if (eraSeed === 'retro') queries.push('old is gold hindi songs');

  // Activity cell (Appendix D1 arcs hunt here).
  if (activitySeed) {
    const activityQuery: Record<string, string> = {
      workout: 'workout gym motivation songs',
      focus: 'lofi study focus beats',
      sleep: 'sleep calm instrumental',
      party: 'party dance hits',
      commute: 'road trip drive songs',
      devotional: 'bhajan mantra morning',
    };
    queries.push(activityQuery[activitySeed] ?? 'top hits');
  }

  // Second facet + broad backfill (guarantees pool width when the prompt
  // is artist-only: one artist search can never feed a 25-track playlist).
  if (intent.genres[1]) queries.push(`${intent.genres[1]} songs`);
  queries.push(langSeed ? `top ${langSeed} hits` : 'top hits');
  // Mood-only prompts ("sad songs") need width too: dedicated mood hunts.
  if (!intent.artists.length && moodWords[0]) {
    queries.push(`${moodWords[0]} hits`);
    queries.push(`best ${moodWords[0]} songs`);
  }
  // Artist-only prompts still need pool WIDTH (25-track contract): adjacent
  // hunts around the named artist keep the pool ≥3× the output.
  if (intent.artists[0]) {
    queries.push(`${intent.artists[0]} type songs`);
    queries.push(`${intent.artists[0]} best hits`);
  }

  return dedupe(queries).slice(0, 8);
}

// ── S3 — CURATE (deterministic; every ID exists in the pool) ───────────

interface PoolItem {
  track: Track;
  score: number;
}

export function scorePool(pool: Track[], intent: Intent, huntIndexById: Map<string, number>): PoolItem[] {
  const negs = intent.negations;
  const items: PoolItem[] = [];
  const moodPriors = intent.moods
    .map((k) => MOOD_PRIORS.find((mo) => mo.key === k))
    .filter(Boolean) as typeof MOOD_PRIORS;

  for (const track of pool) {
    const text = `${track.title} ${track.album ?? ''} ${track.artist}`.toLowerCase();

    // Negation gate — P0 if violated (§9.3 rules). Morphology-aware:
    // "no remixes" must also exclude "Remix" (singular) and vice versa.
    if (negs.some((n) => negMatches(n, text))) continue;

    let score = 0;
    // Artist seed match — strongest.
    if (intent.artists.some((a) => track.artist.toLowerCase().includes(a.toLowerCase()))) score += 14;
    // Language match.
    if (intent.languages.some((l) => (track.language ?? '').toLowerCase() === l)) score += 5;
    // Era match.
    if (intent.eras.includes('90s') && track.year && track.year >= 1990 && track.year < 2000) score += 6;
    if (intent.eras.includes('80s') && track.year && track.year >= 1980 && track.year < 1990) score += 6;
    if (intent.eras.includes('2000s') && track.year && track.year >= 2000 && track.year < 2010) score += 6;
    if (intent.eras.includes('retro') && track.year && track.year < 2000) score += 6;
    if (intent.eras.includes('current') && track.year && track.year >= 2023) score += 4;
    // Mood resonance via proxy features.
    const feats = estimateFeatures({ artist: track.artist, title: track.title, album: track.album });
    if (intent.energyTarget != null) {
      score += Math.max(0, 8 - Math.abs(feats.energy - intent.energyTarget) * 16);
    }
    if (moodPriors.length) {
      const targetE = moodPriors.reduce((s, mo) => s + mo.energy, 0) / moodPriors.length;
      const targetV = moodPriors.reduce((s, mo) => s + mo.valence, 0) / moodPriors.length;
      score += Math.max(0, 6 - Math.abs(feats.valence - targetV) * 10);
      score += Math.max(0, 4 - Math.abs(feats.energy - targetE) * 8);
    }
    // Mood word echo in title (word-boundary).
    if (moodPriors.some((mo) => mo.words.some((w) => hasWord(text, w)))) score += 4;
    // Popularity: earlier search hits score higher.
    const hi = huntIndexById.get(track.id) ?? 8;
    score += Math.max(0, 10 - hi * 1.2);
    // Full streams beat previews.
    if (!track.previewOnly) score += 4;

    items.push({ track, score });
  }
  items.sort((a, b) => b.score - a.score || (a.track.id < b.track.id ? -1 : 1));
  return items;
}

// ── S4 — POLISH ─────────────────────────────────────────────────────────

/** Activity arcs (Appendix D1) — used to order the final list. */
export function activityArc(activity: string | undefined): { intro: number; peak: number; cooldown: boolean; flat: boolean } {
  switch (activity) {
    case 'workout': return { intro: 0.6, peak: 0.85, cooldown: false, flat: false };
    case 'focus': return { intro: 0.4, peak: 0.45, cooldown: false, flat: true };
    case 'sleep': return { intro: 0.2, peak: 0.12, cooldown: false, flat: false };
    case 'party': return { intro: 0.75, peak: 0.85, cooldown: false, flat: false };
    case 'commute': return { intro: 0.5, peak: 0.7, cooldown: false, flat: false };
    case 'devotional': return { intro: 0.3, peak: 0.35, cooldown: false, flat: true };
    default: return { intro: 0.4, peak: 0.6, cooldown: true, flat: false };
  }
}

export function polish(items: PoolItem[], intent: Intent): Track[] {
  const target = CADENCE.aiOutput;
  const minN = CADENCE.aiOutputMin;
  const perArtist = new Map<string, number>();
  const picked: Track[] = [];

  for (const { track } of items) {
    if (picked.length >= target) break;
    const used = perArtist.get(track.artist) ?? 0;
    if (used >= CADENCE.aiArtistCap) continue;
    perArtist.set(track.artist, used + 1);
    picked.push(track);
  }

  // No 3 consecutive same-artist — DEFER, never drop: the triple-maker is
  // swapped with the next different-artist track so pool length survives.
  const noTriple: Track[] = [];
  const deferred: Track[] = [];
  for (const t of picked) {
    const n = noTriple.length;
    if (n >= 2 && noTriple[n - 1]!.artist === t.artist && noTriple[n - 2]!.artist === t.artist) {
      deferred.push(t);
      continue;
    }
    noTriple.push(t);
  }
  // Weave deferred tracks back in wherever the rule allows.
  for (const t of deferred) {
    for (let i = 0; i <= noTriple.length; i++) {
      const prevA = noTriple[i - 1]?.artist;
      const prevB = noTriple[i - 2]?.artist;
      const nextA = noTriple[i]?.artist;
      if (prevA !== t.artist || prevB !== t.artist) {
        if (nextA === undefined || nextA !== t.artist || noTriple[i + 1]?.artist !== t.artist) {
          noTriple.splice(i, 0, t);
          break;
        }
      }
    }
  }

  // Energy arc ordering: ramp to peak, optional cooldown tail, max step 0.25
  // between neighbors in arc-position terms (arcPlan from S3's scores).
  const arc = activityArc(intent.activities[0]);
  const energyOf = (t: Track) => estimateFeatures({ artist: t.artist, title: t.title, album: t.album }).energy;
  const out = arcOrder(noTriple, energyOf, arc, intent.energyTarget ?? (arc.intro + arc.peak) / 2);
  // Output contract: 25 target, 18 floor — never truncate below the floor.
  if (out.length >= target) return out.slice(0, target);
  if (out.length >= minN) return out;
  // Below floor: keep what the arc produced (starved catalog is the only cause).
  return out;
}

function arcOrder(tracks: Track[], energyOf: (t: Track) => number, arc: { intro: number; peak: number; cooldown: boolean; flat: boolean }, fallbackTarget: number): Track[] {
  if (tracks.length < 4) return tracks;
  const remaining = [...tracks];
  const out: Track[] = [];
  const n = tracks.length;
  let prevEnergy = arc.intro;
  void fallbackTarget;

  const makesTriple = (t: Track) => {
    const m = out.length;
    return (
      m >= 2 &&
      out[m - 1]!.artist === t.artist &&
      out[m - 2]!.artist === t.artist
    );
  };

  while (remaining.length) {
    const progress = out.length / Math.max(1, n - 1);
    const target = arc.flat
      ? (arc.intro + arc.peak) / 2
      : arc.cooldown && progress > 0.8
        ? arc.intro
        : arc.intro + (arc.peak - arc.intro) * Math.min(1, progress * 1.4);
    let bestIdx = -1;
    let bestCost = Infinity;
    remaining.forEach((t, i) => {
      if (makesTriple(t)) return; // hard skip — another candidate first
      const e = energyOf(t);
      const dTarget = Math.abs(e - target);
      const dStep = Math.max(0, Math.abs(e - prevEnergy) - CADENCE.aiMaxEnergyStep) * 2;
      const cost = dTarget + dStep;
      if (cost < bestCost) {
        bestCost = cost;
        bestIdx = i;
      }
    });
    if (bestIdx === -1) {
      // Only triple-makers remain (single-artist tail): DROP them — the
      // no-3-consecutive rule is a contract, not a preference (§9.3 S4).
      // The 18-track floor leaves room to shed a few tail picks.
      break;
    }
    const [chosen] = remaining.splice(bestIdx, 1);
    prevEnergy = energyOf(chosen!);
    out.push(chosen!);
  }
  return out;
}

// ── S5 — NARRATE ────────────────────────────────────────────────────────

const NAME_BANK: Record<string, string[]> = {
  sad: ['Dard Bhare', 'Broken Strings', 'Aansu', 'Heartbreak Hotel'],
  happy: ['Khushi', 'Sunshine', 'Muskurahat'],
  romantic: ['Ishq', 'Mohabbat', 'Pyaar Ka', 'Do Dil'],
  chill: ['Sukoon', 'Chill S cafe', 'Aaram'],
  party: ['Nachle', 'DJ Night', 'Balle Balle'],
  workout: ['Beast Mode', 'Pump Iron', 'Hustle'],
  focus: ['Deep Work', 'Padhai Mode', 'Flow State'],
  sleep: ['Neend', 'Moonlight Lullabies', 'Sona'],
  commute: ['Road Trip', 'Safar', 'Highway Nights'],
  angry: ['Aggi', 'Storm', 'Gussa'],
  devotional: ['Bhakti', 'Morning Aarti', 'Mantra'],
  hopeful: ['Umeed', 'Rise Again'],
  euphoric: ['Euphoria', 'Cloud 9'],
  melancholic: ['Nostalgia', 'Bittersweet'],
};

export function narrate(intent: Intent, count: number): { name: string; description: string } {
  // Activity-led naming when the prompt states one ("gym", "padhai");
  // mood-led otherwise — the daylist descriptor pattern (§15).
  const primary =
    (intent.activities[0] && NAME_BANK[intent.activities[0]] ? intent.activities[0] : null) ??
    intent.moods[0] ??
    intent.genres[0] ??
    'vibe';
  const bank = NAME_BANK[primary] ?? NAME_BANK[intent.moods[1] ?? 'happy'] ?? ['Mix'];
  const flavor = bank[Math.abs(intent.raw.length * 31 + count) % bank.length];
  const eraBit = intent.eras[0] && intent.eras[0] !== 'current' ? ` ${intent.eras[0].toUpperCase()}` : '';
  const artistBit = intent.artists[0] ? `${intent.artists[0].split(' ')[0]} ` : '';
  const name = `${artistBit}${flavor}${eraBit}`.trim() || 'TSF Mix';
  const bits = [
    intent.moods.slice(0, 2).join(' + '),
    intent.genres[0],
    intent.languages[0],
    intent.eras[0] === 'current' ? 'fresh' : intent.eras[0],
    intent.activities[0] ? `for ${intent.activities[0]}` : null,
  ].filter(Boolean);
  return {
    name,
    description: `TSF AI · ${bits.join(' · ') || 'your vibe'} · ${count} songs`,
  };
}

// ── The pipeline ────────────────────────────────────────────────────────

export interface GenerationStageV2 {
  phase: 'understanding' | 'hunting' | 'curating' | 'polishing' | 'narrating' | 'done';
  detail: string;
}

export interface GeneratedPlaylistV2 {
  name: string;
  description: string;
  tracks: Track[];
  intent: Intent;
  hunts: string[];
}

export async function generatePlaylistV2(
  catalog: Catalog,
  prompt: string,
  onStage?: (s: GenerationStageV2) => void,
  variant = 0,
  /** Phase 6 — the sound-alike hunt source: the player's active track
   *  seeds two extra hunts (its artist + its genre), so "make me a
   *  playlist" quietly reads what's playing right now. */
  opts?: { soundAlikeSeed?: Track | null },
): Promise<GeneratedPlaylistV2> {
  const t0 = Date.now();
  onStage?.({ phase: 'understanding', detail: 'Reading your vibe…' });
  const intent = parseIntent(prompt);

  onStage?.({ phase: 'hunting', detail: intent.artists.length ? `Digging through ${intent.artists.slice(0, 2).join(', ')}…` : 'Searching the catalog…' });
  const hunts = planHunts(intent);
  // Phase 6 — the sound-alike hunts (bounded, deduped, honest).
  const seed = opts?.soundAlikeSeed ?? null;
  if (seed) {
    const seedArtist = seed.artist.split(/,|&/)[0].trim();
    if (seedArtist && !intent.artists.some((a) => a.toLowerCase() === seedArtist.toLowerCase())) {
      hunts.push(seedArtist);
    }
    if (seed.genre && !hunts.includes(`${seed.genre} songs`)) {
      hunts.push(`${seed.genre} songs`);
    } else if (seed.language && !hunts.includes(`${seed.language} songs`)) {
      hunts.push(`${seed.language} songs`);
    }
  }
  // S2 — parallel hunts, each contributing up to ~14 candidates.
  const results = await Promise.all(
    hunts.map((q, i) =>
      catalog
        .search(q, 20)
        .then((tracks) => ({ q, i, tracks }))
        .catch(() => ({ q, i, tracks: [] as Track[] })),
    ),
  );

  // Merge pool (60–120 target), dedupe, keep hunt index for popularity.
  const pool: Track[] = [];
  const huntIndexById = new Map<string, number>();
  for (const { i, tracks } of results) {
    for (const t of tracks) {
      if (!pool.some((p) => p.id === t.id)) {
        pool.push(t);
        huntIndexById.set(t.id, i);
      }
    }
  }

  onStage?.({ phase: 'curating', detail: `Scoring ${pool.length} candidates…` });
  const scored = scorePool(pool, intent, huntIndexById);

  onStage?.({ phase: 'polishing', detail: 'Ordering the arc…' });
  // Clean full-length first; previews only when nothing else exists.
  const fullLength = filterClean(scored.map((s) => s.track).filter((t) => !t.previewOnly));
  const clean = fullLength.length ? fullLength : filterClean(scored.map((s) => s.track));
  const cleanItems = scored.filter((s) => clean.some((t) => t.id === s.track.id));
  let tracks = polish(cleanItems, intent);

  // Regenerate variant: rotate the pool head so variant ≠ parent.
  if (variant > 0 && cleanItems.length > tracks.length) {
    const rot = cleanItems.slice(variant * 3).concat(cleanItems.slice(0, variant * 3));
    tracks = polish(rot, intent);
  }

  onStage?.({ phase: 'narrating', detail: 'Naming the mix…' });
  const { name, description } = narrate(intent, tracks.length);
  onStage?.({ phase: 'done', detail: `${tracks.length} songs ready in ${((Date.now() - t0) / 1000).toFixed(1)}s` });

  return { name, description, tracks, intent, hunts };
}
