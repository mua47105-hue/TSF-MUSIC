# The GENIUS Intelligence Upgrade — re-baking, licenses, honest limits

The "Lightweight Genius" upgrade makes MINDBEAT dramatically smarter using
only lightweight math and pre-baked knowledge — no ML models, no servers,
no telemetry, no paid APIs. This note is the operator's page: how to
re-bake the assets, what licenses they carry, and — honestly — where each
technique's blind spots are.

## 1. Re-baking the feature table (Phase 2)

The baked knowledge table ships as `assets/baked_features.json`
(≤ 2.5 MB gzip, enforced by the script AND asserted by
`tests/ai/feature_table_locks.test.ts`). Re-bake:

```bash
# 1. refresh the source CSVs (both free, no login)
curl -L -o scripts/data/spotify_tracks.csv \
  "https://huggingface.co/datasets/maharshipandya/spotify-tracks-dataset/resolve/main/dataset.csv"
curl -L -o scripts/data/spotify_2p3m.parquet \
  "https://huggingface.co/datasets/P-Arpan/Spotify_Audio_features_2.3M/resolve/main/Spotify_Audio_features.parquet"

# 2. re-bake (fails loudly over the gzip ceiling; trims least-relevant rows first)
python3 scripts/bake_features.py            # optional arg: local CSV path
```

- **Keys are the app's own identity** — the script is an exact port of
  `src/api/recording.ts` (`recordingKey`, `titleKeyOf`) plus
  `src/search/normalize.ts` `clusterKey`. No invented normalization: change
  those files and the bake changes with them.
- The 2.3M-row parquet has **no popularity column**; its rows are filtered
  to the curated `INDIA_SPINE` artist list in the script (reviewable,
  ordered by prominence) and capped (`SUPPLEMENT_CAP`).
- Runtime lookup order: `recordingKey` → bare `titleKey` (provider artist
  spellings differ) → cluster-folded title (version decorations differ).
  A miss falls through to the priors path byte-identically.

## 2. Re-baking the lexicons (Phase 5)

```bash
python3 scripts/bake_lexicon.py        # VADER → assets/vader_lexicon.json
python3 scripts/bake_hindi_lexicon.py  # curated list → assets/hindi_lexicon.json
```

- **VADER** (Hutto & Gilbert, **MIT license**) — pruned honestly to fit the
  100 KB combined law: tokens the tokenizer can never produce (pure
  punctuation/emoticon forms) and the weakest-magnitude tail are dropped
  (policy stamped in `assets/vader_lexicon.meta.json`).
- **The Hindi/Punjabi list** is hand-curated IN the script
  (`scripts/bake_hindi_lexicon.py`) — that file IS the reviewable source.
  Edit words, re-run, commit. Combined lexicon assets stay < 100 KB.
- **AFINN is NOT used** (its ODbL attribution requirement is a landmine we
  chose not to carry; nothing ships from it).

## 3. Honest limitations (what each technique CANNOT do)

- **Baked table** — coverage, not truth: ~83k of the world's recordings.
  Recent (2021+) regional hits are the weakest slice (both free datasets
  predate or under-sample them). A miss is silent and honest — priors
  answer instead, exactly as before the upgrade.
- **Bandit** — it learns *per track*, so it cannot generalize ("skip this
  artist" is the corrections system's job, not the bandit's). Ambiguous
  skips (MID/LATE) deliberately count as neither good nor bad. The arms
  cap (2000) means very old rarely-played tracks may be evicted and
  re-learned cold — by design.
- **Flow memory** — needs ~two plays of a pair in one session before an
  edge exists; cold users get zero flow bonus. It follows habits, it does
  not invent taste. Loops cannot re-serve anything inside the 7-day
  freshness window (hygiene prefilter).
- **Lyric mood** — English + romanized Hindi/Punjabi coverage only; a
  lexicon-miss lyric scores null (no change). Instrumentals, heavy
  metaphor and sarcasm are invisible. The delta is bounded (±0.15 net)
  because words are a hint, never truth. Energy is NEVER touched by
  lyrics.
- **Similarity** — needs metadata: thin rows (a YouTube-only row with no
  genre/language/year) are ineligible, honestly. Same-artist results are
  capped because "more by them" is not "close to this song". The mood
  dimension inherits every feature-space caveat above.
- **Everything** respects the kill switch (`Taste DNA → disable
  intelligence`): no bandit writes, no lyric writes, no similarity, no
  dataset lookups — the app falls back to classic behavior with zero
  error surfaces.

## 4. Verification

- `bunx tsc --noEmit` · `bun test` — 421 replay tests, including
  `feature_table_locks` (asset law: gzip ceiling, version stamp, real-key
  hits), `bandit_locks` (determinism, caps, muted artists), `flow_locks`
  (directional edges, loop safety), `lyric_mood_locks` (bounds, LRU,
  chorus dedupe), `similarity_locks` (≥2 gate, artist cap), and
  `genre_capture_locks` (byte-identical on miss).
- The asset law is enforced TWICE: the bake script fails loudly at bake
  time; the test re-measures the shipped file in CI.
