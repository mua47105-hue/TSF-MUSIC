/**
 * evolution/eval-rank.mjs — the EVALUATOR for the Task-28 evolution run.
 *
 * Target: src/search/rank.ts (SEARCH V2 ranker — pure, deterministic,
 * self-budgeted at ≤40ms for 60 candidates).
 *
 * Contract (openevolve skill, law #1): deterministic, fast, numeric.
 * Prints ONE JSON line:
 *   { correctness, p95_ms, code_size, combined_score }
 *
 * Scenarios (each is a product-level invariant, gate-style — a fail is a
 * fail, not a penalty):
 *   01 artist_title intent        05 title precision (extra tokens)
 *   02 muted artist demotion      06 ortho variant must not lose (M1.3)
 *   03 engagement beats rank      07 artist-only cap (M2.3)
 *   04 lyric verdict wins         08 determinism (same in → same order)
 *   09 provider fallback order    10 perf budget: p95 ≤ 40ms @ 60 cands
 */

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const ROOT = process.cwd();
const CAND = process.env.EVOLVE_CANDIDATE;
if (!CAND || !fs.existsSync(CAND)) {
  console.error('EVOLVE_CANDIDATE missing');
  process.exit(2);
}

// stage the candidate INSIDE src/search/ so its `./normalize` import resolves
const stagedPath = path.join(ROOT, 'src/search/__evolve_cand.ts');
fs.copyFileSync(CAND, stagedPath);

// ── fixture helpers ─────────────────────────────────────────────────────
let seq = 0;
function track(title, artist, over = {}) {
  seq += 1;
  return {
    id: `t${String(seq).padStart(3, '0')}`,
    title,
    artist,
    album: 'Fixture Album',
    artwork: '',
    duration: 200,
    source: 'saavn',
    previewOnly: false,
    ...over,
  };
}
function cand(t, poolRank, pool = 'probe') {
  return { ...t, poolRank, pool };
}
function plan(raw, opts = {}) {
  const tokens = raw.toLowerCase().split(/\s+/).filter(Boolean);
  return {
    raw,
    normalized: raw.toLowerCase(),
    tokens,
    kind: 'artist_title',
    titleTokens: tokens,
    artistTokens: [],
    connectorTokens: [],
    variants: [],
    windows: [],
    corrections: [],
    cacheKey: raw,
    ...opts,
  };
}
const ctx = (over = {}) => ({ engagement: {}, artistAffinity: {}, mutedArtists: new Set(), now: 0, ...over });

// ── scenarios ───────────────────────────────────────────────────────────
function scenarios(rankRows) {
  const results = [];
  const check = (name, fn) => {
    try {
      results.push([name, fn() === true]);
    } catch {
      results.push([name, false]);
    }
  };

  // 01 — artist+title intent beats same-title-wrong-artist and right-artist-wrong-song
  check('01 artist_title intent', () => {
    const p = plan('tum hi ho arijit singh', { titleTokens: ['tum', 'hi', 'ho'], artistTokens: ['arijit', 'singh'] });
    const rows = [
      cand(track('Tum Hi Ho', 'Arijit Singh'), 2),
      cand(track('Tum Hi Ho Bandhu', 'Kavish Seth'), 0), // better provider rank, wrong artist
      cand(track('O Meri Laila', 'Arijit Singh'), 1), // right artist, wrong song
    ];
    return rankRows(p, rows, ctx())[0].id === 't001';
  });

  // 02 — muted artist demoted: EQUAL footing otherwise, the muted row loses
  // (contract: personalization returns -0.5 for muted credits, rank.ts L201)
  check('02 muted demotion', () => {
    const p = plan('tum hi ho');
    const rows = [
      cand(track('Tum Hi Ho', 'Badshah'), 0),
      cand(track('Tum Hi Ho', 'Arijit Singh'), 0),
    ];
    const out = rankRows(p, rows, ctx({ mutedArtists: new Set(['badshah']) }));
    return out[0].artist === 'Arijit Singh';
  });

  // 03 — two fresh clicks (engagement 1.2) beat provider-rank delta (S8 bar)
  check('03 engagement override', () => {
    const p = plan('tum hi ho');
    const rows = [
      cand(track('Tum Hi Ho', 'Cover Band'), 0),
      cand(track('Tum Hi Ho', 'Arijit Singh'), 5),
    ];
    const e = { [rows[1].id]: 1.2 };
    return rankRows(p, rows, ctx({ engagement: e }))[0].artist === 'Arijit Singh';
  });

  // 04 — lyric_fragment: verified lyric match outranks plain matches
  check('04 lyric verdict wins', () => {
    const p = plan('ab tum hi ho bas ab', { kind: 'lyric_fragment' });
    const rows = [
      cand(track('Some Other Song', 'Someone'), 0),
      cand(track('Tum Hi Ho', 'Arijit Singh'), 4),
    ];
    const v = new Map([[rows[1].id, { matched: true, line: 'ab tum hi ho' }]]);
    return rankRows(p, rows, ctx(), v)[0].id === rows[1].id;
  });

  // 05 — exact title beats extra-token title at EQUAL provider rank
  // (S2 precision contract: 2.5·qm·(0.55+0.45·precision) decides)
  check('05 title precision', () => {
    const p = plan('tum hi ho');
    const rows = [
      cand(track('Tum Hi Ho Bandhu', 'Kavish'), 0),
      cand(track('Tum Hi Ho', 'Arijit Singh'), 0),
    ];
    return rankRows(p, rows, ctx())[0].title === 'Tum Hi Ho';
  });

  // 06 — ortho variant (M1.3): the STANDARD spelling gets full query
  // coverage ('chahiye' accepted via plan.variants) and at better or equal
  // provider rank must not lose to a row that copied the user's typo
  check('06 variant parity', () => {
    const p = plan('tu chaiye', { titleTokens: ['tu', 'chaiye'], variants: ['tu chahiye'] });
    const rows = [
      cand(track('Tu Chahiye', 'Pritam'), 0), // standard spelling
      cand(track('Tu Chaiye', 'Typer Artist'), 1), // copied the typo
    ];
    const out = rankRows(p, rows, ctx());
    const standard = out.find((r) => r.title === 'Tu Chahiye');
    return standard && standard.queryMatch >= 1 && out[0].artist === 'Pritam';
  });

  // 07 — artist-only rows sink below title-matching rows (M2.3)
  check('07 artist-only cap', () => {
    const p = plan('tu chaiye atif aslam', { titleTokens: ['tu', 'chaiye'], artistTokens: ['atif', 'aslam'] });
    const rows = [
      cand(track('O Meri Laila', 'Atif Aslam'), 0), // right artist, wrong song
      cand(track('Tu Chahiye', 'Pritam'), 2), // title match, wrong artist
    ];
    const out = rankRows(p, rows, ctx());
    return out.findIndex((r) => r.title === 'Tu Chahiye') < out.findIndex((r) => r.title === 'O Meri Laila');
  });

  // 08 — determinism: identical inputs → identical order
  check('08 determinism', () => {
    const p = plan('tum hi ho');
    const rows = [cand(track('Tum Hi Ho', 'Arijit Singh'), 1), cand(track('Tum Hi Ho Bandhu', 'Kavish'), 0)];
    const a = rankRows(p, rows, ctx()).map((r) => r.id).join(',');
    const b = rankRows(p, rows, ctx()).map((r) => r.id).join(',');
    return a === b;
  });

  // 09 — no signals → provider order survives
  check('09 provider fallback', () => {
    const p = plan('lofi chill beat');
    const rows = [cand(track('Chill Beat One', 'A'), 1), cand(track('Chill Beat Two', 'B'), 0)];
    return rankRows(p, rows, ctx())[0].title === 'Chill Beat Two';
  });

  return results;
}

// ── evaluate ────────────────────────────────────────────────────────────
async function main() {
  const mod = await import(stagedPath);
  const rankRows = mod.rankRows;
  if (typeof rankRows !== 'function') {
    console.log(JSON.stringify({ correctness: 0, p95_ms: 999, code_size: 0, combined_score: 0, error: 'rankRows missing' }));
    return;
  }

  const results = scenarios(rankRows);
  // 10 — the file's own budget: p95 ≤ 40ms for 60 candidates

  // code_size EXCLUDES comments and blank lines — otherwise the metric pays
  // for stripping documentation (a gaming vector the first run exposed;
  // openevolve law #1: the evaluator defines what evolution optimizes).
  const raw = fs.readFileSync(stagedPath, 'utf8');
  const codeOnly = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('//'))
    .join('\n');
  const codeSize = codeOnly.length;
  // perf: 60-candidate pool, 300 runs, p95
  const p = plan('tum hi ho arijit singh', { titleTokens: ['tum', 'hi', 'ho'], artistTokens: ['arijit', 'singh'] });
  const pool = Array.from({ length: 60 }, (_, i) =>
    cand(track(`Tum Hi Ho Remix ${i}`, i % 4 === 0 ? 'Arijit Singh' : `Artist ${i}`), i % 30),
  );
  const times = [];
  for (let i = 0; i < 300; i++) {
    const t0 = performance.now();
    rankRows(p, pool, ctx());
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)];

  results.push(['10 perf budget p95<=40ms', p95 <= 40]);
  const passed = results.filter(([, ok]) => ok).length;
  const correctness = passed / results.length;

  const perfScore = Math.max(0, Math.min(1, (80 - p95) / 60)); // 20ms→1.0, 80ms→0
  const compactScore = Math.max(0, Math.min(1, (14000 - codeSize) / 6000)); // 8k→1.0, 14k→0
  const allPass = correctness === 1;
  // hard gate: any failed invariant caps the score at correctness*0.5
  const combined = allPass
    ? 0.7 + 0.25 * perfScore + 0.05 * compactScore
    : correctness * 0.5;

  const failed = results.filter(([, ok]) => !ok).map(([n]) => n);
  const out = {
    correctness: Number(correctness.toFixed(3)),
    p95_ms: Number(p95.toFixed(2)),
    code_size: codeSize,
    perf_score: Number(perfScore.toFixed(3)),
    combined_score: Number(combined.toFixed(4)),
    ...(failed.length ? { failed_scenarios: failed } : {}),
  };
  console.log(JSON.stringify(out));
}

main()
  .catch((e) => console.log(JSON.stringify({ correctness: 0, combined_score: 0, error: String(e?.message || e).slice(0, 300) })))
  .finally(() => {
    try { fs.unlinkSync(stagedPath); } catch {}
  });
