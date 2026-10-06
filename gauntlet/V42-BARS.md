# v4.2.0 GAUNTLET BARS — "GODMODE INTELLIGENCE"

The mission: ship the full 6-phase "Lightweight Genius" upgrade AND the
v4.2.0 gauntlet (audit squash, latent-bug hunt, god-tier UX), verified
end-to-end. A fresh-context harsh critic re-checks every bar blind; the
loop does not end until every check is green and the critic signs off.

Ground truth discovered at gauntlet start: main = c856f77 (v4.1.0), the
6-phase work was NOT yet in the repo — so this run builds the phases and
then applies the bars on top. `CODEBASE-DEEP-DIVE.md` does not exist; the
source files are the truth.

## BAR 1 — The Audit Squash (procedural blockers)

| # | Check | Verified by |
|---|---|---|
| 1.1 | `docs/ARCHITECTURE.md` L13 = `Wire` tab (not Premium), L43 = `Wire` in TabParamList prose, L52 = 13 fonts (not "six Figtree weights") — each matches the source of truth (`src/screens/navigation.ts`, `App.tsx` useFonts block) | critic reads the 3 lines + the sources |
| 1.2 | `tests/ai/lyric_mood_locks.test.ts` asserts the ±0.25 valence clamp using the hardcoded literal `0.25` — NOT `LYRIC_MOOD.maxDelta` (a constant-referencing test can't catch a constant regression) | read the test source |
| 1.3 | A timed test invokes the REAL `loadFeatureTable()` require path and asserts parse < 2000 ms; `scripts/verify_v42_apk.py` exists, unzips a release APK, asserts `baked_features.json` + `vader_lexicon.json` present | run the test; read the script |
| 1.4 | Law #6: `mindbeat.ts::soundAlike` passes its merged pool through `reconcileRecordings()` BEFORE `rankSoundAlike` | read the facade |

## BAR 2 — Latent Bug Hunt (logic collisions)

| # | Check | Verified by |
|---|---|---|
| 2.1 | BANDIT VETO: in `decision.ts`, a track arm with reject rate > 75% (`beta/(alpha+beta)` with ≥6 net evidence — "two strikes", critic-tuned so ONE accidental tap never bans a track) is excluded from EVERY serving pool regardless of flowBonus/profile affinity. Weights derive from GRADE_WEIGHTS, so: 3 instant-rejects ⇒ β=10, rate 10/11, evidence 9 ⇒ vetoed; 2 instant-rejects ⇒ rate 7/8, evidence 6 ⇒ vetoed; a single instant-reject ⇒ evidence 3 < 6 ⇒ NOT vetoed (forgiven); 3 skips + 2 completions ⇒ rate 0.667 ⇒ NOT vetoed; a single mild MID_SKIP ⇒ not vetoed; seeded onboarding arms (α=3, β=1) ⇒ never vetoed | `tests/ai/bandit_veto_locks.test.ts` |
| 2.2 | CALIBRATION CAP: `calibrate()` applies full behavioral pull only to `prior`/`metadata` sources; `dataset`/`lyric` sources are capped at ±0.05 delta per channel (ground truth must not be overridden by night-listening loops) | `tests/ai/lyric_mood_locks.test.ts` + bandit locks |

## BAR 3 — God-Tier UX (the "machine" feel)

| # | Check | Verified by |
|---|---|---|
| 3.1 | Dynamic feed: MINDBEAT `feedSongQueries()` reads profile genres/moods + session vibe and yields real queries (WIND_DOWN + indie ⇒ "melancholy indie acoustic"-class); empty yield ⇒ legacy hardcoded ladder untouched; pager calls the generator on every ladder advance | `tests/ai/feed_query_locks.test.ts` |
| 3.2 | Session-aware search rank: `RankContext.sessionVibe` adds ≤ +0.5 alignment bonus using baked energy; never applies to `lyric_fragment`; never lifts artist-zero rows above title-matching rows (SIG-safe); `search_sig_e2e.test.ts` still green ("tu chaiye" rescue path) | locks + existing e2e test |
| 3.3 | Cold-start bandit seeding: `setOnboardingSeeds` pre-seeds artist arms α=3 β=1 so Day-1 Smart Shuffle/Radio favor chosen artists | `tests/ai/bandit_veto_locks.test.ts` |

## BAR 4 — The Gates

| # | Check |
|---|---|
| 4.1 | `bunx tsc --noEmit` == exit 0 |
| 4.2 | `bun test` == 430+ pass / 0 fail |
| 4.3 | MUTATION TESTING: each fix is actively mutated (veto threshold, feed generator fallback, search bonus) and the suite must CATCH every mutation — a surviving mutation means the test is theatre and gets rewritten |

## The 12 house laws (unchanged, any violation = P0)

1. Standalone contract: no server/account/telemetry/LLM API; bundled static data is allowed.
2. Zero new ML/model dependencies.
3. Every new tuning number lives in `src/ai/core/constants.ts` with a reason comment.
4. Outside `src/ai/`, only `src/ai/mindbeat.ts` may be imported.
5. Determinism: same inputs → same outputs; seeded mulberry32 on scoring paths; NEVER `Math.random()`.
6. ReasonCode three-way sync (enum + truthCondition + reasonLine).
7. Performance budgets are law (decision ≤150 ms p95, cold start ≤+80 ms, rebuild ≤3000 ms); nothing new on the cold-start path — everything lazy, after first frame.
8. Potato-phone memory: every new table has a hard cap + eviction; never hold two large datasets at once.
9. Every new algorithmic surface passes `filterClean()`; every merge point runs `reconcileRecordings()`; persisted Tracks are stripped of streamUrl.
10. Tests run on bun; after every phase: `bunx tsc --noEmit` (exit 0) + `bun test` (0 fail, 368+ baseline pass); new logic gets replay tests in `tests/ai/` (storeMemory + fixtures).
11. New exports in `src/api/{saavn,itunes,artists,lrclib,youtube}.ts` must be mirrored in `src/webmocks/`.
12. Kill switch: every new surface respects `intelligenceDisabled` and degrades gracefully to existing behavior when data is missing.

## Phase acceptance (the 6 phases underneath the bars)

- **P1 genre capture**: Track.genre (itunes `primaryGenreName`; JioSaavn exposes NO genre field — language already captured, documented honestly). Captured genre feeds genreAffinities at `ONBOARDING.genreSeedWeight × 0.5`; listens WITHOUT genre leave the profile byte-identical. Lazy backfill of old favorite rows on play.
- **P2 baked features**: HF `maharshipandya/spotify-tracks-dataset` (Kaggle banned); normalizeQuery+clusterKey ported VERBATIM into Python; recordingKey + bare titleKey + clusterKey entries; ≤200k rows popularity-sorted; gzip ≤2.5 MB hard fail; `loadFeatureTable()` lazy (never in `init()`), ONE live copy (the Metro-parsed module object IS the table — a Map would be a second live copy, forbidden by law ⑧); priority dataset(0.8) → calibration → priors; miss ⇒ byte-identical behavior.
- **P3 bandit**: arms {α,β} from {1,1}; GRADE_WEIGHTS-derived updates; Cheng/Joehnk Beta on seeded mulberry32; kv cap 2000 arms (evict lowest α+β); SCORE_WEIGHTS.bandit additive; exploration budget untouched.
- **P4 markov flow**: DIRECTED session-consecutive transitions (A→B ≠ B→A) in profile; per-node top-8, floor-pruned, ≤3000 edges; coplayEdge half-life; SCORE_WEIGHTS.flowNext; FLOW_NEXT three-way sync.
- **P5 lyric mood**: VADER (MIT) + generated romanized Hindi/Punjabi table (~300 words); LRC strip + chorus dedup; bounded ±0.25 valence-only; kv LRU 1000 by recordingKey; async post-fetch only.
- **P6 similarity**: lazy tag vectors; inverted index ONLY on the bounded pool; ≥2 shared dims; artist dim down-weighted 0.3; per-artist cap 2; `soundAlike(seed, count)` facade via injected CatalogApi; SOUND_ALIKE three-way sync; vibe-shift fallback + AI-playlist hunt source; no new tab.
