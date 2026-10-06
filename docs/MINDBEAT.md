# MINDBEAT — the on-device intelligence stack

MINDBEAT (shipped in v3.0.0) is TSF Music's learning engine. It observes
every interaction, grades it as evidence, models who you are and what
room you're in, and turns that into every recommendation the app makes —
**entirely on the device**. No LLM API, no server, no telemetry.

```
L1  EVENT LEDGER      what actually happened (graded, crash-safe)
L2  TASTE PROFILE     who this listener is (decaying affinities,
                      daypart matrix, clusters, corrections)
L3  SESSION BRAIN     what's happening right now (12-track window,
                      vibe state machine, storm detection)
L4  DECISION ENGINE   what plays next (5-pool scoring, exploration
                      budget, truthful reasons, determinism)
L5  SURFACES          where it shows up (shuffle, radio, mixes,
                      daylist, on-the-rise, AI playlists, vibe search)
L6  TRUST             why you can believe it (transparency, control,
                      privacy, safety)
```

`src/ai/mindbeat.ts` is the single facade. Screens and the player never
touch anything below it.

---

## L1 — The Event Ledger (`core/ledger.ts`)

Every meaningful interaction becomes graded evidence:

| Event | Grade weight |
|---|---|
| INSTANT_REJECT (skip < 5 s) | −3.0 |
| EARLY_SKIP (< 30 s) | −1.5 |
| MID_SKIP (30–75 %) | −0.5 |
| LATE_SKIP (> 75 %) | +0.5 |
| COMPLETED (≥ 95 %) | +2.0 |
| REPLAY (≤ 7 d) | +1.0 |
| HEART | +4.0 |
| HEART_CONTRADICT (hearted but instant-skipped ×2) | +1.0 |
| DOWNLOAD | +2.5 |
| NOT_FOR_ME (track) | −4.0 |
| NOT_FOR_ME (artist) | −1.0 |

Key properties:

- **Blame splits** — a skip is not one signal; it is split across
  artist / track / mood / session with per-grade proportions, so one bad
  2am session doesn't destroy an artist you love.
- **Sessions** are reconstructed with a 30-minute gap rule and capped at
  ~45 min ("beyond that, the room has changed").
- **Crash safety** — 10-second heartbeats mean killing the app mid-track
  loses zero evidence; the next boot reconstructs the partial listen.
- **Bounded storage** — 90-day retention, ≤ 20 000 raw events enforced
  by compaction, WAL-mode SQLite with transactional writes.
- **Single-owner instrumentation** — PlayerProvider owns events in the
  foreground, the background service mirrors ownership when the UI is
  killed. Phantom skips from double instrumentation are regression-tested.

## L2 — The Taste Profile (`core/profile.ts`)

A pure function `buildProfile(listens, events, sessions) → profile`
(same inputs → same profile; replay-testable):

- **Affinity maps** (artist / genre / language / era) with per-tier
  half-lives: hearts decay over 180 d, artists 45 d, genres 60 d,
  eras 120 d. What you loved last month still matters; what you loved
  last year matters less.
- **The daypart matrix** — 5 blocks (morning / afternoon / evening /
  night / lateNight) × weekday/weekend, each cell holding its own artist
  weights and energy/valence moments. Weekend boundaries shift +2 h;
  after day 14, learned boundaries may drift ±90 min from *your*
  behavior.
- **Proxy feature space** (`core/features.ts`) — RN can't tap the audio
  buffer, so each track gets estimated (energy, valence, tempoClass)
  from three blended sources: cultural priors (110-artist pack +
  genre priors + title rules, `core/priors.ts`) and **behavioral
  calibration** — observed outcomes pull estimates toward your truth
  (a "low-energy" track that always completes at 2am learns it belongs
  at night).
- **Co-play graphs** (track + artist level), decayed and
  popularity-damped, capped at 5000 tracks / 2000 artists.
- **Taste clusters** — artist label-propagation + mood k-means cells.
- **Corrections** — Boost (×2), Mute, Not-for-me, applied to the very
  next recommendation.
- **Onboarding seeds** — artist picks enter at weight 3.0 (~6 h of
  listening equivalent), genre picks at 2.2 (taste hints, not anchors).

## L3 — The Session Brain (`core/session.ts`)

Models *this* listening run:

- 12-track sliding window with recency tiers (newest third ×3 … oldest ×1)
- **Vibe state machine**: WARMUP / FLOW / PEAK / WIND_DOWN / SKIP_STORM /
  EXPLORING, recomputed on every transition
- **Skip-storm protocol** — 3 instant-rejects within 6 tracks triggers
  emergency healing: the engine pivots away from the blamed
  artist/mood immediately
- Cross-session dedup memory: last 100 radio/shuffle serves blocked for
  7 days

## L4 — The Decision Engine (`core/decision.ts`)

The single authority that turns candidate pools into "the next tracks":

1. **Hygiene filters** — dedup memory, mutes, recency, per-track skip
   profiles
2. **Scoring** — `Score = 1.0·ProfileAffinity + 1.2·SessionFit +
   0.8·DaypartFit + 0.6·Freshness + 0.4·SourceTrust + δ(explore)`;
   energy deviating beyond ±0.2 of the session triggers a quadratic
   penalty (vibe-lock)
3. **Exploration budget** — ε-greedy with context: ε = 0.5 for sessions
   1–5, decaying to 0.15 mature; cross-language exploration clamped to
   ≤ 1-in-5 slots; ε auto-drops when exploration under-converts
   (target: 10 % of fresh finds complete/save within 30 d)
4. **Truthful reasons** — every pick carries one of eight reason codes
   with hard truth conditions (the app never invents an explanation)
5. **Determinism** — seeded PRNG; same inputs → same order
   (replay-testable)

Also enforced at order time: same-artist ≤ 2 per 6 tracks, hard 7-day
freshness block, hard 30-second stream-count rule in stats.

### Reason codes (the closed vocabulary)

| Code | Meaning (hard condition) |
|---|---|
| `BECAUSE_PLAYED` | you play this artist heavily |
| `BECAUSE_HEARTED` | you hearted this artist |
| `NEIGHBOR` | co-play neighbor of what you play |
| `FITS_BLOCK` | fits your current daypart cell |
| `SESSION_CONTINUITY` | matches the current session's energy/mood |
| `FRESH_FIND` | never played before (exploration slot) |
| `FROM_YOUR_AI_MIX` | surfaced from your saved AI playlist |
| `BACK_FOR_MORE` | you completed it recently and it's due back |

## L5 — The Surfaces (`src/ai/surfaces/`)

| Surface | File | Behavior |
|---|---|---|
| Smart Shuffle v2 | `shuffle.ts` | 1 rec per 3 tracks (playlists > 15); vibe-locked to current session energy; **queue healing** — a skipped rec re-seeds the next slot away from the blamed artist/mood (back-off: 4 slots between heals); tightens to 1:2 after a playlist save |
| Radio v2 | `radio.ts` | multi-seed (last track + artist + session window + daypart cell); drifts to an adjacent mood cell every 5th slot ("the radio that breathes"); dedup-blocks the last 100 serves for 7 d; runs in the background service so it survives UI death |
| Daily Mixes v2 | `mixes.ts` | 3–6 mixes = artist-cluster × mood-cell crosses; 60/25/15 core/bridge/fresh split; ≤ 30 % repeat from yesterday; re-ranked nightly AND after every 3rd session |
| Now Sound (daylist) | `daylist.ts` | the current daypart cell's playlist with microgenre naming ("Midnight Riyaz", "Monsoon Ghazals") |
| On the Rise | `ontherise.ts` | seed-of-seed artists (neighbors of co-play neighbors), never-played tracks only, honest "via artist" chains, rolling 7-day window |
| AI Playlist v2 | `playlist.ts` | five stages — UNDERSTAND (intent parse: negations first-class, Hinglish/code-mix, multi-mood, languages, activities, energyTarget) → HUNT (parallel searches, pool 60–120) → CURATE (ID-in/ID-out scoring — no LLM to hallucinate) → POLISH (safety, dedupe, artist cap 5, no 3 consecutive same-artist, activity energy arcs, max energy step 0.25) → NARRATE (daylist-pattern name + description). Output 25 tracks (18 floor) |
| Vibe Search | `search.ts` | NLP mode: routes queries through the same intent parser; "songs like X" resolves via similarity; typos resolve through fuzzy mood matching; parsed intent renders as chips |

Surfaces never import the network directly — they receive an injected
`CatalogApi` (`surfaces/deps.ts`), which is what makes the entire layer
runnable in Node for replay tests.

## L6 — Trust

- **Transparency**: Taste DNA (`TasteScreen`) renders the entire model —
  affinity weight bars, the daypart matrix, exploration stats, the
  reason vocabulary
- **Control**: per-artist Boost / Mute / Not-for-me from any track row;
  profile reset; the kill switch (disable all recommendations) persists
  across restarts
- **Your data**: export the full profile + ledger as JSON; the ledger
  stores no URLs or device identifiers (verifier-tested)
- **Safety**: every surface passes `src/safety.ts` (explicit flags +
  EN/Hindi/Punjabi blocklist); dodge-corpus tested
- **Honesty**: stats use the industry 30-second rule; the ladder
  principle (§10.4) means MINDBEAT surfaces never render *emptier* than
  the v2.1 legacy layer they replace — young profiles fall back
  gracefully

## Performance budgets (`constants.ts` §10.3, enforced by `tests/ai/perf.test.ts`)

| Operation | Budget | Measured |
|---|---|---|
| `decide()` p95 | 150 ms | ~3.9 ms |
| profile read | 50 ms | ~0.2 ms |
| profile rebuild (90 d / 20 k events) | 3000 ms | ~57 ms |
| ledger write (amortized) | 10 ms | ~0.001 ms |
| cold-start delta | 80 ms | snapshot boot + deferred rebuild |

## Tuning

**Every number lives in `src/ai/core/constants.ts`** — grade weights,
half-lives, score weights, exploration, session windows, cadences,
daypart boundaries, retention, budgets. Nothing in the intelligence
stack may hard-code a weight, threshold or half-life; tuning is a
one-file edit with the rationale stated inline.

## Verification

- 74 replay tests (`bun test`): ledger grading/compaction, profile
  determinism, session storms, decision hygiene, surface contracts,
  perf budgets, plus 25 gauntlet regression locks
  (`tests/ai/gauntlet-r2.test.ts`) covering the P0s found during the
  build (double instrumentation, storm-blind decide, negation holes…)
- Blind A/B vs the v2.1 generator: MINDBEAT preferred 17/20
  (`scripts/ab2-blind.txt`)
- Device-lab walkthrough exercises the AI screens end-to-end on both
  device profiles (see docs/DEVELOPMENT.md)

---

## The Lightweight Genius lift (v4.2.0) — baked data, honest notes

Six additions extended the stack without a single new dependency, model
or server (the standalone contract held):

- **Phase 1 — captured genres.** `Track.genre` (iTunes `primaryGenreName`)
  feeds genre affinity at half an onboarding pick's weight. JioSaavn's
  public API exposes NO genre field — its cultural tag is `language`,
  which keeps flowing through its own channel. Old favorite rows are
  backfilled lazily the first time the track plays with a tag.
- **Phase 2 — the baked feature table.** `assets/baked_features.json`
  (~122k keys, ≤2.5MB gzipped) carries real Spotify audio features
  (energy/valence/danceability) for the world's most-played tracks,
  baked from the HuggingFace dataset `maharshipandya/spotify-tracks-dataset`
  (CC-ish research dataset; Kaggle was NOT used). Priority:
  dataset(0.8) → behavioral calibration (±0.05 cap) → cultural priors.
- **Phase 3 — the Thompson bandit.** Beta arms over artist/track; the
  hard veto excludes >75%-rejected tracks from every serving pool.
- **Phase 4 — the Markov flow.** DIRECTED session transitions; the
  FLOW_NEXT reason keeps a follow-up honest ("Keeps your flow going").
- **Phase 5 — lyric mood.** VADER (MIT license — see
  https://github.com/cjhutto/vaderSentiment) + a generated romanized
  Hindi/Punjabi table (`src/ai/core/romanizedMood.ts`; regenerate with
  `python3 scripts/gen_romanized_mood.py`). Bounded ±0.25 valence-only.
- **Phase 6 — sound-alike.** Tag-overlap similarity on a bounded pool;
  the `SOUND_ALIKE` reason and the vibe-shift/AI-playlist surfaces.

**Re-baking the feature table** (data refresh — a manual, offline step):

```bash
curl -L -o scripts/bake_data/dataset.csv \
  'https://huggingface.co/datasets/maharshipandya/spotify-tracks-dataset/resolve/main/dataset.csv'
python3 scripts/bake_features.py      # writes assets/baked_features.json
python3 scripts/gen_vader_json.py     # refresh the VADER JSON (rare)
bun test tests/ai/baked_features_locks.test.ts   # key parity + parse budget
```

The bake script ports `src/search/normalize.ts` VERBATIM into Python and
fails loudly if the gzipped asset ever exceeds 2.5 MB.

**Honest limitations** (what this lift can NOT do):

- The baked table is a popularity snapshot: niche/regional and brand-new
  tracks are absent and fall through to the prior chain (byte-identical
  to the pre-Phase-2 behavior). Spotify's audio features were computed
  from their audio analysis pipeline, not ours — they are ground-truth-ish
  priors, not measured from the stream.
- The bandit is contextless (no daypart/session features per arm); the
  session brain and daypart matrix still own context. Arms reset by
  eviction (≤2000), not by forgetting curves — very old arms decay only
  when evidence arrives.
- The Markov flow needs repeats: a transition observed once is a whisper,
  not a rule (the median truth condition filters whispers out).
- Lyric mood reads LEXICONS, not semantics: sarcasm, negation and code-
  switching can fool it — which is why the delta is bounded at ±0.25 and
  only valence ever moves.
- Sound-alike tags are as good as the metadata: no genre tag ⇒ fewer
  shared dimensions ⇒ honest silence over invented similarity.
