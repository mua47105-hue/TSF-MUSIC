# V5.3.0 BARS — Spotify RE Intelligence & Audio Lift

**Source corpus**: `spotify-re-investigation.zip` (client 1.2.95.453 RE, reports 00–06
+ MASTER blueprint + 3 clean-room reconstructions, all tiered T1/T2/T3).
**Method**: gauntlet discipline — every BAR lands with literal locks, mutation-proof
teeth, and a byte-exact degradation path. Every port cites its evidence tier.
**House laws ①–⑫ apply unchanged** (standalone, zero deps, single tuning table,
facade, seeded determinism, no Math.random in engine paths, perf budgets, bounded
caches, hygiene, literal locks, webmock parity, kill switch).

## BAR 1 [P0] — Baked loudness × tempo × acoustic vectors + Album-mode ReplayGain

**Evidence**: T1+T2 (F3.8: `default_album_normalization_params` exists beside
`default_file_normalization_params`; −14 LUFS target public; `lufs.csv` resource).
The current bake ships e/v/d only — the loudness column `l` was wired in Wave B B1
but never carried data ("the wiring is live; the data is the honest gap").

**The bar**:
- `scripts/bake_features.py` bakes `l` (LUFS, 1dp), `t` (BPM, int), and quantized
  acoustic `a`/`s`/`i` (acousticness/speechiness/instrumentalness, 2dp) from the
  same HF dataset rows; bake version 1.1.0.
- Gzip law holds: `assets/baked_features.json` gzipped ≤ 2,621,440 bytes (the
  bake's tail-cut loop enforces it; if the floor can't fit, the bake FAILS LOUDLY).
- `BakedFeatures` gains `t?`, `a?`, `s?`, `i?` (all optional — rows from older
  bakes stay valid; `l` was already optional).
- Facade: `mindbeat.bakedTempoFor()` + `mindbeat.bakedAcousticFor()` (same lazy
  O(1) contract as `bakedEnergyFor`/`bakedLoudnessFor`).
- `replayGain.ts` Album Mode: `computeAlbumGain(loudnesses)` = target − mean(LUFS
  of present rows), ±6 dB clamp, ONE gain for the whole album (intra-album
  dynamics preserved — the Spotify album-mode semantics); empty/missing ⇒ 0 dB
  exactly (byte-identical no-op). `applyReplayGainForTrack` unchanged in
  signature; PlayerProvider passes the album gain when the whole queue is one
  album (same normalized album name), else per-track.

**Degradation**: any missing column ⇒ exactly v5.2.1 behavior (gain 0 dB factor
1.0; tempo/acoustic lookups return null and callers no-op).

## BAR 2 [P0] — Artist-spread shuffle + the 2-strike retreat

**Evidence**: T2+T3 + validated reconstruction (10,000 runs: same-artist adjacency
0.00% vs 13.89% Fisher–Yates baseline; mean artist gap 5.98 ≈ ideal 5.0). Spotify's
own history: Fisher–Yates → spreading model after clustering complaints.

**The bar**:
- `src/player/spreadShuffle.ts` (NEW, pure): `spreadShuffle(tracks, rng)` —
  group by primary artist → Fisher–Yates inside each group (rng) → weighted
  interleave, weight = turnsSinceLastPick × remainingInGroup × jitter(0.5+rng()).
  Strict permutation (same multiset out), empty ⇒ [].
- `PlayerProvider.setShuffle` uses it (the current track PINNED at index 0, only
  the upcoming window reordered — same contract as v5.2.1), seeded
  `mulberry32(hash32(queueIds + epochBucket))` — never `Math.random()` (the v5.2.1
  `shuffleArray` used Math.random: house law ⑤ closes that hole at the player
  layer too).
- Smart Shuffle 2-strike retreat (T3 psychoacoustics: "after 2–3 exploratory
  skips the product retreats to safe content"; the reconstruction's
  `SessionState.on_outcome` ×0.55 retreat): after 2 consecutive early-skipped
  recommendations, `shuffle.ts` tightens the vibe lock to half tolerance and
  halves the injection cadence until a recommendation completes. State lives in
  mindbeat (`noteRecommendedOutcome`), constants in `SHUFFLE_RETREAT`.

**Degradation**: kill switch / empty strike state ⇒ exactly v5.2.1 cadence and
lock widths; `setShuffle(false)` restores the original order unchanged.

## BAR 3 [P1] — Bandit arm decay + context shelf arms + ranked Home shelves

**Evidence**: T2 (BaRT RecSys 2018 — shelves are bandit treatments with IPS;
2025 homepage calibration bandit conditioned on time/context). Our bandit's
evidence never fades today — a 2019 listen weighs like yesterday's.

**The bar**:
- Arm exponential decay toward the prior: `α' = 1 + (α−1)·0.5^(Δt/τ)`,
  `β'` likewise, τ = `HALF_LIFE.banditArm` (30d) — applied on hydrate + flush;
  arms store `ts` (last-update); pre-v5.3.0 arms (no ts) stamp NOW (honest
  migration: decay starts at v5.3.0, never fabricates a past date).
- Context shelf arms `s:<shelfId>:<block>` (daypart block = the context).
- `mindbeat.rankHomeShelves(shelfIds, now)`: deterministic-per-dayblock Thompson
  ordering (seed = hash32(dayKey|shelfIds)); returns ranked ids + records
  propensities into a bounded IPS ring (`SHELF_RANK.ipsCap`); cold arms ⇒ input
  order byte-identical.
- `mindbeat.noteShelfEngagement(shelfId)`: opening a shelf's collection = reward
  1 for its arm, reward 0 for the other ranked arms (one pull per home pass) —
  the honest impression/reward pair we can actually measure on-device.
- HomeScreen orders the AI shelves (crate / mixes / onTheRise / because) by the
  ranking when ≥2 are present and intelligence is on.

**Degradation**: disabled/kill-switch/cold ⇒ the exact v5.2.1 fixed order.

## BAR 4 [P1] — 64 KB Range pre-warm (the head-file pattern, on-device)

**Evidence**: T1+T2 (F3.3: first-128 kB unencrypted head file, dedicated CDN
template, disk-cached; `HeadFileDownload.http_64k_latency` proves
time-to-first-64 kB is a first-class SLO). We cannot change the CDN, but we CAN
warm DNS+TLS+the first bytes of the ALREADY-RESOLVED stream URL for N+1.

**The bar**:
- `prewarm.ts`: after a URL resolves for a primed row, fire a single `fetch`
  with `Range: bytes=0-65535` (64 KB — the SLO's own number), gated
  `networkKind === 'wifi' && !dataSaverActive()`; response body discarded, one
  flight per parked URL (`PREWARM.rangeBytes`, `PREWARM.rangeTtlMs`), hard-bounded
  LRU set; 'unknown' network behaves as NOT-wifi (conservative, existing law).
- Never blocks the parked-promise contract; failures are swallowed (a warm miss
  is worth zero, never negative).

**Degradation**: no wifi / data saver / failure ⇒ exactly v5.2.1 prewarm.

## BAR 5 [P2] — Quantized (float8-E4M3) cosine similarity — the Voyager layer

**Evidence**: T2 (Voyager: HNSW + E4M3 8-bit quantization, 4× memory reduction;
spectrogram-derived features feed the same vector space as co-occurrence). Our
similarity is tag-overlap only — no feature-space geometry at all.

**The bar**:
- `similarity.ts`: `quantizeE4M3` (bit-exact float8 E4M3 encode/decode, the
  Voyager quantization), `quantizedFeatureVector` — [e, v, d, a, s, i] each
  encoded to one byte, `quantizedCosine` — cosine over the dequantized vectors
  (pure integer/float math, deterministic).
- `rankSoundAlike` tie-break: equal tag score → quantized cosine to the seed
  desc → id (the two-stage retrieval→ranking pattern). Applies ONLY when both
  seed and candidate have baked features; otherwise exactly the v5.2.1 order.

**Degradation**: no baked rows ⇒ the v5.2.1 ordering, byte-identical.

## BAR 6 [P2] — Equal-power cosine crossfade curve

**Evidence**: T1 (F3.6 transition arbiter: per-track fade metadata + fade-API
crossfade; equal-power is the standard DJ curve class) + T3. Our ramp is linear
— an audible slope discontinuity when the fade starts (psychoacoustics report
§4: dead-air/edges are treated as defects).

**The bar**:
- `crossfade.ts`: `fadeCurveFactor(progress, curve)` — `'cosine'` = equal-power
  out-gain `cos(p·π/2)` (zero-slope start — no cliff), `'linear'` = the v5.2.1
  ramp, retained and selectable. Default `CROSSFADE.curve = 'cosine'`.
- `fadeSeconds 0` remains a byte-exact no-op (factor exactly 1.0, no bus write).

**Degradation**: off (0 s) ⇒ identical to v5.2.1; `curve: 'linear'` restores the
legacy ramp exactly.

## BAR 7 [P2] — SingAlong dwell: the implicit-signal loop

**Evidence**: T1+T2+T3 (F6.3: per-video-surface ms accumulation proves visual
coupling is measured, not incidental; the closed psychoacoustic→ML loop: lyrics
keep the screen alive during listening → skip rates drop at vulnerable
transitions → the signal feeds the rankers). We render SingAlong but harvest
zero signal from it.

**The bar**:
- New ledger event `SINGALONG_DWELL` (emit when the SingAlong view was open ≥
  `SINGALONG.minOpenRatio` (0.5) of a COMPLETED track's duration) — payload
  { artist, openRatio }.
- Profile: artist bump `GRADE_WEIGHTS.SINGALONG_DWELL` (1.0 — a weak positive,
  between LATE_SKIP 0.5 and COMPLETED 2.0; it is evidence of attention, not of
  an extra listen).
- Bandit: the track + artist arms get the same small alpha via the existing
  evidence weights (no new grade union member — discrete signal, like HEART).
- mindbeat facade: `noteSingAlongOpen()` / the dwell fold at trackFinished.

**Degradation**: no lyrics view / ratio below the floor ⇒ no event, no bump —
exactly v5.2.1.

## BAR 8 — Verification & release engineering

- `package.json`/`app.json` 5.3.0; README QA line + feature notes; worklog entry
  (the honest-numbers format).
- `tests/wave_v530_spotify_re_locks.test.ts` — ≥60 new assertions across all 7
  BARs, literal-locked (law ⑩).
- `scripts/mutations_v530.py` — ≥14 source mutations (M-530-1..14, ≥2 per BAR),
  each proven RED (its lock file fails) + SHA-256 byte-exact restore; backups in
  `.mutation-backups/v530/`.
- `scripts/verify_v530_apk.py` — APK deep-verify (retained v5.2.1 bars + the
  v5.3.0 markers), exact Hermes string-table membership (the v4.3 lesson).
- Gate: 3 consecutive byte-identical `bun test` runs, `bunx tsc --noEmit` = 0,
  CI Native Android + E2E green, APK verified.

## Loop discipline

Builder + fresh-context critic per BAR; every mutation RED-OK'd before the next
BAR starts; no early victory laps — the numbers land in the worklog exactly as
measured.
