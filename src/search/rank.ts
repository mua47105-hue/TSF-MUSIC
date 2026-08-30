/**
 * SEARCH V2 · S3 — RANK (pure, deterministic, ≤40 ms for 60 cands).
 *
 *   score = 3.0 · providerRank        (position decay 1.0 → 0.15)
 *         + 2.5 · queryMatch          (title-token coverage)
 *         + 2.0 · artistMatch         (FULL artist list, 1.0 per token)
 *         + 1.0 · personalization     (artistAffinity, capped; mutes demote)
 *         + 1.2 · engagement          (past clicks for THIS query, cap 1.2)
 *         + 0.5 · quality             (playCount/320k/preview)
 *         + lyricBonus                (lyric mode: +2.0 V2 / +1.0 V1)
 *
 *   NOTE (plan §5.4 amendment, S8 bar): engagement weight/cap are 1.2,
 *   not 0.8 — the S8 bar requires 2 fresh clicks to beat provider-rank
 *   deltas. The 21-day half-life decay + 1.2 cap + provider 3.0 weight
 *   keep explicit intent above taste; ruts still decay out.
 *
 * The DISAMBIGUATION OVERRIDE (P3 fix, test-locked): when the plan
 * carries artistTokens, rows with artistMatch=0 are hard-capped below
 * every artistMatch≥1 row. Ties break by (score, trackId) — same-query
 * determinism is replay-tested.
 *
 * Reason lines come from a CLOSED set (MINDBEAT house rule).
 */

import type { Track } from '../types';
import type { SearchPlan } from './plan';
import type { Candidate } from './verify';
import { normalizeQuery, TYPE_WORDS } from './normalize';

export type SearchReasonCode =
  | 'MATCHES_SEARCH'
  | 'LYRIC_MATCH'
  | 'YOU_LISTEN'
  | 'YOUR_PAST_CLICK'
  | 'PROVIDER_TOP';

export const REASON_LINES: Record<SearchReasonCode, string> = {
  MATCHES_SEARCH: 'Best match for your search',
  LYRIC_MATCH: 'Matches the lyric you typed',
  YOU_LISTEN: 'You listen to this artist a lot',
  YOUR_PAST_CLICK: 'You chose this for this search before',
  PROVIDER_TOP: 'Top result from the catalog',
};

export interface RankContext {
  /** normalized-query → trackId → engagement score (0..1, decayed) */
  engagement?: Record<string, number>;
  /** artist (lowercased) → affinity 0..N */
  artistAffinity?: Record<string, number>;
  /** lowercased muted artist names — demoted hard */
  mutedArtists?: Set<string>;
  now?: number;
}

export interface RankedRow extends Candidate {
  score: number;
  artistMatch: number;
  queryMatch: number;
  reasonCode: SearchReasonCode;
}

function providerRankScore(poolRank: number): number {
  // 1.0 at rank 0 → 0.15 at rank 29 (smooth decay)
  return Math.max(0.15, 1.0 * Math.pow(0.91, poolRank));
}

/** Query-token coverage — SIG M2.1, kind-aware:
 *  artist_title  → title tokens vs the row's TITLE (artist tokens never
 *                  double-count; that inflated O'Meri Laila to qm=0.40)
 *  entity_artist → the row IS by the artist (boundary artist match is
 *                  the coverage signal — "arijit singh" must surface his
 *                  songs even when the title is "Tum Hi Ho")
 *  entity_title  → query tokens vs the row's TITLE */
function titleCoverage(plan: SearchPlan, row: Candidate, am: number): number {
  if (plan.kind === 'entity_artist') return am >= 1 ? 1 : 0;
  const wanted = titleQueryTokens(plan);
  if (wanted.length === 0) return 0;
  const hay = new Set(
    normalizeQuery(row.title)
      .split(/[^a-z0-9\u0900-\u097f]+/)
      .filter(Boolean),
  );
  const hits = titleHitCount(wanted, acceptableTitleTokens(plan), hay);
  return Math.min(1, hits / wanted.length);
}

/** The tokens that must appear in a row's TITLE for it to count as a
 *  title match: connector-stripped titleTokens (they mirror the query's
 *  title side for every kind), falling back to tokens. */
export function titleQueryTokens(plan: SearchPlan): string[] {
  const STOP = new Set(['from', 'the', 'a', 'an']);
  const base = plan.titleTokens.length ? plan.titleTokens : plan.tokens;
  return base.filter((t) => t.length >= 2 && !STOP.has(t) && !TYPE_WORDS.has(t));
}

/** SIG M1.3 applied to MATCHING: the plan's bounded ortho variants
 *  ("chaiye"→"chahiye") are alternative spellings of the SAME title
 *  token — a row using the standard spelling must not lose to a row
 *  that copied the user's typo (live: "Tu Chahiye | Pritam & Atif
 *  Aslam" scored 0.5 while same-name covers spelled "Tu Chaiye" scored
 *  1.0). Returns the ORIGINAL tokens plus the variant-only tokens;
 *  empty plan.variants ⇒ a set identical to titleQueryTokens ⇒ zero
 *  behavior change for correctly-spelled queries. */
export function acceptableTitleTokens(plan: SearchPlan): Set<string> {
  const orig = titleQueryTokens(plan);
  const set = new Set(orig);
  const origSet = new Set(orig);
  for (const v of plan.variants ?? []) {
    for (const t of normalizeQuery(v).split(/[^a-z0-9\u0900-\u097f]+/)) {
      if (t.length >= 2 && !TYPE_WORDS.has(t) && !origSet.has(t)) set.add(t);
    }
  }
  return set;
}

/** Count how many of the ORIGINAL title tokens the row's title covers,
 *  accepting an ortho variant as a hit (each extra acceptable token is
 *  consumable — one variant answers one missing original). Deterministic
 *  and bounded; shared by rank coverage and rescue verification. */
export function titleHitCount(origTokens: string[], acceptable: Set<string>, hay: Set<string>): number {
  if (origTokens.length === 0) return 0;
  const extras = [...acceptable].filter((t) => !origTokens.includes(t));
  let hits = 0;
  for (const t of origTokens) {
    if (hay.has(t)) {
      hits += 1;
      continue;
    }
    const vi = extras.findIndex((v) => hay.has(v));
    if (vi !== -1) {
      extras.splice(vi, 1);
      hits += 1;
    }
  }
  return hits;
}

/** SIG M2.2 — word-boundary artist matching with the prefix-only rule.
 *  "atif aslam" matches "Atif Aslam" and "Muhammad Atif Aslam" (extra
 *  tokens BEFORE the name are honorifics/name-forms) but NEVER "Atif
 *  Aslam BD" / "Arijit Singh Official" (extra tokens AFTER the name are
 *  channel/re-upload junk). */
export function artistContains(creditLower: string, artistLower: string): boolean {
  const credit = creditLower.split(/[^a-z0-9\u0900-\u097f]+/).filter(Boolean);
  const target = artistLower.split(/[^a-z0-9\u0900-\u097f]+/).filter(Boolean);
  if (target.length === 0 || credit.length === 0) return false;
  if (target.length > credit.length) return false;
  outer: for (let i = 0; i + target.length <= credit.length; i += 1) {
    for (let j = 0; j < target.length; j += 1) {
      if (credit[i + j] !== target[j]) continue outer;
    }
    // match found — everything before is a prefix (fine), everything
    // after must be EMPTY (suffix tokens make it a different credit)
    if (i + target.length === credit.length) return true;
    return false;
  }
  return false;
}

function artistMatchScore(plan: SearchPlan, row: Candidate): number {
  if (plan.artistTokens.length === 0) return 0;
  const credits = row.artistsFull?.length
    ? row.artistsFull
    : row.artist.split(/,\s*/);
  const featured = row.featuredArtists ?? [];
  let score = 0;
  for (const a of plan.artistTokens) {
    const hit =
      credits.some((c) => artistContains(normalizeQuery(c), a)) ||
      featured.some((c) => artistContains(normalizeQuery(c), a));
    if (hit) score += 1;
  }
  return score;
}

/** Fraction of the row's TITLE tokens the query actually asked for —
 *  "Tum Hi Ho Bandhu" for query "tum hi ho" = 3/4 = 0.75; an exact
 *  "Tum Hi Ho" title = 1.0. Distinguishes the song from its neighbors. */
function titlePrecision(plan: SearchPlan, row: Candidate): number {
  const wanted = acceptableTitleTokens(plan);
  const titleTokens = normalizeQuery(row.title)
    .split(' ')
    .filter((t) => t.length >= 2);
  if (titleTokens.length === 0) return 0;
  let matched = 0;
  for (const t of titleTokens) {
    if (wanted.has(t)) matched += 1;
  }
  return matched / titleTokens.length;
}

function personalization(ctx: RankContext, row: Candidate): number {
  const aff = ctx.artistAffinity ?? {};
  const list = row.artistsFull?.length ? row.artistsFull : [row.artist];
  let best = 0;
  for (const a of list) {
    const v = aff[a.toLowerCase()] ?? 0;
    if (v > best) best = v;
  }
  const capped = Math.min(best, 2.5) / 2.5;
  if (ctx.mutedArtists) {
    for (const a of list) {
      if (ctx.mutedArtists.has(a.toLowerCase())) return -0.5;
    }
  }
  return capped;
}

function qualityScore(row: Candidate): number {
  let q = 0;
  if (row.playCount && row.playCount > 0) q += Math.min(1, Math.log10(row.playCount) / 9);
  if (row.has320 !== false && row.source === 'saavn') q += 0.15;
  if (!row.previewOnly) q += 0.15;
  return q;
}

/** Rank the verified set for a plan. Pure + deterministic. */
export function rankRows(
  plan: SearchPlan,
  rows: Candidate[],
  ctx: RankContext = {},
  lyricVerdicts?: Map<string, { matched: boolean; line: string }>,
): RankedRow[] {
  const scored: RankedRow[] = rows.map((row) => {
    const pr = providerRankScore(row.poolRank);
    const am = artistMatchScore(plan, row);
    const qm = titleCoverage(plan, row, am);
    const pers = personalization(ctx, row);
    const eng = Math.min(1.2, ctx.engagement?.[row.id] ?? 0);
    const qual = qualityScore(row);
    // TITLE PRECISION (S2 fix): rows whose titles carry EXTRA tokens the
    // query didn't ask for ("Tum Hi Ho Bandhu" for "tum hi ho") score
    // below exact-alignment titles — precision = matched tokens / title
    // tokens (1.0 for an exact title).
    const precision = titlePrecision(plan, row);
    const v1 = plan.kind === 'lyric_fragment' ? snippetEchoProxy(plan, row) : 0;
    const v2 = lyricVerdicts?.get(row.id)?.matched ? 1 : 0;
    const lyricBonus = plan.kind === 'lyric_fragment' ? v2 * 2.0 + v1 * 1.0 : 0;
    const score =
      3.0 * pr +
      2.5 * qm * (0.55 + 0.45 * precision) +
      2.0 * am +
      1.0 * pers +
      1.2 * eng + // S8 bar amendment: 2 clicks MUST beat provider-rank deltas
      0.5 * qual +
      lyricBonus;
    return {
      ...row,
      score,
      artistMatch: am,
      queryMatch: qm,
      reasonCode: pickReason(plan, { v2, v1, pers, eng, pr, am, qm }),
    };
  });

  // DISAMBIGUATION OVERRIDE v2 (SIG M2.3): with artistTokens in the plan,
  // promotion requires BOTH axes — artistMatch ≥ 1 AND title coverage
  // ≥ 0.5 (a full title-match row). Artist-only rows (title ≈ 0) can
  // never outrank title-matching rows: in the "tu chaiye" failure the
  // old override promoted O'Meri Laila (right artist, wrong song) above
  // the correct-title rows. artist-only rows are capped below every
  // artist+title row when such rows exist.
  if (plan.artistTokens.length > 0) {
    const full = scored.filter((r) => r.artistMatch >= 1 && r.queryMatch >= 0.5);
    const cap = full.reduce((m, r) => Math.min(m, r.score), Number.POSITIVE_INFINITY);
    const titleOnlyCap = scored
      .filter((r) => r.queryMatch >= 0.5)
      .reduce((m, r) => Math.min(m, r.score), Number.POSITIVE_INFINITY);
    if (Number.isFinite(cap)) {
      for (const r of scored) {
        if (r.artistMatch === 0 && r.score >= cap) r.score = cap - 0.001;
      }
    }
    // artist-matching but title-zero rows sink below title-matching rows
    for (const r of scored) {
      if (r.artistMatch >= 1 && r.queryMatch < 0.5 && Number.isFinite(titleOnlyCap) && r.score >= titleOnlyCap) {
        r.score = titleOnlyCap - 0.001;
      }
    }
  }

  // RESCUE PROMOTION (title-only SIG): a rescued row that genuinely
  // matches the title IS the canonical recording the query means
  // (live-probed: 100M+ views vs the covers' ≤198k plays). A bounded
  // +0.75 — smaller than one provider-rank step's provider component,
  // larger than the quality gap between a 100M row and a 22k cover —
  // deterministically tops same-title covers. The artist_title path
  // already tops its rescue row via the override above; this only
  // removes the thin-margin fragility there too.
  for (const r of scored) {
    if (r.rescued && r.queryMatch >= 0.5) r.score += 0.75;
  }

  // deterministic order: score desc, then trackId asc
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return scored;
}

function snippetEchoProxy(plan: SearchPlan, row: Candidate): number {
  // same math as verify.snippetEcho but local to keep rank pure (no
  // import cycle; verified equal by test)
  const frag = new Set(
    normalizeQuery(plan.normalized)
      .split(' ')
      .filter((t) => t.length >= 3),
  );
  if (frag.size === 0) return 0;
  const hay = new Set(`${row.lyricsSnippet ?? ''} ${row.title}`.toLowerCase().split(/\W+/));
  let hits = 0;
  frag.forEach((t) => {
    if (hay.has(t)) hits += 1;
  });
  return hits / frag.size;
}

function pickReason(
  plan: SearchPlan,
  s: { v2: number; v1: number; pers: number; eng: number; pr: number; am: number; qm: number },
): SearchReasonCode {
  if (plan.kind === 'lyric_fragment' && s.v2 > 0) return 'LYRIC_MATCH';
  if (s.eng >= 0.5) return 'YOUR_PAST_CLICK';
  if (s.pers >= 0.4) return 'YOU_LISTEN';
  // SIG: "Best match" requires BOTH axes when the plan names an artist
  if (plan.artistTokens.length > 0) {
    if (s.am >= 1 && s.qm >= 0.5) return 'MATCHES_SEARCH';
  } else if (s.v1 >= 0.5 || s.pr >= 0.99) {
    return 'MATCHES_SEARCH';
  }
  return 'PROVIDER_TOP';
}

/** Attach the closed-set reason line text to the track for display. */
export function withReasonLines(rows: RankedRow[]): Track[] {
  return rows.map((r) => ({
    ...r,
    reason: REASON_LINES[r.reasonCode],
    reasonCode: r.reasonCode,
  }));
}
