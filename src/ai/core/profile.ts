/**
 * L2 — THE TASTE PROFILE (§6, "the brain's memory").
 *
 * A single living object answering "who is this listener?" at any moment.
 * Built from the ledger's graded listens + discrete events:
 *
 *   • affinity maps (artist/genre/language/era) with per-tier half-lives
 *   • the daypart matrix — 5 blocks × 2 day-kinds, each cell holding its
 *     own artist weights + energy/valence moments
 *   • proxy preference stats (energy/valence mean±std, tempo distribution)
 *   • per-track skip profiles (10-bucket histograms)
 *   • co-play graphs (track + artist level, decayed + popularity-damped)
 *   • taste clusters (artist label-propagation + mood k-means)
 *   • exploration state + explicit corrections (boost/mute/not-for-me)
 *
 * Pure function: buildProfile(listens, events, sessions, opts) → profile.
 * Same inputs → same profile (replay-testable, §11.1).
 */

import {
  BLAME_SPLIT,
  BOUNDARY_CALIBRATION_MIN,
  CAPTURED_GENRE_WEIGHT,
  EXPLORATION,
  FLOW,
  GRADE_WEIGHTS,
  HALF_LIFE,
  ONBOARDING,
  RETENTION,
  SESSION,
  SKIP_THRESHOLDS,
} from './constants';
import { ARTIST_PRIORS, GENRE_PRIORS } from './priors';
import { blockOf, clamp, dayKindOf, eraOf } from './time';
import type {
  ArtistCluster,
  LedgerEvent,
  ListenRecord,
  MoodCell,
  SessionRecord,
  TasteProfile,
} from './types';

const DAY_MS = 86400_000;

export interface BuildOptions {
  now: number;
  /** Onboarding Pick-5 seeds (artist names), weight 3.0 each (§6.7). */
  onboardingSeeds?: string[];
  /** Onboarding genre picks — softer affinity hints (§6.7). */
  onboardingGenres?: string[];
  /** When the seeds were first picked (decay anchor). */
  onboardingSeedTs?: number;
  /** Carried-over explicit corrections (boost/mute/wrong). */
  corrections?: TasteProfile['corrections'];
  /** First-ever-build flag (cold start defaults). */
  isColdStart?: boolean;
}

export function emptyProfile(now: number): TasteProfile {
  return {
    builtAt: now,
    sessionCount: 0,
    artists: {},
    genres: {},
    languages: {},
    eras: {},
    proxy: {
      energyPref: { mean: 0.5, std: 0.2 },
      valencePref: { mean: 0.5, std: 0.2 },
      tempoDist: { slow: 0.34, mid: 0.33, fast: 0.33 },
    },
    daypart: {},
    activities: {},
    skipProfiles: {},
    coplayTracks: {},
    coplayArtists: {},
    flowTracks: {},
    clusters: { artistClusters: [], moodCells: [] },
    exploration: {
      epsilon: EXPLORATION.coldStartEpsilon,
      noveltyServed: 0,
      noveltyConverted: 0,
      lastScheduleTs: now,
      crossLanguageStreak: 0,
    },
    corrections: { mutedArtists: [], mutedTracks: [], boosts: {}, wrongLabels: [] },
    boundaries: { weekday: {}, weekend: {} },
  };
}

/** w ← w · 0.5^(ageDays / halfLife) — stated once, used everywhere (§6.2). */
export function decay(w: number, ageDays: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return w;
  return w * Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays);
}

function bump(map: Record<string, { w: number; lastEventTs: number; evidenceCount: number; source: 'organic' | 'heart' | 'onboarding' | 'correction' }>, key: string, w: number, ts: number, source: 'organic' | 'heart' | 'onboarding' | 'correction' = 'organic') {
  if (!key) return;
  const cur = map[key];
  if (cur) {
    cur.w += w;
    cur.lastEventTs = Math.max(cur.lastEventTs, ts);
    cur.evidenceCount += 1;
    if (source === 'heart' || source === 'onboarding') cur.source = source;
  } else {
    map[key] = { w, lastEventTs: ts, evidenceCount: 1, source };
  }
}

/** Grade → signed evidence for this listen (REPLAY carries the bonus). */
function gradeWeight(grade: ListenRecord['grade']): number {
  switch (grade) {
    case 'REPLAY': return GRADE_WEIGHTS.COMPLETED + GRADE_WEIGHTS.REPLAY_BONUS;
    case 'HEART': return GRADE_WEIGHTS.HEART;
    case 'HEART_CONTRADICT': return GRADE_WEIGHTS.HEART_CONTRADICT;
    case 'DOWNLOAD': return GRADE_WEIGHTS.DOWNLOAD;
    case 'NOT_FOR_ME': return GRADE_WEIGHTS.NOT_FOR_ME_TRACK;
    case 'INSTANT_REJECT': return GRADE_WEIGHTS.INSTANT_REJECT;
    case 'EARLY_SKIP': return GRADE_WEIGHTS.EARLY_SKIP;
    case 'MID_SKIP': return GRADE_WEIGHTS.MID_SKIP;
    case 'LATE_SKIP': return GRADE_WEIGHTS.LATE_SKIP;
    case 'COMPLETED': return GRADE_WEIGHTS.COMPLETED;
    default: return 0;
  }
}

function blameKey(grade: ListenRecord['grade']): (typeof BLAME_SPLIT)[keyof typeof BLAME_SPLIT] | null {
  switch (grade) {
    case 'INSTANT_REJECT': return BLAME_SPLIT.INSTANT_REJECT;
    case 'EARLY_SKIP': return BLAME_SPLIT.EARLY_SKIP;
    case 'MID_SKIP': return BLAME_SPLIT.MID_SKIP;
    case 'LATE_SKIP': return BLAME_SPLIT.LATE_SKIP;
    case 'COMPLETED':
    case 'REPLAY': return BLAME_SPLIT.COMPLETED;
    default: return null; // HEART/DOWNLOAD/NOT_FOR_ME handled as discrete signals
  }
}

export function normalizeArtist(artist: string | undefined): string {
  return (artist ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Language from a listen's language field or title script heuristic. */
function languageOf(l: ListenRecord): string {
  if (l.language) return l.language.toLowerCase();
  return 'unknown';
}

/**
 * Full profile build. O(n) over listens + O(edges) for the co-play graph —
 * the perf budget test asserts a 90-day ~20k-event rebuild stays < 3 s.
 */
export function buildProfile(
  listens: ListenRecord[],
  events: LedgerEvent[],
  sessions: SessionRecord[],
  opts: BuildOptions,
): TasteProfile {
  const { now } = opts;
  const p = emptyProfile(now);
  p.sessionCount = sessions.length;
  p.corrections = opts.corrections ?? p.corrections;

  // Onboarding seeds (§6.7): weight 3.0, heart-tier decay. The seed keeps
  // its FIRST-seen timestamp so the 180d half-life actually erodes it
  // (re-seeding at `now` on every rebuild made seeds immortal).
  const seedTs = opts.onboardingSeedTs ?? now;
  for (const artist of opts.onboardingSeeds ?? []) {
    const key = normalizeArtist(artist);
    if (key) bump(p.artists, key, ONBOARDING.seedWeight, seedTs, 'onboarding');
  }
  for (const genre of opts.onboardingGenres ?? []) {
    const key = normalizeArtist(genre);
    if (key) bump(p.genres, key, ONBOARDING.genreSeedWeight, seedTs, 'onboarding');
  }

  // Heart / download / not-for-me discrete events.
  const heartTracks = new Set<string>();
  const heartedArtistsByTrack = new Map<string, string>();
  const instantRejectCount = new Map<string, number>();
  for (const l of listens) {
    if (l.grade === 'INSTANT_REJECT') {
      instantRejectCount.set(l.trackId, (instantRejectCount.get(l.trackId) ?? 0) + 1);
    }
  }
  for (const e of events) {
    const artist = normalizeArtist(e.payload?.artist as string | undefined);
    if (e.type === 'TRACK_LIKE') {
      heartTracks.add(e.trackId ?? '');
      if (e.trackId) heartedArtistsByTrack.set(e.trackId, artist);
      if (artist) bump(p.artists, artist, GRADE_WEIGHTS.HEART, e.ts, 'heart');
    } else if (e.type === 'TRACK_DOWNLOAD' && e.trackId) {
      if (artist) bump(p.artists, artist, GRADE_WEIGHTS.DOWNLOAD, e.ts, 'heart');
    } else if (e.type === 'NOT_FOR_ME' && e.trackId) {
      // Track-level −4.0; artist −1.0 (only explicit signal that blocks).
      if (artist) bump(p.artists, artist, GRADE_WEIGHTS.NOT_FOR_ME_ARTIST, e.ts, 'correction');
      if (!p.corrections.mutedTracks.includes(e.trackId)) p.corrections.mutedTracks.push(e.trackId);
    }
  }

  // HEART_CONTRADICT: hearted track later instant-skipped ×2 → heart weight
  // for that artist's heart evidence collapses (§5.2). Implemented as a
  // compensating negative bump so the ledger stays the single truth.
  for (const [trackId, count] of instantRejectCount) {
    if (count >= SKIP_THRESHOLDS.heartContradictInstantSkips && heartTracks.has(trackId)) {
      const artist = heartedArtistsByTrack.get(trackId);
      if (artist) bump(p.artists, artist, GRADE_WEIGHTS.HEART_CONTRADICT - GRADE_WEIGHTS.HEART, now);
    }
  }

  // ── Pass 1: graded listens → affinities, daypart cells, proxy stats ───
  const blockCells = new Map<string, {
    artists: Record<string, number>;
    genres: Record<string, number>;
    energies: number[];
    valences: number[];
    sessions: Set<string>;
  }>();
  const proxyEnergies: number[] = [];
  const proxyValences: number[] = [];
  const tempoCount = { slow: 0, mid: 0, fast: 0 };
  const playsByTrack = new Map<string, number>();
  const playsByArtist = new Map<string, number>();

  for (const l of listens) {
    const artistKey = normalizeArtist(l.artist);
    if (!artistKey) continue;
    const w = gradeWeight(l.grade);
    const split = blameKey(l.grade);
    playsByTrack.set(l.trackId, (playsByTrack.get(l.trackId) ?? 0) + 1);
    playsByArtist.set(artistKey, (playsByArtist.get(artistKey) ?? 0) + 1);

    if (split) {
      bump(p.artists, artistKey, w * split.artist, l.startedTs);
      // Track-level evidence lives in skipProfiles + a track affinity we
      // don't keep separately (tracks are too sparse) — mood/genre get theirs.
      const moodW = w * (split as { mood?: number }).mood! * 0.5;
      if (moodW !== 0) {
        if (l.energy >= 0.65) bump(p.genres, '__high_energy', moodW, l.startedTs);
        else if (l.energy <= 0.35) bump(p.genres, '__low_energy', moodW, l.startedTs);
        if (l.valence >= 0.65) bump(p.genres, '__positive', moodW * 0.6, l.startedTs);
        else if (l.valence <= 0.35) bump(p.genres, '__melancholy', moodW * 0.6, l.startedTs);
      }
      if (l.genre) {
        bump(p.genres, l.genre.toLowerCase(), w * 0.3, l.startedTs);
        // Phase 1 — captured (free) genre evidence: a provider genre the
        // listener never typed feeds affinity at half an onboarding pick.
        // Positive grades only — a skipped song is not genre evidence.
        // No genre on the row ⇒ zero change (locked by replay test).
        if (w > 0) bump(p.genres, l.genre.toLowerCase(), CAPTURED_GENRE_WEIGHT, l.startedTs);
      }
      // Session-account evidence: session fit handled by Session Brain,
      // but the daypart cell absorbs "this block worked" weight.
    }

    const lang = languageOf(l);
    if (lang !== 'unknown') bump(p.languages, lang, w * 0.4 + 0.2, l.startedTs);
    bump(p.eras, eraOf(l.year), w * 0.3, l.startedTs);

    // Daypart cell (session's block decides — the room, not the clock).
    const cellKey = `${blockOf(l.startedTs)}|${dayKindOf(l.startedTs)}`;
    let cell = blockCells.get(cellKey);
    if (!cell) {
      cell = { artists: {}, genres: {}, energies: [], valences: [], sessions: new Set() };
      blockCells.set(cellKey, cell);
    }
    cell.sessions.add(l.sessionId);
    if (w > 0) {
      const ageDays = (now - l.startedTs) / DAY_MS;
      const wDecayed = decay(w, ageDays, HALF_LIFE.daypartCell);
      cell.artists[artistKey] = (cell.artists[artistKey] ?? 0) + wDecayed;
      if (l.genre) cell.genres[l.genre.toLowerCase()] = (cell.genres[l.genre.toLowerCase()] ?? 0) + wDecayed;
      cell.energies.push(l.energy);
      cell.valences.push(l.valence);
    }

    // Proxy preference stats from positive listens only.
    if (w > 0.5) {
      proxyEnergies.push(l.energy);
      proxyValences.push(l.valence);
      const t = l.energy < 0.35 ? 'slow' : l.energy < 0.65 ? 'mid' : 'fast';
      tempoCount[t] += 1;
    }

    // Per-track skip profile histogram (§5.2).
    const sp = p.skipProfiles[l.trackId] ?? { buckets: new Array(10).fill(0), listens: 0 };
    const bucket = (l.skipBucket ?? Math.max(1, Math.ceil(l.completionRatio * 10))) - 1;
    sp.buckets[Math.min(9, Math.max(0, bucket))] += 1;
    sp.listens += 1;
    p.skipProfiles[l.trackId] = sp;
  }

  // ── Pass 2: co-play adjacency (§7.3) — consecutive listens in a session ──
  const trackEdgeW = new Map<string, number>(); // "a|b" (a<b) → weight
  // Phase 4 — DIRECTED flow memory: "a>b" (a→b, order matters) → weight.
  const flowEdgeW = new Map<string, number>();
  // edgeKey → daypart cell → observation count (the second-order bonus).
  const flowCells = new Map<string, Map<string, number>>();
  const artistAdj = new Map<string, Record<string, number>>();
  const bySession = new Map<string, ListenRecord[]>();
  for (const l of listens) {
    const arr = bySession.get(l.sessionId);
    if (arr) arr.push(l);
    else bySession.set(l.sessionId, [l]);
  }
  for (const [, arr] of bySession) {
    arr.sort((a, b) => a.startedTs - b.startedTs);
    for (let i = 1; i < arr.length; i++) {
      const a = arr[i - 1];
      const b = arr[i];
      const ageDays = (now - b.startedTs) / DAY_MS;
      const wDecayed = decay(1, ageDays, HALF_LIFE.coplayEdge);
      if (wDecayed < 0.02) continue;
      // Track edge (undirected key), popularity-damped.
      const key = a.trackId < b.trackId ? `${a.trackId}|${b.trackId}` : `${b.trackId}|${a.trackId}`;
      const damp = 1 + Math.log2((playsByTrack.get(a.trackId) ?? 1) + (playsByTrack.get(b.trackId) ?? 1));
      trackEdgeW.set(key, (trackEdgeW.get(key) ?? 0) + wDecayed / damp);
      // Phase 4 — the DIRECTED transition (A→B ≠ B→A): the same evidence,
      // kept in playback order, same half-life + damping. Self-transitions
      // (replay of the same track) carry no flow information.
      if (a.trackId !== b.trackId) {
        const dirKey = `${a.trackId}>${b.trackId}`;
        flowEdgeW.set(dirKey, (flowEdgeW.get(dirKey) ?? 0) + wDecayed / damp);
        const cellKey2 = `${blockOf(b.startedTs)}|${dayKindOf(b.startedTs)}`;
        let cells = flowCells.get(dirKey);
        if (!cells) {
          cells = new Map();
          flowCells.set(dirKey, cells);
        }
        cells.set(cellKey2, (cells.get(cellKey2) ?? 0) + 1);
      }
      // Artist edge (both directions).
      const aKey = normalizeArtist(a.artist);
      const bKey = normalizeArtist(b.artist);
      if (aKey && bKey && aKey !== bKey) {
        const dampA = 1 + Math.log2((playsByArtist.get(aKey) ?? 1) + (playsByArtist.get(bKey) ?? 1));
        addEdge(artistAdj, aKey, bKey, wDecayed / dampA);
        addEdge(artistAdj, bKey, aKey, wDecayed / dampA);
      }
    }
  }

  // Re-key co-play edges into per-track adjacency (bounded to top-5000 edges).
  const trackAdj = new Map<string, Record<string, number>>();
  const flatTrackEdges: Array<{ a: string; b: string; w: number }> = [...trackEdgeW.entries()].map(([key, w]) => {
    const [a, b] = key.split('|');
    return { a, b, w };
  });
  flatTrackEdges.sort((x, y) => y.w - x.w);
  for (const e of flatTrackEdges.slice(0, 5000)) {
    addEdge(trackAdj, e.a, e.b, e.w);
    addEdge(trackAdj, e.b, e.a, e.w);
  }

  p.coplayTracks = Object.fromEntries(trackAdj);
  // Artist graph bounded to its top-2000 nodes (Appendix B contract).
  const artistEntries = [...artistAdj.entries()].slice(0, 2000);
  p.coplayArtists = Object.fromEntries(artistEntries);

  // ── Phase 4 — prune the directed flow graph (potato rule ⑧) ──────────
  // Floor-prune → global cap → per-node top-K, in that order, then the
  // daypart second-order bonus bakes into the surviving weights.
  const flatFlow: Array<{ from: string; to: string; w: number; key: string }> = [...flowEdgeW.entries()]
    .map(([key, w]) => {
      const gt = key.indexOf('>');
      return { from: key.slice(0, gt), to: key.slice(gt + 1), w, key };
    })
    .filter((e) => e.from && e.to && e.w >= FLOW.edgeWeightFloor)
    .sort((x, y) => y.w - x.w || (x.key < y.key ? -1 : 1))
    .slice(0, FLOW.globalEdgeCap);
  const flowAdj = new Map<string, Record<string, number>>();
  const perNodeOut = new Map<string, number>();
  for (const e of flatFlow) {
    if ((perNodeOut.get(e.from) ?? 0) >= FLOW.outEdgeCap) continue;
    let w = e.w;
    const cells = flowCells.get(e.key);
    if (cells) {
      for (const count of cells.values()) {
        if (count >= FLOW.daypartBonusMinCount) {
          w *= FLOW.daypartBonusMultiplier;
          break;
        }
      }
    }
    addEdge(flowAdj, e.from, e.to, w);
    perNodeOut.set(e.from, (perNodeOut.get(e.from) ?? 0) + 1);
  }
  p.flowTracks = Object.fromEntries(flowAdj);

  // ── Daypart matrix cells ───────────────────────────────────────────────
  // Cell weights decay with the 30d half-life: a 120-day-old habit must
  // NOT crush yesterday's habit (critic-verified no-op before).
  for (const [key, cell] of blockCells) {
    const decayedArtists: Record<string, number> = {};
    for (const [artist, w] of Object.entries(cell.artists)) {
      decayedArtists[artist] = w;
    }
    const eMean = mean(cell.energies) ?? 0.5;
    const vMean = mean(cell.valences) ?? 0.5;
    p.daypart[key] = {
      artistWeights: decayedArtists,
      genreWeights: cell.genres,
      energyMean: eMean,
      energyStd: std(cell.energies, eMean) ?? 0.2,
      valenceMean: vMean,
      valenceStd: std(cell.valences, vMean) ?? 0.2,
      sessionCount: cell.sessions.size,
    };
  }

  // ── Proxy preference moments ───────────────────────────────────────────
  if (proxyEnergies.length) {
    const em = mean(proxyEnergies)!;
    const vm = mean(proxyValences)!;
    p.proxy = {
      energyPref: { mean: em, std: std(proxyEnergies, em) ?? 0.2 },
      valencePref: { mean: vm, std: std(proxyValences, vm) ?? 0.2 },
      tempoDist: normTempo(tempoCount),
    };
  }

  // ── Clusters (§6.5) ────────────────────────────────────────────────────
  p.clusters.artistClusters = labelPropagation(artistAdj, playsByArtist);
  p.clusters.moodCells = moodKMeans(listens);

  // ── Exploration schedule (§8.4) ────────────────────────────────────────
  const exposures = events.filter((e) => e.type === 'REC_EXPOSURE');
  const freshExposed = exposures.filter((e) => e.payload?.exploration === true);
  let converted = 0;
  const exposedIds = new Set(freshExposed.map((e) => e.trackId ?? ''));
  for (const l of listens) {
    if (l.explorationSlot && (l.grade === 'COMPLETED' || l.grade === 'REPLAY' || l.grade === 'LATE_SKIP')) {
      if (exposedIds.has(l.trackId)) converted += 1;
    }
  }
  const mature = sessions.length >= ONBOARDING.firstSessionsExplore;
  let eps: number = mature ? EXPLORATION.matureEpsilon : EXPLORATION.coldStartEpsilon;
  // Novelty accounting: under-converting exploration auto-drops ε weekly.
  if (freshExposed.length >= 20) {
    const weeks = Math.max(1, Math.round((now - (sessions[0]?.startTs ?? now)) / (7 * DAY_MS)));
    const rate = converted / freshExposed.length;
    if (rate < EXPLORATION.conversionTarget) {
      eps = Math.max(EXPLORATION.floorEpsilon, EXPLORATION.matureEpsilon - EXPLORATION.autoDropPerWeek * weeks);
    }
  }
  p.exploration = {
    epsilon: eps,
    noveltyServed: freshExposed.length,
    noveltyConverted: converted,
    lastScheduleTs: now,
    crossLanguageStreak: 0,
  };

  // ── Boundary calibration (§6.3, after day 14) ──────────────────────────
  const firstTs = listens.length ? listens[0].startedTs : now;
  if ((now - firstTs) / DAY_MS >= BOUNDARY_CALIBRATION_MIN && listens.length >= 60) {
    p.boundaries = calibrateBoundaries(listens);
  }

  return p;
}

// ── helpers ─────────────────────────────────────────────────────────────

function addEdge(adj: Map<string, Record<string, number>>, from: string, to: string, w: number) {
  const cur = adj.get(from) ?? {};
  cur[to] = (cur[to] ?? 0) + w;
  adj.set(from, cur);
}

function mean(xs: number[]): number | null {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function std(xs: number[], mu: number): number | null {
  if (xs.length < 2) return null;
  const v = xs.reduce((s, x) => s + (x - mu) * (x - mu), 0) / xs.length;
  return Math.sqrt(v);
}

function normTempo(c: { slow: number; mid: number; fast: number }) {
  const total = c.slow + c.mid + c.fast || 1;
  return { slow: c.slow / total, mid: c.mid / total, fast: c.fast / total };
}

/**
 * Artist clusters via label propagation (3 iterations, no tree library —
 * §6.5). Deterministic: iteration order is insertion order.
 */
export function labelPropagation(
  adj: Map<string, Record<string, number>>,
  playsByArtist: Map<string, number>,
): ArtistCluster[] {
  const nodes = [...adj.keys()];
  if (nodes.length < 3) return [];
  const labels = new Map<string, string>();
  nodes.forEach((n) => labels.set(n, n));

  for (let iter = 0; iter < 3; iter++) {
    for (const n of nodes) {
      const edges = adj.get(n) ?? {};
      const votes = new Map<string, number>();
      for (const [other, w] of Object.entries(edges)) {
        const lbl = labels.get(other) ?? other;
        votes.set(lbl, (votes.get(lbl) ?? 0) + w);
      }
      if (votes.size) {
        // Tie-break by total play weight → stable clusters.
        let best: string | null = null;
        let bestW = -1;
        for (const [lbl, w] of votes) {
          if (w > bestW || (w === bestW && (playsByArtist.get(lbl) ?? 0) > (playsByArtist.get(best ?? '') ?? 0))) {
            best = lbl;
            bestW = w;
          }
        }
        if (best) labels.set(n, best);
      }
    }
  }

  const groups = new Map<string, string[]>();
  for (const n of nodes) {
    const lbl = labels.get(n) ?? n;
    const arr = groups.get(lbl) ?? [];
    arr.push(n);
    groups.set(lbl, arr);
  }
  return [...groups.entries()]
    .filter(([, members]) => members.length >= 2)
    .map(([lbl, members]) => ({
      id: `ac-${lbl.slice(0, 24)}`,
      label: titleCase(lbl),
      artistIds: members,
    }));
}

/** k-means (k∈4..6 by spread) over (energy, valence) of listened tracks. */
export function moodKMeans(listens: ListenRecord[], seed = 42): MoodCell[] {
  const pts = listens
    .filter((l) => l.completionRatio > 0.5)
    .map((l) => ({ e: l.energy, v: l.valence, id: l.trackId }));
  if (pts.length < 12) return [];

  // Deterministic seeding: spread picks across the sorted-by-energy list.
  const k = pts.length >= 40 ? 6 : 4;
  const centers: Array<{ e: number; v: number }> = [];
  const sorted = [...pts].sort((a, b) => a.e - b.e || a.v - b.v);
  for (let i = 0; i < k; i++) {
    const idx = Math.min(sorted.length - 1, Math.floor(((i + 0.5) / k) * sorted.length));
    centers.push({ e: sorted[idx].e, v: sorted[idx].v });
  }

  let assign = new Array<number>(pts.length).fill(0);
  for (let iter = 0; iter < 8; iter++) {
    // Assign.
    assign = pts.map((p) => {
      let best = 0;
      let bd = Infinity;
      centers.forEach((c, ci) => {
        const d = (p.e - c.e) ** 2 + (p.v - c.v) ** 2;
        if (d < bd) {
          bd = d;
          best = ci;
        }
      });
      return best;
    });
    // Update.
    const sums = centers.map(() => ({ e: 0, v: 0, n: 0 }));
    pts.forEach((p, i) => {
      const s = sums[assign[i]];
      s.e += p.e;
      s.v += p.v;
      s.n += 1;
    });
    centers.forEach((c, ci) => {
      if (sums[ci].n > 0) {
        c.e = sums[ci].e / sums[ci].n;
        c.v = sums[ci].v / sums[ci].n;
      }
    });
  }

  const cells: MoodCell[] = centers.map((c, ci) => ({
    id: `mood-${ci}`,
    label: moodLabel(c.e, c.v),
    energyCenter: round2(c.e),
    valenceCenter: round2(c.v),
    trackIds: pts.filter((_, i) => assign[i] === ci).map((p) => p.id),
  }));
  return cells.filter((c) => c.trackIds.length >= 3);
}

export function moodLabel(e: number, v: number): string {
  if (e >= 0.65 && v >= 0.6) return 'euphoric';
  if (e >= 0.65 && v < 0.45) return 'intense';
  if (e >= 0.45 && v >= 0.55) return 'upbeat';
  if (e >= 0.45 && v < 0.45) return 'brooding';
  if (e < 0.45 && v >= 0.55) return 'serene';
  if (e < 0.45 && v < 0.45) return 'melancholy';
  return 'balanced';
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Personal block-boundary calibration (§6.3): the user's own listen-density
 * edges shift each boundary ±90 min. Light method: median listen hour within
 * ±90 min of the default edge.
 */
function calibrateBoundaries(listens: ListenRecord[]): TasteProfile['boundaries'] {
  const out: TasteProfile['boundaries'] = { weekday: {}, weekend: {} };
  const edges: Array<{ kind: 'weekday' | 'weekend'; block: string; hour: number }> = [
    { kind: 'weekday', block: 'morning', hour: 5 },
    { kind: 'weekday', block: 'afternoon', hour: 11 },
    { kind: 'weekday', block: 'evening', hour: 16 },
    { kind: 'weekday', block: 'night', hour: 20 },
    { kind: 'weekend', block: 'morning', hour: 7 },
    { kind: 'weekend', block: 'afternoon', hour: 13 },
    { kind: 'weekend', block: 'evening', hour: 18 },
    { kind: 'weekend', block: 'night', hour: 22 },
  ];
  for (const edge of edges) {
    const near = listens
      .filter((l) => dayKindOf(l.startedTs) === edge.kind)
      .map((l) => new Date(l.startedTs).getHours() + new Date(l.startedTs).getMinutes() / 60)
      .filter((h) => Math.abs(h - edge.hour) <= 1.5)
      .sort((a, b) => a - b);
    if (near.length >= 10) {
      const median = near[Math.floor(near.length / 2)];
      const offsetMin = clamp((median - edge.hour) * 60, -90, 90);
      if (Math.abs(offsetMin) >= 15) {
        out[edge.kind][edge.block as keyof typeof out.weekday] = Math.round(offsetMin);
      }
    }
  }
  return out;
}

/** Top-N artists after decay + sqrt normalization (§6.2 read shape). */
export function topArtists(p: TasteProfile, now: number, n = 10): Array<{ artist: string; w: number }> {
  return Object.entries(p.artists)
    .map(([artist, e]) => ({
      artist,
      w: decay(e.w, (now - e.lastEventTs) / DAY_MS, e.source === 'heart' || e.source === 'onboarding' ? HALF_LIFE.heart : HALF_LIFE.artist),
    }))
    .filter((x) => !p.corrections.mutedArtists.includes(x.artist))
    .map((x) => ({ ...x, w: Math.sqrt(Math.max(0, x.w)) }))
    .sort((a, b) => b.w - a.w)
    .slice(0, n);
}
