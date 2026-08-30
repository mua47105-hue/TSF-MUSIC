/**
 * SEARCH V2 — the engine orchestrator (S0→S5) behind searchMusicV2.
 *
 * The old single-call `searchMusic()` stays for compatibility; V2:
 *   S0 plan (classify + SymSpell)  →  S1 parallel probes (abortable)
 *   →  S2 id-dedupe + version-cluster (+ lyric verify V1 now / V2 async)
 *   →  S3 rank (deterministic + truthful reasons)  →  paint
 *   →  S4 relaxation ladder if thin  →  S5 learn (after paint, void)
 *
 * Cache-first: LRU hits return in <15 ms. Progressive paint: `onEarly`
 * fires the moment the primary pool is ranked (t≈P1 latency), the
 * final promise resolves at max(probes).
 */

import type { SearchResult, Track, SigState } from '../types';
import type { SearchPlan } from '../search/plan';
import { planSearch, correctedQuery, registerArtistLexicon, registerVibeVocab } from '../search/plan';
import { retrieve, rememberResults } from '../search/retrieve';
import { verifySet, verifyLyrics, snippetEcho, type Candidate } from '../search/verify';
import { rankRows, withReasonLines, type RankedRow } from '../search/rank';
import { RELAXATION_RUNGS, THIN_THRESHOLD } from '../search/recover';
import {
  recallResolve,
  engagementForQuery,
  type LearnDeps,
} from '../search/learn';
import { ARTIST_PRIORS, MOOD_PRIORS, GENRE_PRIORS } from '../ai/core/priors';
import { ARTIST_SEEDS } from './artists';
import { getRecentSearches } from '../storage/store';
import { searchItunes } from './itunes';
import { searchSaavn } from './saavn';
import { searchLyricByFragment } from './lrclib';
import { buildLexicon, lexiconReady, restoreLexicon, snapshotLexicon, SNAPSHOT_KEY } from '../search/lexicon';
import { sigUnmet, runRescueLadder, titleAuthorityMissing } from '../search/rescue';
import { ytSearchMusic } from './youtube';

export interface SearchV2Result extends SearchResult {
  plan: SearchPlan;
  topReason?: string;
  corrected?: string;
  relaxedFrom?: string;
  relaxedQuery?: string;
  latencyMs: number;
  correlationId: string;
  probes?: string[];
  /** SIG (§3.1): the declared four-state outcome — the UI must show it */
  sigState?: SigState;
  /** title-matching pool artists for the S-PARTIAL disambiguation chips */
  partialArtists?: string[];
}

/** Deps the engine needs from the host app (mindbeat on-device). */
export interface EngineDeps extends LearnDeps {
  artistAffinity?: (artist: string) => number;
  mutedArtists?: () => Set<string>;
}

let lexiconInitPromise: Promise<void> | null = null;

/** Assemble the SymSpell lexicon + classifier vocab (lazy, once). */
export async function initSearchEngine(
  deps?: EngineDeps,
  extraArtists: string[] = [],
): Promise<void> {
  if (lexiconInitPromise) return lexiconInitPromise;
  lexiconInitPromise = (async () => {
    // 1. classifier vocab — vibe words from the MINDBEAT priors
    const vibeWords = new Set<string>();
    for (const m of MOOD_PRIORS) {
      vibeWords.add(m.key);
      (m.words ?? []).forEach((w: string) => vibeWords.add(w));
    }
    Object.keys(GENRE_PRIORS).forEach((g) => vibeWords.add(g));
    registerVibeVocab(Array.from(vibeWords));

    // 2. artist lexicon — priors + seeds + caller extras (profile tops)
    const artists = [
      ...Object.keys(ARTIST_PRIORS),
      ...ARTIST_SEEDS.map((a) => a.name),
      ...extraArtists,
    ];
    registerArtistLexicon(artists);

    // 3. SymSpell — snapshot restore first, scratch build as fallback
    let restored = false;
    if (deps) {
      const snap = await deps.kvGet<string>(SNAPSHOT_KEY).catch(() => null);
      if (snap) restored = restoreLexicon(snap);
    }
    if (!restored && !lexiconReady()) {
      const recents = await getRecentSearches().catch(() => [] as string[]);
      buildLexicon([artists, Array.from(vibeWords)], recents);
    }
  })();
  return lexiconInitPromise;
}

/** Persist the lexicon snapshot (fire-and-forget after searches). */
export function persistLexicon(deps: EngineDeps): void {
  void deps.kvSet(SNAPSHOT_KEY, snapshotLexicon()).catch(() => undefined);
}

function correlationId(): string {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function toTrackList(ranked: RankedRow[]): Track[] {
  return withReasonLines(ranked).map((t) => ({
    ...t,
    planKind: t.planKind,
  }));
}

export interface SearchV2Options {
  signal?: AbortSignal;
  deps?: EngineDeps;
  /** progressive paint: ranked primary pool before slow probes finish */
  onEarly?: (r: SearchV2Result) => void;
}

/**
 * The V2 search pipeline. Never throws — failures degrade to empty.
 */
export async function searchMusicV2(
  query: string,
  opts: SearchV2Options = {},
): Promise<SearchV2Result> {
  const t0 = Date.now();
  const deps = opts.deps;
  await initSearchEngine(deps);
  const plan = planSearch(query);
  const corrId = correlationId();
  const corrected = correctedQuery(plan) ?? undefined;

  const base = {
    plan,
    corrected,
    correlationId: corrId,
  };

  if (plan.kind === 'browse') {
    return { tracks: [], degraded: false, latencyMs: 0, probes: [], ...base };
  }

  // ── S5 learning reads fire CONCURRENTLY with S1 (P0-4 fix): the
  //    probes are NEVER blocked by the ledger scan / kv reads, and a
  //    cache hit answers before learning even lands.
  const learningPromise: Promise<{
    engagement: Record<string, number>;
    muted: Set<string>;
    resolved: Track | null;
  }> =
    deps && !deps.disabled()
      ? Promise.all([
          engagementForQuery(deps, plan.normalized),
          Promise.resolve(deps.mutedArtists?.() ?? new Set<string>()),
          recallResolve(deps, plan.normalized).then(
            (r): Track | null =>
              r
                ? ({
                    id: r.trackId,
                    saavnId: r.saavnId,
                    title: r.title,
                    artist: r.artist,
                    source: 'saavn' as const,
                  } as Track)
                : null,
          ),
        ]).then(([engagement, muted, resolved]) => ({ engagement, muted, resolved }))
      : Promise.resolve({ engagement: {}, muted: new Set<string>(), resolved: null });

  // ── S1 retrieval (cache-first: hits return in <15 ms with zero reads).
  //    Lyric plans ALSO fire the LRCLIB fragment resolver in parallel —
  //    it does not depend on the pools (S1 fix; plan §4 exception note:
  //    the origin's JioSaavn probe is one serial hop AFTER LRCLIB,
  //    bounded inside L10's 1.8 s lyric budget).
  const originPromise =
    plan.kind === 'lyric_fragment'
      ? searchLyricByFragment(plan.normalized, opts.signal)
      : Promise.resolve(null);
  const retrieval = await retrieve(plan, { signal: opts.signal, limit: 30 });
  if (retrieval.cacheHit && !opts.signal?.aborted) {
    const tracks = retrieval.pools[0]?.tracks ?? [];
    return {
      tracks,
      degraded: false,
      latencyMs: Date.now() - t0,
      probes: [],
      topReason: tracks[0]?.reason,
      sigState: retrieval.sig?.sigState as SigState | undefined,
      partialArtists: retrieval.sig?.partialArtists,
      ...base,
    };
  }

  // ── S2 verify (sync stages) — plus the resolved origin's own catalog
  //    probe when LRCLIB identified the song (S1: the provider's own
  //    results for a fragment may be ALL covers; the origin injects the
  //    canonical recording into the candidate pool)
  const pools = [...retrieval.pools];
  const origin = plan.kind === 'lyric_fragment' ? await originPromise : null;
  if (origin && !opts.signal?.aborted) {
    try {
      const originTracks = await searchSaavn(
        `${origin.title} ${origin.artist.split(',')[0]?.trim()}`,
        15,
        opts.signal,
      );
      if (originTracks.length > 0) pools.push({ pool: 'origin', tracks: originTracks });
    } catch {
      /* origin resolve is opportunistic */
    }
  }
  const verified = verifySet(plan, pools);

  // learning results join HERE (post-retrieval, pre-rank) — probes never
  // waited on them; if learning is slower than the network it simply
  // doesn't influence this generation (next search gets it).
  const { engagement, muted, resolved } = await learningPromise;
  const affinity: Record<string, number> = {};
  if (deps?.artistAffinity) {
    for (const row of verified.rows) {
      for (const a of row.artistsFull ?? [row.artist]) {
        const key = a.toLowerCase();
        if (!(key in affinity)) {
          const v = deps.artistAffinity(key);
          if (v > 0) affinity[key] = v;
        }
      }
    }
  }

  // ── S3 rank (V1 lyric signals already on rows; V2 lands async)
  const earlyRanked = rankRows(plan, verified.rows, {
    engagement,
    artistAffinity: affinity,
    mutedArtists: muted,
  });

  // PROGRESSIVE PAINT (P0-2 fix): the ranked set paints the moment it is
  // ready; recovery/superset work continues below.
  if (opts.onEarly && earlyRanked.length > 0 && !opts.signal?.aborted) {
    opts.onEarly({
      tracks: toTrackList(earlyRanked),
      degraded: false,
      latencyMs: Date.now() - t0,
      probes: retrieval.probes,
      plan,
      corrected,
      correlationId: corrId,
    });
  }

  // ── SIG GATE (M3): a specific-intent query that produced no row
  //    matching BOTH axes must escalate, never paint artist-only junk
  //    as "Best match". Rung order: YouTube (full length) → iTunes
  //    (30 s preview) → variant spellings → album route. Bounded 3 s;
  //    after-paint (onEarly already fired the organic set).
  let ranked: RankedRow[] = earlyRanked;
  let sigState: SigState | undefined;
  let partialArtists: string[] | undefined;
  // P0-2 lock: the ladder's verified rows, kept so the paint contract can
  // re-inject them if clustering unions the rescued row away (an organic
  // same-title row with a playCount wins the cluster rep over a YT song
  // row that carries none).
  let rescueTracks: Track[] | null = null;
  const artistPlan = plan.kind === 'artist_title';
  if (artistPlan && !opts.signal?.aborted) {
    const unmet = sigUnmet(plan, earlyRanked);
    if (unmet) {
      const rescue = await runRescueLadder(plan, { signal: opts.signal });
      if (rescue.tracks.length > 0) {
        rescueTracks = rescue.tracks;
        const merged = verifySet(plan, [{ pool: 'rescue', tracks: rescue.tracks }, { pool: 'organic', tracks: toTrackList(earlyRanked) }]);
        ranked = rankRows(plan, merged.rows, { engagement, artistAffinity: affinity, mutedArtists: muted });
        sigState = 'rescued';
      } else {
        sigState = earlyRanked.some((r) => r.queryMatch >= 0.5) ? 'partial' : 'zero';
        if (sigState === 'partial') {
          const seen = new Set<string>();
          partialArtists = [];
          for (const r of earlyRanked.filter((x) => x.queryMatch >= 0.5)) {
            for (const a of r.artistsFull ?? [r.artist]) {
              const key = a.toLowerCase();
              if (!seen.has(key)) {
                seen.add(key);
                partialArtists.push(a);
              }
            }
          }
          partialArtists = partialArtists.slice(0, 8);
        }
      }
    } else {
      sigState = 'hit';
    }
  } else if (
    plan.kind === 'entity_title' &&
    earlyRanked.length > 0 &&
    !opts.signal?.aborted
  ) {
    // TITLE-ONLY AUTHORITY GAP ("tu chaiye" class): the query is just a
    // song title, JioSaavn answered with title-matching rows, but every
    // one of them is a deep-niche cover/remake — the canonical recording
    // the user means is missing from the catalog. Escalate once via the
    // rescue ladder; an authoritative row (≥ AUTHORITY_FLOOR plays/views)
    // paints on top as S-RESCUED. If the ladder finds nothing credible we
    // keep the organic list silently — title matches ARE honest answers
    // for a title query, so no false partial/zero is claimed.
    if (titleAuthorityMissing(earlyRanked)) {
      const rescue = await runRescueLadder(plan, { signal: opts.signal });
      if (rescue.tracks.length > 0) {
        rescueTracks = rescue.tracks;
        const merged = verifySet(plan, [{ pool: 'rescue', tracks: rescue.tracks }, { pool: 'organic', tracks: toTrackList(earlyRanked) }]);
        ranked = rankRows(plan, merged.rows, { engagement, artistAffinity: affinity, mutedArtists: muted });
        sigState = 'rescued';
      }
    } else {
      sigState = 'hit';
    }
  }

  // SIG paint contract: the rescued row IS the declared answer — it
  // paints at rank 1 with the "Best match" reason regardless of what the
  // organic covers scored (the +0.75 promotion narrows the gap; this
  // closes it deterministically for both the artist_title and
  // title-only paths).
  if (sigState === 'rescued') {
    let ri = ranked.findIndex((r) => r.rescued);
    if (ri === -1 && rescueTracks) {
      // P0-2: clustering dropped the rescued row (organic same-cluster rep
      // won). Title truth (contract #1) outranks dedupe: re-inject the
      // ladder's dual-verified rows at the top instead of fabricating a
      // 'rescued' state over organic covers.
      const ids = new Set(ranked.map((r) => r.id));
      const reinjected = rescueTracks
        .filter((t) => !ids.has(t.id))
        .map((t) => ({
          ...t,
          pool: 'rescue' as const,
          poolRank: 0,
          score: 10,
          artistMatch: 1,
          queryMatch: 1,
          reasonCode: 'MATCHES_SEARCH' as const,
        }));
      ranked = [...reinjected, ...ranked];
      ri = reinjected.length > 0 ? 0 : -1;
    }
    if (ri > 0) {
      const [hit] = ranked.splice(ri, 1);
      ranked = [{ ...hit, reasonCode: 'MATCHES_SEARCH' as const }, ...ranked];
    }
  }

  // fragment→track cache (§5.6 — lyric plans ONLY, P1-3 fix): inject the
  // remembered pick at rank 1 with its truthful reason. Never overrides
  // the disambiguation override: artist-mismatched memories are skipped.
  const remembered: Track | null = resolved;
  if (remembered && plan.kind === 'lyric_fragment') {
    const row = ranked.find((r) => r.id === remembered.id);
    const artistOk =
      plan.artistTokens.length === 0 ||
      (row?.artistMatch ?? 0) >= 1 ||
      ranked.length === 0;
    if (artistOk) {
      const idx = ranked.findIndex((r) => r.id === remembered.id);
      if (idx > 0) {
        const [hit] = ranked.splice(idx, 1);
        ranked = [
          { ...hit, poolRank: 0, score: hit.score + 1.5, reasonCode: 'YOUR_PAST_CLICK' },
          ...ranked,
        ];
      } else if (idx === -1 && ranked.length === 0) {
        ranked = [
          {
            ...remembered,
            poolRank: 0,
            pool: 'memory',
            score: 5,
            artistMatch: 0,
            queryMatch: 0,
            reasonCode: 'YOUR_PAST_CLICK' as const,
          },
        ];
      }
    }
  }

  // ORIGIN BOOST (S1): when LRCLIB identified the song the fragment
  // belongs to, its row(s) are lyric-MATCHED BY CONSTRUCTION — mark them
  // and float the best one to the top (truthful: we verified its lyrics
  // contain the typed fragment).
  if (origin && ranked.length > 0) {
    const oTitle = origin.title.toLowerCase().trim();
    const oArtistFirst = origin.artist.toLowerCase().split(',')[0]?.trim() ?? '';
    let boosted = false;
    ranked = ranked.map((r) => {
      const titleHit = r.title.toLowerCase().includes(oTitle) || oTitle.includes(r.title.toLowerCase().split(' (')[0] ?? '');
      const artistHit = r.artist.toLowerCase().includes(oArtistFirst);
      if (titleHit && artistHit && !boosted) {
        boosted = true;
        return { ...r, lyricMatch: true, matchedLine: origin.line, score: r.score + 2.5, reasonCode: 'LYRIC_MATCH' as const };
      }
      return r;
    });
    if (boosted) {
      ranked = [...ranked].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    }
  }

  let tracks = toTrackList(ranked);
  let relaxedFrom: string | undefined;
  let relaxedQuery: string | undefined;

  // HONEST ZERO (S6 fix + SIG M2.1): if the provider returned rows but NONE
  // actually match the query, treat as zero and fall into recovery — never
  // render unrelated rows as matches. SIG M2.1 tightens the old gate:
  // artistMatch ≥ 1 alone no longer passes (that loophole is exactly what
  // painted O'Meri Laila as "Best match" for "tu chaiye of atif aslam").
  const anyRelevant = ranked.some((r) => r.queryMatch >= 0.34);
  if (!anyRelevant && ranked.length > 0) {
    tracks = [];
  }

  // ── S4 recovery ladder (thin/zero only — ≤2 RUNGS, 1.5 s total budget;
  //    P1-6 fix: a deadline kills the climb even mid-rung)
  //    P0-1 lock: NEVER when the SIG rescue succeeded — the rescued row is
  //    the declared answer and relaxation would replace it with relaxed
  //    junk that doesn't contain it (fabricating sigState='rescued' over
  //    an unrelated list). Thin-after-rescue is the honest state.
  if (tracks.length < THIN_THRESHOLD && !opts.signal?.aborted && sigState !== 'rescued') {
    const deadline = Date.now() + 1500;
    let rungsUsed = 0;
    let rungPlan: SearchPlan = plan;
    for (const rung of RELAXATION_RUNGS) {
      if (tracks.length >= THIN_THRESHOLD || rungsUsed >= 2) break;
      if (Date.now() >= deadline) break;
      const next: SearchPlan | null = rung(rungPlan);
      if (!next || next.cacheKey === rungPlan.cacheKey) continue;
      rungPlan = next;
      rungsUsed += 1;
      try {
        const r2 = await retrieve(next, { signal: opts.signal, limit: 20 });
        if (opts.signal?.aborted) break;
        const v2 = verifySet(next, r2.pools);
        const rk2 = rankRows(next, v2.rows, { engagement, artistAffinity: affinity, mutedArtists: muted });
        if (rk2.length > tracks.length) {
          tracks = toTrackList(rk2);
          relaxedFrom = plan.raw.trim();
          relaxedQuery = next.normalized;
        }
      } catch {
        /* ladder rung failed — keep climbing */
      }
    }
  }

  const degraded = tracks.length > 0 && tracks.every((t) => t.source === 'itunes');
  // aborted generations never poison the 10-min cache (P1-7 fix)
  if (!opts.signal?.aborted) {
    rememberResults(plan, tracks, { sigState, partialArtists });
  }

  const result: SearchV2Result = {
    tracks,
    degraded,
    latencyMs: Date.now() - t0,
    relaxedFrom,
    relaxedQuery,
    probes: retrieval.probes,
    topReason: tracks[0]?.reason,
    sigState,
    partialArtists,
    ...base,
  };

  // ── S5 learn (void — NEVER on the critical path; P2 fix: no fake
  //    correlation kv write, no full-ledger "warm read")
  if (deps && !deps.disabled()) {
    void (async () => {
      try {
        persistLexicon(deps);
      } catch {
        /* learning is best-effort */
      }
    })();
  }

  return result;
}

// ── Legacy contract preserved (v1 aggregator) ──────────────────────────

function dedupeKey(t: Track): string {
  return `${t.title.toLowerCase().trim()}|${t.artist.toLowerCase().trim()}`;
}

export async function searchMusic(query: string): Promise<SearchResult> {
  const trimmed = query.trim();
  if (!trimmed) return { tracks: [], degraded: false };

  let saavn: Track[] = [];
  try {
    saavn = await searchSaavn(trimmed);
  } catch {
    saavn = [];
  }

  if (saavn.length >= 8) {
    return { tracks: saavn, degraded: false };
  }

  let itunes: Track[] = [];
  try {
    itunes = await searchItunes(trimmed);
  } catch {
    itunes = [];
  }

  const seen = new Set(saavn.map(dedupeKey));
  const merged = [...saavn];
  for (const t of itunes) {
    const key = dedupeKey(t);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(t);
    }
  }
  return { tracks: merged, degraded: saavn.length === 0 && itunes.length > 0 };
}

// re-export for the SearchScreen's lyric verification pass
export { verifyLyrics, snippetEcho, type Candidate };
