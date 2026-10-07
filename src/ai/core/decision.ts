/**
 * L4 — THE DECISION ENGINE (§8, "choose, explain, balance").
 *
 * The single authority that turns candidate pools into "the next tracks"
 * for every surface. Surfaces bring candidates + context; the engine:
 *
 *   1. hygiene-filters (dedup memory, mutes, recency, skip profiles)
 *   2. scores  Score = w₁·ProfileAffinity + w₂·SessionFit + w₃·DaypartFit
 *                + w₄·Freshness + w₅·SourceTrust + δ(explore)
 *   3. spends the exploration budget (ε-greedy with context — BaRT shape)
 *   4. attaches a truthful reason (closed code set, hard truth conditions)
 *   5. emits deterministically (seeded PRNG — same inputs, same order)
 *
 * Performance contract: pure in-memory, no awaits inside scoring; the
 * <150 ms p95 budget is enforced by tests/ai/perf.test.ts.
 */

import {
  ENERGY_TOLERANCE,
  EXPLORATION,
  HALF_LIFE,
  RETENTION,
  SCORE_WEIGHTS,
  SESSION,
  SIMILARITY,
} from './constants';
import type {
  Candidate,
  DecisionContext,
  ListenRecord,
  ReasonCode,
  ScoredPick,
  SessionState,
  TasteProfile,
} from './types';
import { clamp, hash32, seededRandom } from './time';
import { topArtists } from './profile';
import { NORMALIZATION } from './constants';
import { isArmVetoed, sampleBetaTheta, type Arm } from './bandit';

const DAY_MS = 86400_000;

export interface EngineDeps {
  profile: TasteProfile;
  session: SessionState;
  now: number;
  /** Phase 3 — the bandit's arm map (artist/track arms). Optional:
   *  absent (pre-hydration, tests) ⇒ every candidate scores as if the
   *  bandit did not exist. */
  banditArms?: ReadonlyMap<string, Arm>;
}

export interface DecideOptions {
  /** Surface-supplied hard blocks (already-served ids this queue, etc.). */
  excludeTrackIds?: Set<string>;
  /** Honest per-(surface→user) completion rates: surface → [completed, exposed]. */
  sourceTrust?: Record<string, { completed: number; exposed: number }>;
  /** trackId → last-served ts (7-day window) — feeds Freshness + BACK_FOR_MORE. */
  serveRecency?: Map<string, number>;
  /** Force exploration on/off (Discovery surface forces on). */
  forceExploration?: boolean;
}

export interface RankedCandidate extends Candidate {
  score: number;
  reasonCode: ReasonCode;
  explorationSlot: boolean;
  /** BAR 2.1 — hard-veto flag: the bandit says >75% reject rate with
   *  ≥3 net evidence. Excluded from every serving pool. */
  vetoed: boolean;
}

/** Normalized (0..1) artist affinity from the profile (sqrt-damped, §6.2). */
export function artistAffinity(profile: TasteProfile, artist: string, now: number): number {
  const key = artist.trim().toLowerCase();
  const entry = profile.artists[key];
  if (!entry) return 0;
  const halfLife = entry.source === 'heart' || entry.source === 'onboarding' ? HALF_LIFE.heart : HALF_LIFE.artist;
  const ageDays = (now - entry.lastEventTs) / DAY_MS;
  const decayed = entry.w * Math.pow(0.5, Math.max(0, ageDays) / halfLife);
  const boost = profile.corrections.boosts[key] ?? 1;
  return Math.sqrt(Math.max(0, decayed)) * boost;
}

export function decide(
  candidates: Candidate[],
  ctx: DecisionContext,
  deps: EngineDeps,
  opts: DecideOptions = {},
): RankedCandidate[] {
  const { profile, session, now, banditArms } = deps;
  const exclude = opts.excludeTrackIds ?? new Set<string>();
  const mutedArtists = new Set(profile.corrections.mutedArtists.map((a) => a.toLowerCase()));
  const mutedTracks = new Set(profile.corrections.mutedTracks);
  // Freshness contract (§8.7) is NOT optional: caller recency + the
  // session's own dedup memory both block re-serves inside the 7d window.
  const lastServed = new Map<string, number>(opts.serveRecency ?? []);
  for (const [id, ts] of session.dedupSet) {
    if (!lastServed.has(id)) lastServed.set(id, ts);
  }

  // ── Session-brain protocol state (the engine OBEYS the room §7.2) ───
  // Skip-storm: hard-exclude the storm artists and steer energy away for
  // the first 2 emitted slots (the emergency protocol).
  const recentWindow = session.window.slice(-SESSION.stormWindow);
  const stormRejects = recentWindow.filter((l) => l.grade === 'INSTANT_REJECT');
  const stormActive = stormRejects.length >= SESSION.stormThreshold;
  const stormArtists = new Set(stormActive ? stormRejects.map((l) => l.artist.toLowerCase()) : []);
  const stormEnergy = stormRejects.length
    ? stormRejects.reduce((s, l) => s + l.energy, 0) / stormRejects.length
    : 0.5;
  let stormSlotsLeft = stormActive ? 2 : 0; // first 2 emitted picks obey it

  // ── Hygiene pre-filter ─────────────────────────────────────────────────────────────────────────
  const pool = candidates.filter((c) => {
    if (exclude.has(c.trackId) || mutedTracks.has(c.trackId)) return false;
    if (mutedArtists.has(c.artist.trim().toLowerCase())) return false;
    if (stormArtists.has(c.artist.trim().toLowerCase())) return false;
    // Freshness contract (§8.7): nothing re-served within the 7-day window.
    const servedTs = lastServed.get(c.trackId);
    if (servedTs != null && servedTs > now - RETENTION.replayWindowDays * DAY_MS) return false;
    return true;
  });

// ── Score every candidate ─────────────────────────────────────────────
  const cellKey = `${ctx.block}|${ctx.dayKind}`;
  const cell = profile.daypart[cellKey];
  const sessionEnergy = sessionEnergyOf(session);
  const seeded = seededRandom(hash32(`${ctx.surface}:${ctx.seedTrackIds.join(',')}:${profile.builtAt}`));
  // Phase 3 — a SECOND deterministic stream for the bandit draws (never
  // shared with the exploration stream: one must not perturb the other).
  const banditRng = seededRandom(
    hash32(`${ctx.surface}:bandit:${ctx.seedTrackIds.join(',')}:${profile.builtAt}`),
  );

  // Phase 4 — the seed's DIRECTED out-edges ("what follows this"),
  // hoisted once: normalized flow bonus = edgeWeight / maxOutWeight.
  const flowSeed = profile.flowTracks[ctx.seedTrackIds[0]];
  let flowMax = 0;
  if (flowSeed) {
    for (const w of Object.values(flowSeed)) if (w > flowMax) flowMax = w;
  }

  const scored: RankedCandidate[] = pool.map((c) => {
    const profileAffinity = artistAffinity(profile, c.artist, now) +
      0.4 * genreAffinity(profile, c.genre, now);

    // SessionFit: quadratic penalty beyond tolerance (§8.3).
    const dEnergy = Math.abs(c.features.energy - sessionEnergy);
    const sessionFit = -(Math.max(0, dEnergy - ENERGY_TOLERANCE) ** 2) * 4;

    // DaypartFit: inside the block's observed band ±1σ.
    let daypartFit = 0;
    if (cell) {
      const eDelta = Math.abs(c.features.energy - cell.energyMean);
      daypartFit = eDelta <= cell.energyStd ? 0.6 : Math.max(-0.4, 0.6 - (eDelta - cell.energyStd) * 2);
      const cellArtistW = cell.artistWeights[c.artist.toLowerCase()] ?? 0;
      daypartFit += clamp(Math.sqrt(Math.max(0, cellArtistW)) * 0.3, 0, 0.5);
    }

    // Freshness: bonus for never-played; penalty for recently served.
    const served = lastServed.get(c.trackId);
    let freshness = 0.5;
    if (served == null) freshness = 1;
    else {
      const days = (now - served) / DAY_MS;
      freshness = clamp(1 - days / RETENTION.replayWindowDays, 0, 1) * 0.4;
    }

    // SourceTrust: per-surface historical completion (§8.3).
    const trustRec = opts.sourceTrust?.[ctx.surface] ?? { completed: 1, exposed: 2 };
    const sourceTrust = trustRec.exposed > 0 ? trustRec.completed / trustRec.exposed : 0.5;

    // Phase 4 — Markov flow bonus (what the user actually plays NEXT).
    const flowNorm = flowSeed && flowMax > 0 ? (flowSeed[c.trackId] ?? 0) / flowMax : 0;

    // Phase 3 — Thompson draw: artist arm first, track arm fallback.
    // No arm at all ⇒ the constant 0.5 — identical across unarmed
    // candidates, so ranking is byte-stable without bandit evidence.
    let theta = 0.5;
    const aArm = banditArms?.get(`a:${c.artist.trim().toLowerCase()}`);
    const tArm = banditArms?.get(`t:${c.trackId}`);
    if (aArm || tArm) theta = sampleBetaTheta(banditRng, aArm ?? tArm!);

    const base =
      SCORE_WEIGHTS.profileAffinity * clamp(profileAffinity, 0, 2.5) +
      SCORE_WEIGHTS.sessionFit * sessionFit +
      SCORE_WEIGHTS.daypartFit * daypartFit +
      SCORE_WEIGHTS.freshness * freshness +
      SCORE_WEIGHTS.sourceTrust * sourceTrust +
      SCORE_WEIGHTS.flowNext * flowNorm +
      SCORE_WEIGHTS.bandit * theta;

    return {
      ...c,
      score: base,
      reasonCode: 'FRESH_FIND', // provisional — exploration picks override
      explorationSlot: false,
      // BAR 2.1 — the hard-veto flag (excluded from every serving pool).
      vetoed: !!tArm && isArmVetoed(tArm),
    };
  });

  // Sort by score desc, deterministic tiebreak by trackId.
  scored.sort((a, b) => b.score - a.score || (a.trackId < b.trackId ? -1 : 1));

  // ── Exploration budget (§8.4): ε of slots take a calculated risk ──────
  const requested = Math.max(1, ctx.requested);
  // ε is clamped to the schedule's legal range — a stale profile can't
  // over-explore unchecked (cold-start ceiling 0.5, floor 0.10).
  const epsilon = clamp(
    opts.forceExploration ? Math.max(profile.exploration.epsilon, 0.35) : profile.exploration.epsilon,
    EXPLORATION.floorEpsilon,
    EXPLORATION.coldStartEpsilon,
  );
  const exploreSlots = Math.min(
    Math.floor(requested * epsilon),
    requested - 1 > 0 ? requested - 1 : 0,
  );

  const topLangs = topLanguages(profile, 3);
  const picks: RankedCandidate[] = [];
  const used = new Set<string>();

  // Serendipity ladder: adjacent-genre first; cross-language ≤1 in 5 explore slots.
  let crossLangUsed = 0;
  const maxCrossLang = Math.floor(exploreSlots / Math.round(1 / EXPLORATION.crossLanguageMax));

  // Exploration picks: from the mid-tier (rank ~40-70th percentile) —
  // genuinely novel but not random noise. Hard-vetoed tracks are NOT a
  // "calculated risk" — the bandit already knows them (BAR 2.1).
  const explorePool = scored.filter((c) => !stormArtists.has(c.artist.trim().toLowerCase()) && !c.vetoed);
  const exploreFrom = explorePool.slice(Math.floor(explorePool.length * 0.35), Math.floor(explorePool.length * 0.8));
  for (let i = 0; i < exploreSlots && exploreFrom.length; i++) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const pick = exploreFrom[Math.floor(seeded() * exploreFrom.length)];
      if (!pick || used.has(pick.trackId)) continue;
      const isCrossLang = !!pick.language && !!topLangs.length && !topLangs.includes(pick.language);
      if (isCrossLang && crossLangUsed >= maxCrossLang) continue;
      if (isCrossLang) crossLangUsed += 1;
      used.add(pick.trackId);
      pick.explorationSlot = true;
      // Honest even on explore slots: the truth condition must hold.
      pick.reasonCode = truthCondition(pick, deps, ctx, lastServed);
      picks.push(pick);
      break;
    }
  }

  // Exploitation picks fill the rest, same-artist cap (≤2 per 6-slot horizon).
  // BAR 2.1 — the HARD VETO: a track the bandit has learned to reject
  // (>75% reject rate, ≥3 net evidence) never enters the exploitation
  // pool — no flowBonus or profile affinity can push it through.
  const artistWindow: string[] = [];
  for (const c of scored) {
    if (picks.length >= requested) break;
    if (c.vetoed) continue;
    if (used.has(c.trackId)) continue;
    const recentCount = artistWindow.filter((a) => a === c.artist).length;
    if (recentCount >= SESSION.maxSameArtistPer6) continue;
    used.add(c.trackId);
    artistWindow.push(c.artist);
    if (artistWindow.length > 6) artistWindow.shift();
    c.reasonCode = truthCondition(c, deps, ctx, lastServed);
    picks.push(c);
  }

  // Interleave exploration picks evenly through the list (never a tail clump).
  const explorationQueue = picks.filter((p) => p.explorationSlot);
  const exploitation = picks.filter((p) => !p.explorationSlot);
  const every = Math.max(2, Math.floor(exploitation.length / Math.max(1, explorationQueue.length)));
  const interleaved: RankedCandidate[] = [];
  let eq = 0;
  exploitation.forEach((p, i) => {
    interleaved.push(p);
    if ((i + 1) % every === 0 && eq < explorationQueue.length) {
      interleaved.push(explorationQueue[eq++]!);
    }
  });
  while (eq < explorationQueue.length) interleaved.push(explorationQueue[eq++]!);

  // ── Same-artist cap over the FINAL order (≤2 per 6-slot, incl. explore) ──
  const finalPicks: RankedCandidate[] = [];
  for (const c of interleaved) {
    const last6Artists = finalPicks.slice(-6).map((p) => p.artist);
    const count = last6Artists.filter((a) => a === c.artist).length;
    if (count >= SESSION.maxSameArtistPer6) continue; // skip; backfill below
    finalPicks.push(c);
  }
  for (const c of interleaved) {
    if (finalPicks.length >= requested) break;
    if (finalPicks.includes(c)) continue;
    const last6 = finalPicks.slice(-6).map((p) => p.artist);
    if (last6.filter((a) => a === c.artist).length >= SESSION.maxSameArtistPer6) continue;
    finalPicks.push(c);
  }

  // ── Vibe governance over the final list (the authority is total §7.2) ──
  // FLOW/PEAK vibe-lock: consecutive energies within ±tolerance (5% slack);
  // WIND_DOWN: no upward jumps; storm slots steer away from the storm band.
  const governed: RankedCandidate[] = [];
  for (const c of finalPicks) {
    if (stormSlotsLeft > 0) {
      const away =
        stormEnergy >= 0.6 ? c.features.energy < stormEnergy - 0.1 : c.features.energy > stormEnergy + 0.1;
      const better = finalPicks.some(
        (o) =>
          o !== c &&
          !governed.includes(o) &&
          (stormEnergy >= 0.6 ? o.features.energy < stormEnergy - 0.1 : o.features.energy > stormEnergy + 0.1),
      );
      if (!away && better) continue; // defer to a better-steering pick
      stormSlotsLeft -= 1;
      governed.push(c);
      continue;
    }
    if (governed.length > 0) {
      const prev = governed[governed.length - 1]!;
      if (session.vibe === 'FLOW' || session.vibe === 'PEAK') {
        if (Math.abs(c.features.energy - prev.features.energy) > ENERGY_TOLERANCE + 0.05) continue;
      }
      if (session.vibe === 'WIND_DOWN') {
        if (c.features.energy > prev.features.energy + ENERGY_TOLERANCE) continue;
      }
    }
    governed.push(c);
  }
  // Backfill when governance over-prunes — same-artist cap still applies.
  for (const c of finalPicks) {
    if (governed.length >= requested) break;
    if (governed.includes(c)) continue;
    const last6 = governed.slice(-6).map((p) => p.artist);
    if (last6.filter((a) => a === c.artist).length >= SESSION.maxSameArtistPer6) continue;
    governed.push(c);
  }
  return governed.slice(0, requested);
}

// ── Truthful explanations (§8.5) ───────────────────────────────────────

/**
 * Pick the reason code whose truth condition actually holds — in priority
 * order. Every emitted rec must pass its truth condition (unit-tested over
 * the full code table). Banned forever: any social-proof phrasing.
 */
export function truthCondition(
  c: Candidate,
  deps: EngineDeps,
  ctx: DecisionContext,
  lastServed: Map<string, number>,
): ReasonCode {
  const { profile, now } = deps;
  const artistKey = c.artist.trim().toLowerCase();

  // FLOW_NEXT (Phase 4): a DIRECTED transition from the seed whose weight
  // sits ABOVE THE MEDIAN of the seed's out-edges (mirrors the NEIGHBOR
  // discipline — no hard-coded floor can let a weak edge claim flow).
  const flowEdges = profile.flowTracks[ctx.seedTrackIds[0]];
  if (flowEdges) {
    const w = flowEdges[c.trackId] ?? 0;
    if (w > 0) {
      const weights = Object.values(flowEdges).sort((a, b) => a - b);
      const median = weights.length ? weights[Math.floor(weights.length / 2)] : 0;
      if (w > median) return 'FLOW_NEXT';
    }
  }

  // NEIGHBOR: co-play edge ABOVE THE MEDIAN of the seed's edges exists
  // (§8.5: "weight above median" — a hard-coded floor would let weak
  // edges claim kinship).
  const neighbors = profile.coplayTracks[ctx.seedTrackIds[0]];
  if (neighbors) {
    const edge = neighbors[c.trackId] ?? 0;
    const weights = Object.values(neighbors).sort((a, b) => a - b);
    const median = weights.length ? weights[Math.floor(weights.length / 2)] : 0;
    if (edge > median && edge > 0) return 'NEIGHBOR';
  }

  // BECAUSE_HEARTED: a hearted track by the same artist exists.
  const artistEntry = profile.artists[artistKey];
  if (artistEntry?.source === 'heart' && artistEntry.evidenceCount >= 1) return 'BECAUSE_HEARTED';

  // BACK_FOR_MORE: replayed last week (7–14d ago — the 7d window is a
  // hard block above, so this fires exactly for "last week's" replays).
  const served = lastServed.get(c.trackId);
  if (served != null) {
    const age = now - served;
    if (age >= 7 * DAY_MS && age <= 14 * DAY_MS) return 'BACK_FOR_MORE';
  }

  // BECAUSE_PLAYED: artist affinity in the top-10 AND ≥3 evidence events
  // ("you play X a lot" must mean a lot, §8.5 truth condition).
  const entry = profile.artists[artistKey];
  if (entry && entry.evidenceCount >= NORMALIZATION.minEvidenceForExplain) {
    const top10 = topArtists(profile, now, NORMALIZATION.topArtistRead).map((a) => a.artist);
    if (top10.includes(artistKey)) return 'BECAUSE_PLAYED';
  }

  // SOUND_ALIKE (Phase 6): only the similarity pass sets sharedTagDims,
  // and it enforces ≥2 dims at rank time — this case re-verifies it, so
  // the closed-set contract holds for any future caller too.
  if ((c.sharedTagDims ?? 0) >= SIMILARITY.minSharedTags) return 'SOUND_ALIKE';

  // FITS_BLOCK: current daypart cell matches the track's energy.
  const cell = profile.daypart[`${ctx.block}|${ctx.dayKind}`];
  if (cell && Math.abs(c.features.energy - cell.energyMean) <= Math.max(0.15, cell.energyStd)) {
    return 'FITS_BLOCK';
  }

  // SESSION_CONTINUITY: energy delta ≤0.2 from the current session energy.
  const dE = Math.abs(c.features.energy - sessionEnergyOf(deps.session));
  if (dE <= ENERGY_TOLERANCE) return 'SESSION_CONTINUITY';

  return 'FRESH_FIND';
}

/** Human line for a reason code — the trust layer's voice (§15). */
export function reasonLine(code: ReasonCode, detail?: string): string {
  switch (code) {
    case 'BECAUSE_PLAYED': return `Because you play ${detail ?? 'this artist'} a lot`;
    case 'BECAUSE_HEARTED': return `You loved ${detail ?? "this artist's"} songs`;
    case 'NEIGHBOR': return `You keep playing this next to ${detail ?? 'similar songs'}`;
    case 'FLOW_NEXT': return 'Keeps your flow going';
    case 'SOUND_ALIKE': return `Sounds like ${detail ?? 'what you picked'}`;
    case 'FITS_BLOCK': return `Fits your ${detail ?? 'right-now'} sound`;
    case 'SESSION_CONTINUITY': return "Keeps tonight's mood going";
    case 'FRESH_FIND': return 'A fresh find — see if it sticks';
    case 'BACK_FOR_MORE': return 'You replayed this last week';
    default: return 'A fresh find';
  }
}

// ── helpers ─────────────────────────────────────────────────────────────

function genreAffinity(profile: TasteProfile, genre: string | undefined, now: number): number {
  if (!genre) return 0;
  const entry = profile.genres[genre.toLowerCase()];
  if (!entry) return 0;
  const ageDays = (now - entry.lastEventTs) / DAY_MS;
  return entry.w * Math.pow(0.5, Math.max(0, ageDays) / HALF_LIFE.genre);
}

function topLanguages(profile: TasteProfile, n: number): string[] {
  return Object.entries(profile.languages)
    .sort((a, b) => b[1].w - a[1].w)
    .slice(0, n)
    .map(([lang]) => lang);
}

export function sessionEnergyOf(session: SessionState): number {
  const t = session.energyTrajectory;
  if (!t.length) return 0.5;
  const n = t.length;
  const third = Math.max(1, Math.floor(n / 3));
  const recent = t.slice(-third);
  const mid = t.slice(-2 * third, -third);
  const old = t.slice(0, -2 * third);
  const wSum = recent.length * 3 + mid.length * 2 + old.length * 1 || 1;
  return (recent.reduce((a, b) => a + b, 0) * 3 + mid.reduce((a, b) => a + b, 0) * 2 + old.reduce((a, b) => a + b, 0)) / wSum;
}

/** Serve-recency map builder surfaces use (recent listens + explicit serves). */
export function buildServeRecency(listens: ListenRecord[], days = RETENTION.replayWindowDays): Map<string, number> {
  const cutoff = (listens.length ? listens[listens.length - 1].startedTs : Date.now()) - days * DAY_MS;
  const m = new Map<string, number>();
  for (const l of listens) {
    if (l.startedTs < cutoff) continue;
    const cur = m.get(l.trackId);
    if (cur == null || l.startedTs > cur) m.set(l.trackId, l.startedTs);
  }
  return m;
}

/** ε for the CURRENT session (cold-start aware, §8.4 schedule). */
export function currentEpsilon(profile: TasteProfile, sessionIndex: number): number {
  if (sessionIndex <= 5) return EXPLORATION.coldStartEpsilon;
  return Math.max(EXPLORATION.floorEpsilon, profile.exploration.epsilon);
}

/** Convert ScoredPick list to plain rows for surfaces. */
export function toPicks(ranked: RankedCandidate[]): ScoredPick[] {
  return ranked.map((r) => ({
    trackId: r.trackId,
    artist: r.artist,
    score: Math.round(r.score * 1000) / 1000,
    reasonCode: r.reasonCode,
    explorationSlot: r.explorationSlot,
  }));
}
