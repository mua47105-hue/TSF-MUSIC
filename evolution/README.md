# EVOLUTION RUN — src/search/rank.ts (Task 28 · godmode)

OpenEvolve-methodology run against the SEARCH V2 ranker, per the
`openevolve` skill (`references/playbook.md`, Path B). Harness:
`skills/openevolve/scripts/evolve.mjs` (MAP-Elites 2-dim cells + 3 islands +
diff-only mutation + hard evaluation gate). Mutations by GLM through a local
OpenAI-compatible shim (`scripts/zai-shim.mjs`), 14 generations, seed on
island 0.

## Evaluator — `eval-rank.mjs`

Contract (skill law #1: the evaluator is everything): deterministic, fast,
prints one JSON line.

- **10 hard-gate scenarios** — product invariants taken from rank.ts's own
  documented contracts and the S2/S8/M1.3/M2.3 lock suite: artist+title
  intent, muted demotion (equal-footing), engagement override, lyric verdict,
  title precision (equal provider rank), ortho-variant parity, artist-only
  cap, determinism, provider fallback, and the file's own p95 ≤ 40 ms budget
  (60 candidates × 300 runs).
- **Metrics**: `correctness` (gate: any fail caps combined at 0.5·correctness),
  `p95_ms`, `code_size`, `combined_score = 0.7 + 0.25·perf + 0.05·compact`
  when all invariants pass.
- **code_size excludes comments** — see lesson 2 below.

## Results

| run | metric | champion |
|---|---|---|
| seed (baseline) | correctness 1.0 · p95 4.3-4.6 ms · code-only 8,132 B | **0.9544 → 0.9989** (after metric fix) |
| 14 generations, 3 islands | every accepted mutation scored ≤ champion | **champion = initial program** |

No mutant beat the seed. Every invalid mutation was **rejected by the gate**
(correctness drops → 0.45-0.53 scores for broken variants) and every valid
mutation only matched or slightly trailed the baseline. The ranker has been
through five test-gated tuning rounds already (v4.0.x search locks); the run
confirms it sits at a local optimum under this metric. Honest no-land: the
working tree keeps the initial program.

## Lessons (recorded for the skill)

1. **Empty-island sampling bug** (fixed in the harness): with 1 seed on 3
   islands, the 0.2 exploration draw can select an empty island → undefined
   parent → the loop silently exits. Fallback: sample globally when the
   island is empty.
2. **Evaluator gaming vector — comment stripping**: the first metric counted
   raw file bytes, which pays evolution for deleting documentation. Two
   mutants drifted that way. Fixed: `code_size` now strips comments/blank
   lines, so compaction must come from real code. (Skill law #1 proven live:
   the evaluator defines what evolution optimizes — get it wrong and
   evolution optimizes the wrong thing.)
3. **Hard gates work**: broken children (dropped invariants) scored 0.45 and
   could never enter the archive; artifacts from failed evals fed back into
   the next prompt for that lineage.

## Reproduce

```bash
node scripts/zai-shim.mjs            # local OpenAI-compatible endpoint
cd TSF-MUSIC
node ../skills/openevolve/scripts/evolve.mjs \
  --target evolution/initial-rank.ts \
  --eval "bun evolution/eval-rank.mjs" \
  --iters 14 --islands 3 \
  --endpoint http://localhost:8787/v1 --key local --model zai
```
