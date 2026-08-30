# SEARCH INTENT-RESCUE PLAN — "The Specific Intent Guarantee"
### TSF Music · Search V2 post-ship failure analysis + complete fix plan
**Version 1.0 · Built from live evidence, not theory · Every claim below was reproduced and captured**

---

## 0. Executive summary — what is the issue

You searched **"tu chaiye of atif aslam"** and the app showed you other songs instead. I cloned the repo (now v3.3.0 — the SEARCH V2 engine rebuild), traced the query through every stage of the engine using the app's own code, and live-fired every probe against the real JioSaavn API. The failure has **two independent layers**, and both needed proving:

**Layer A — Catalog truth (the hidden one): "Tu Chahiye" (Atif Aslam, Bajrangi Bhaijaan) no longer exists on JioSaavn at all.**
This is the decisive finding. It is NOT primarily a spelling or ranking problem:
- Song search never returns it for **any** spelling: `tu chahiye`, `tu chaiye`, `tu cahiye`, `tu chahie`, `tuchahiye`, artist-first `atif aslam tu chahiye`, augmented `tu chahiye bajrangi`, `tu chahiye from bajrangi bhaijaan`, `tu chahiye pritam bajrangi` — 30–50 rows each, **zero Atif "Tu Chahiye" rows in all of them** (the top rows are 0-play cover/spam uploads by other artists with exact-name titles).
- Its own **album is missing it**: the Bajrangi Bhaijaan album on JioSaavn (id 1251872) contains 9 tracks — Selfie Le Le Re, Aaj Ki Party, Bhar Do Jholi Meri ×2, Chicken Kuk-Doo-Koo, Zindagi Kuch Toh Bata, Tu Jo Mila ×3 — **Tu Chahiye is absent**.
- Compilations, playlists, api_version 4/8/10 — nothing. The track was present historically (iTunes/Apple still lists 6 versions, #1 for `tu chahiye atif aslam`); on JioSaavn it has evidently been **removed for rights**.

Conclusion: **no amount of on-device spell correction or re-ranking can ever retrieve a song the provider does not have.** The engine must detect this situation and go cross-provider — which is exactly what it fails to do.

**Layer B — Engine behavior: when the provider can't satisfy the intent, the app paints *confidently wrong* songs instead of telling the truth.**
With the app's real engine code and the real provider responses, the final painted list for your query is:

| # | Painted row | Artist | Why it won |
|---|---|---|---|
| 1 | **O'Meri Laila** | Atif Aslam, Jyotica Tangri | artistMatch=1 → disambiguation override promotes it, reason "Best match for your search" |
| 2 | **Kon Mayate** | Atif Aslam BD | substring bug: "atif aslam bd" contains "atif aslam" → artistMatch=1 |
| 3–8 | Mujhko Tu Chaiye, Tu Chahiye (A.R. Dixit), Tu Chaiye (SPECRO), Na Tu Chaiye, Swaminarayan Dhun… | other artists | demoted by the override |

So the app took your words, found *some* Atif Aslam songs, and labeled an unrelated one "Best match for your search" — while **iTunes had the exact song at #1 the whole time** (the engine's rescue provider), gated behind a rule that never fired (see RC2). The song is unreachable *and* the engine hides the truth. Layer B is what this plan fixes; Layer A is what the rescue ladder works around.

---

## 1. Reproduced failure chain (evidence, stage by stage)

All captures in `/home/z/my-project/research/tuchahiye/` (probe scripts + full JSON). In-app simulation ran the repo's actual `planSearch → probesFor → verifySet → rankRows` on the captured provider data.

**S0 plan (src/search/plan.ts)** for `"tu chaiye of atif aslam"`:
- `kind = artist_title`, `artistTokens = ["atif aslam"]`, `titleTokens = ["tu","chaiye","of"]`
- `corrections = []` — "chaiye" is correctable by nothing: the SymSpell lexicon is built from artist priors + seeds + vibe vocab + recent searches + titles seen in past results. A song title the user has never successfully found **cannot** be in the lexicon (cold-start gap).
- The natural-language connector **"of" is treated as a title token**.

**S1 probes (src/search/retrieve.ts `probesFor`)**:
- Emits `[raw, normalized, title]` = `["tu chaiye of atif aslam", "tu chaiye of atif aslam", "tu chaiye of"]` — **the first two probes are byte-identical** (wasted slot), and the surname probe ("aslam") is cut by `slice(0,3)` anyway.
- Probe 1/2 (artist+title): provider hijacks to artist-token junk — 7 rows, all wrong songs (O Meri Laila, Kon Mayate, Swaminarayan Dhun…).
- Probe 3 (title "tu chaiye of"): 30 rows of same-name songs **only by other artists** (A.R. Dixit, SPECRO, Rock Hussain, Tarun Panchal…) — canonical version absent (Layer A).
- Autocomplete: returns **nothing** for all variants (even correctly spelled).
- Merged pool: 44 rows. iTunes top-up is gated on `mergedCount < 8` → **never fires**, despite iTunes having the song at #1.

**S3 rank (src/search/rank.ts)**:
- `titleCoverage` counts artist-token hits toward "query match": O'Meri Laila scores qm=0.40 from the words "atif aslam" alone.
- `artistMatchScore` uses substring containment: "Atif Aslam BD" false-matches.
- The **disambiguation override** (any artistMatch≥1 row caps all artistMatch=0 rows) then does the damage: every *correct-title / wrong-artist* row is demoted below *wrong-title / right-artist* rows. The override was built for "same-name song, wrong artist wins" — here it flips into "wrong song, right artist wins" because **the requested song itself has no row in the pool**.

**Honesty gate (src/api/music.ts)**:
- `anyRelevant = ranked.some(r => r.queryMatch >= 0.34 || r.artistMatch >= 1)` → O'Meri Laila has artistMatch=1 → gate passes → junk is painted with reason "Best match for your search". **The honest-zero escape hatch is defeated by exactly the signal that's false here.**

**S4 relaxation**: only fires when `tracks.length < 3` → 44 rows → never runs.

**S5 learning**: nothing to learn — the target never entered any pool, so no click can reinforce it; there is no "intent unmet" signal either.

---

## 2. Root causes

- **RC1 — Catalog absence (Layer A).** The song is gone from JioSaavn. Unfixable on-provider; requires cross-provider rescue and honest UX.
- **RC2 — iTunes rescue is gated on COUNT, not RELEVANCE.** `mergedCount < 8` asks "did we get *enough* rows?" when the right question is "did we get *the row the user asked for*?" 44 junk rows suppress the rescue that had the answer.
- **RC3 — The disambiguation override backfires when the target is absent.** It demotes title-matching rows below any artist-credited row, promoting O'Meri Laila/Kon Mayate. Plus `titleCoverage` double-counts artist tokens, and artist matching is substring-based ("Atif Aslam BD").
- **RC4 — S0 gaps.** Connector "of" pollutes the title probe; raw/normalized probes are identical (wasted slot); surname probe cut; no orthographic variant expansion ("chaiye"→"chahiye"); lexicon has no song-title vocabulary at cold start.
- **RC5 — Honest-zero loophole.** `artistMatch >= 1` alone defeats the relevance gate, so the app never enters any honest state for this query class.
- **RC6 — No memory of unmet intent.** The learning loop records queries and clicks but nothing about *specific-intent queries that produced no artist+title row*, so the same failure repeats forever.

---

## 3. The design — Specific Intent Guarantee (SIG)

### 3.1 The contract

> **For every plan that carries artistTokens, the app must end in exactly one of four declared states — and the UI must say which one it is in.**

| State | Meaning | UI presentation |
|---|---|---|
| **S-HIT** | A row matching BOTH the artist (boundary-exact) and the title (≥50% distinctive title tokens) exists organically | Current behavior; "Best match for your search" |
| **S-RESCUED** | Not found organically; found by the rescue ladder (iTunes / album / variant probe) | Top result, labeled "Found via Apple Music — preview" + existing Preview badge; truthful reason line |
| **S-PARTIAL** | Songs matching the title exist but not by the requested artist (and rescue found nothing) | Header **"Songs matching \"tu chaiye\""**; artist disambiguation chips (A.R. Dixit · SPECRO · Rock Hussain…); honest note "The Atif Aslam version isn't available on JioSaavn right now"; **never** "Best match for your search" |
| **S-ZERO** | Nothing relevant at all | Existing honest zero + did-you-mean |

**The one iron rule:** a row that matches the artist but ~zero title tokens may never be painted as a match, no matter how thin the pool is. This single rule kills the entire "搜 A 出 B" class.

### 3.2 M1 — S0 hardening (`plan.ts`, `normalize.ts`, `lexicon.ts`)

1. **Connector stopwords.** New `CONNECTOR_WORDS = { of, by, from, ka, ki, ke, se, and, with, feat, ft, saath }` — stripped from `titleTokens` and from every probe string (kept in `raw` for display only). "tu chaiye of" → title probe "tu chaiye".
2. **Probe budget rework for `artist_title`.** Probes become: `[titleOnly (connector-stripped), titleOnlyVariant? (from 4), artistCatalogSeed?]` — deduped (raw ≡ normalized must never occupy two slots), surname-only probe dropped (it fed nothing).
3. **Orthographic variant expansion (bounded, deterministic).** New `ORTHO_VARIANTS` table for high-frequency Hindi romanization classes: `chaiye↔chahiye↔chaahiye↔cahiye`, `raha↔rahaa`, `pyar↔pyaar` (already folded), `sachiya↔sachiyaa`, class rule: insert/drop `h` after the first consonant for tokens ending in `-aiye/-ahiye/-aayi`. Generate ≤2 alternative title spellings; they ride as extra probes **only** when the token is unknown to the lexicon (cold-start path — exactly the user's case).
4. **Song-title lexicon seeds.** (a) Titles/artists already feed from painted results (existing `feedLexicon`); (b) NEW: a shipped compact seed list of ~600 canonical film-song titles+artists (≈6–8 KB asset, compile-time constant) so day-one correction of "chahiye-class" typos works; (c) snapshot persistence already exists (ledger kv) — unchanged.

### 3.3 M2 — Rank truth fixes (`rank.ts`)

1. **`titleCoverage` counts title tokens only.** Artist tokens live exclusively in `artistMatch`; a row matching only the artist must score qm≈0, not 0.40. This feeds both ranking and the honest gate.
2. **Word-boundary artist matching.** Replace `hay.includes(a)` with token-sequence containment on the artist string: "atif aslam" matches "Atif Aslam" and "Muhammad Atif Aslam", never "Atif Aslam BD" (the credit must contain the full name as an adjacent word sequence).
3. **Disambiguation override v2.** The override now promotes only rows with `artistMatch ≥ 1 AND titleCovTitle ≥ 0.5`. Artist-only rows (titleCov 0) are capped *below* title-matching rows — they may remain in the list as related songs but can never be #1 "Best match" when a title-matching row exists. (When NO title-matching row exists either, see M3/M4 — the SIG gate fires instead of the override.)

### 3.4 M3 — The SIG gate (after first rank, `music.ts`)

After the first rank, evaluate: `sigUnmet = plan.artistTokens.length > 0 && !rows.some(r => r.artistMatch ≥ 1 && r.titleCovTitle ≥ 0.5)`.

- If **sigUnmet**: enter the rescue ladder (M4). Paint nothing labeled as a match yet — optionally paint the title-matching rows immediately under the S-PARTIAL header (progressive paint already exists), then upgrade when rescue lands.
- If met: current flow (S-HIT).

### 3.5 M4 — Rescue ladder (new `src/search/rescue.ts`; ≤1.5 s total, parallel-first)

**R1 — iTunes rescue (proven: returns the song at #1 for this exact case).**
`searchItunes(title + " " + artist, 10)` → verify each row on BOTH axes (boundary artist match + ≥50% title-token coverage) → map through the existing iTunes mapping (previewUrl, 30 s, previewOnly) → add as pool `rescue` → re-rank. Wall cost ≈300–600 ms; may land **after paint** (upgrade S-PARTIAL → S-RESCUED when it arrives).

**R2 — Album route (full-length, for the "exists but not in song search" class).**
If any pool row's `clusterKey` equals the title cluster (evidence the title exists in the catalog), or the query carries a recognizable movie token: `search.getAlbumResults(q=artist or movie)` → top ≤3 albums → `content.getAlbumDetails` → filter tracks by clusterKey + boundary artist. Full-length saavn tracks; preferred over iTunes when both hit. (For "Tu Chahiye" R2 finds nothing — the song is truly gone — but R2 rescues the sibling class where the song exists only via its album, like rights-partial catalogs.)

**R3 — Variant re-probe.** Re-issue the M1.3 expanded-spelling probes ("tu chahiye") that the initial fan-out didn't include. Cheap; rescues the misspelling class where the provider actually has the song (e.g. "mashooqa"-class typos it tolerates, "chaahiye" double-vowel variants it doesn't).

**Order & budget:** R1 ∥ R3 immediately (≤600 ms), R2 only if both miss (≤900 ms more). Hard cap: 3 rescue calls, 1.5 s; every call abortable via the existing generation AbortController. Rescue rows always carry `pool: 'rescue'` for provenance and truthful reason lines.

### 3.6 M5 — Presentation (`SearchScreen.tsx`)

- **S-RESCUED**: top result = the found track, subtitle "Found via Apple Music · 30s preview", existing Preview badge; plays/pauses/skips exactly like today's iTunes tracks. If R2 later supplies a full-length row, it replaces the preview row automatically (organic rank wins).
- **S-PARTIAL**: new header component `intentNote`: "Songs matching \"tu chaiye\"" + horizontally scrollable artist chips (distinct artists from the pool, tapping re-queries `title + artist`) + honest catalog note ("The Atif Aslam version isn't available on JioSaavn right now"). Reason lines on rows stay truthful (PROVIDER_TOP, never MATCHES_SEARCH).
- **S-ZERO**: unchanged (existing honest zero + did-you-mean), now also reached from S-PARTIAL when the title-matching set is itself empty.
- All testIDs additive; device-lab contract untouched (placeholder text, 400 ms debounce, 2200 ms settle, existing testIDs preserved).

### 3.7 M6 — Learning & memory (`learn.ts`, ledger)

1. **Rescue recall.** Extend the existing fragment→track recall cache to artist_title plans: when a rescue succeeds, persist `(normalizedQuery → {trackId, title, artist})`. Next search for the same query paints S-RESCUED instantly from the LRU (<15 ms) with reason "You chose this for this search before".
2. **Intent-unmet ledger event.** New additive `SEARCH_INTENT_UNMET {query, kind, artistTokens, poolSizes, rescued:boolean}` — no behavior change, but it grows an offline eval corpus of exactly the queries users *couldn't* find, which becomes the gauntlet regression corpus over time.

---

## 4. Acceptance criteria & gauntlet bars

**SI1 (the user's query, locked).** Fixture = the captured junk pools (committed under `.fixture-cache`) + mocked iTunes hit. Engine on "tu chaiye of atif aslam" MUST end in S-RESCUED with "Tu Chahiye (From \"Bajrangi Bhaijaan\")" as top result. Locked forever.
**SI2 (override v2).** In the same fixture WITHOUT the iTunes hit, O'Meri Laila and Kon Mayate must NOT outrank "Tu Chahiye" (A.R. Dixit); state = S-PARTIAL; no row carries MATCHES_SEARCH except title-matching rows.
**SI3 (boundary match).** "Atif Aslam BD" never artist-matches "atif aslam"; "Muhammad Atif Aslam" always does.
**SI4 (qm truth).** O'Meri Laila titleCoverage = 0.0 for this plan (artist tokens don't count toward qm).
**SI5 (connectors).** "of/by/from/ka/ki/ke" stripped from probes: title probe is "tu chaiye", not "tu chaiye of".
**SI6 (variant expansion).** Cold-start plan for "tu chaiye" produces variant probe "tu chahiye"; bounded ≤2 variants; deterministic.
**SI7 (latency).** Rescue adds ≤600 ms p95 after paint; total search p95 within existing budgets; perf test extended with rescue-on and rescue-off modes.
**SI8 (no-regression).** All 126 existing tests stay green; live A/B on the 36-query lab corpus shows no rank regressions on previously-working queries (Kesariya, Tum Hi Ho, Apna Bana Le, lyric fragments, typos).
**SI9 (variant corpus).** New 20-query specific-intent corpus (chaiye/chahiye class, artist-first orders, 3 more known rights-removed songs) — each must end in a declared SIG state with correct presentation.

---

## 5. Rollout

- **P0 — Kill the confident wrongness (pure, no new network):** M2 (qm truth, boundary match, override v2) + M3 gate + honest gate fix (`anyRelevant` requires titleCov ≥ 0.34 for artist_title plans; artistMatch alone no longer sufficient). Ship-value: immediately stops wrong "Best match" labels.
- **P1 — Cross-provider rescue:** M4-R1 iTunes + M5 S-RESCUED/S-PARTIAL UI + SI1/SI2 locks. Ship-value: the user's exact query now finds the song (30 s preview, honestly labeled).
- **P2 — S0 intelligence:** M1 connectors, probe dedupe, variant expansion, lexicon seeds + M6 learning (rescue recall + intent-unmet event). Ship-value: fixes the broader class upstream; second searches get instant answers.
- **P3 — Full-length rescue:** M4-R2 album route + corpus expansion + live A/B re-verify.

## 6. Pre-mortem

- **iTunes noise** (compilations, karaoke) → dual-axis verification (artist + title tokens), quality sort, cap 10.
- **Preview disappointment** (user wanted the full song) → the UI tells the truth ("30s preview · full version not on JioSaavn"), and R2 upgrades to full-length when the catalog has it; this is honest scarcity, not silent degradation.
- **Provider flux** (song may return to JioSaavn) → rescue is additive: organic artist+title rows always outrank rescue rows at equal title match, so the moment the catalog heals, normal ranking wins again with zero code change.
- **Probe-budget creep** → hard caps (≤4 search probes + ≤3 rescue calls) enforced in the perf test with printed actuals.
- **Rescue correctness** → a rescue row that fails re-verification at rank time is dropped, never shown.
- **Device lab / webmocks** → additive testIDs only; new rescue mock added so web behaves; metro redirect map extended if any new api file is added.

## 7. Evidence index

- `/home/z/my-project/research/tuchahiye/probes.json` — all 7 query variants + autocomplete captures
- `/home/z/my-project/research/tuchahiye/probe2.mjs / probe3.mjs` — deep pages, album route, artist endpoint, iTunes, api_version sweep
- In-app simulation transcript (plan/probes/pools/final top-8) — reproduced in §1
- Code: `src/search/{plan,retrieve,rank,verify,recover,learn}.ts`, `src/api/{music,saavn,itunes}.ts` @ v3.3.0 (commit 18e23aa)
