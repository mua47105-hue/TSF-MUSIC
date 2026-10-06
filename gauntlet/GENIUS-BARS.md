# GENIUS BARS — the "Lightweight Genius" intelligence upgrade (6 phases)

The bar for every phase: **the app gets measurably smarter on a potato phone
without breaking a single locked behavior.** Each bar below is a pinned,
verifiable statement — the blind critic checks the diff against THESE, not
against vibes. Mission text is the source; this file pins the testable form.

## Hard invariants (every phase, every gate)

- **G1** `bunx tsc --noEmit` exit 0 after every phase.
- **G2** `bun test` 0 fail; 368 original locks stay green. A legacy test may
  only change with a written justification comment (never weakened blindly).
- **G3** Zero new runtime dependencies. Static bundled data files allowed.
- **G4** Every new tuning number lives in `src/ai/core/constants.ts` with a
  rationale comment. Grep-verified: no bare numbers in new scoring paths.
- **G5** Determinism: no `Math.random()` anywhere new; seeded mulberry32 only.
- **G6** Nothing new runs inside cold start (`coldStartDeltaMs ≤ 80` budget;
  perf.test.ts stays green). New data loads lazily after first paint.
- **G7** Kill switch `intelligenceDisabled` silences every new write/read
  path; missing data degrades to EXACTLY today's behavior (byte-identical
  when table/lexicon absent or track unknown).
- **G8** Truth conditioning: every new ReasonCode wired in ALL THREE places
  (enum + truthCondition + reasonLine) and never fires without its evidence.
- **G9** Potato-phone memory: every new persisted table has a hard cap +
  eviction; the feature Map holds ONE copy (raw payload released).

## Phase bars

- **P1 genre capture**: a Track with `genre` nudges that genre's affinity
  through the EXISTING pseudo-genre path; missing genre changes nothing vs
  today (byte-identical). Lazy backfill updates an old genre-less favorite
  from fresh results exactly once.
- **P2 baked table**: `assets/baked_features.json` ≤ 2.5 MB gzip (script
  FAILS LOUDLY over ceiling), version-stamped, keys baked with the repo's
  OWN recording identity (normTitle/normSeg/recordingKey/titleKeyOf port).
  Runtime: baked hit → `source: 'dataset'`, confidence 0.8 (constants),
  lookup chain recordingKey → titleKey → clusterKey-fold; miss → byte-
  identical priors path; calibration still shifts baked values afterwards.
- **P3 bandit**: Thompson sampling per trackId from EXISTING grade weights
  (alpha: COMPLETED/REPLAY/HEART/DOWNLOAD; beta: INSTANT_REJECT/EARLY_SKIP/
  NOT_FOR_ME), seeded beta variate (deterministic replay), kv cap 2000 arms
  evicting lowest alpha+beta, additive term weight 0.5, ε floors untouched,
  muted artists never become arms, kill switch blocks all writes.
- **P4 flow memory**: directional A→B transitions from session-consecutive
  listens (distinct from B→A), top-8 per node, ≤3000 edges, coplayEdge
  half-life, co-play graph untouched (no double-count). FLOW_NEXT truth:
  transition weight above the median of the seed's outgoing edges (the
  NEIGHBOR pattern). Cold users: zero boost, zero code-path change.
- **P5 lyric mood**: VADER (MIT) + curated romanized Hindi/Punjabi lexicon
  < 100 KB combined; LRC timestamps + section tags stripped; repeated
  chorus lines counted ONCE; delta bounded to ±0.25 pre-blend (blend 0.6 →
  net ≤ ±0.15), VALENCE ONLY (energy untouched); no lyrics → no change.
- **P6 similarity**: tag-overlap over the bounded candidate pool only
  (inverted index, ≤120 candidates), ≥2 shared dimensions required, artist
  dim down-weighted, per-artist cap 2, thin rows (<2 tags) ineligible,
  seed without tags → honest empty. SOUND_ALIKE wired in all three places.

## Final acceptance (the user's "Definition of Smart")

1. Cheap phone stays fast; memory flat (caps + lazy loads prove it).
2. ~20 graded listens measurably shift ordering (replay-test-provable).
3. Popular songs report REAL energy/valence with `source: 'dataset'`.
4. "Why this?" lines stay 100% truthful — no fabrication, no social proof.
5. Every technique fails silently: kill switch, missing table, null lyrics,
   cold user — the app behaves exactly as well as today.

## Critic protocol

Fresh-context subagent reads this file + the diff (labels stripped of
authorship), checks each bar against the actual code/tests, names the
single biggest gap per phase, P0s block. Fix-first, re-gate, repeat until
the critic finds no P0/P1.
