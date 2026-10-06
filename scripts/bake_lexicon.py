#!/usr/bin/env python3
"""
GENIUS P5-asset — fetch the VADER sentiment lexicon (MIT license, no
attribution burden) and bake it to a compact JSON word → score map.

Format in:  vader_lexicon.txt lines of  `token\tmean\tsd\tscores…`
Format out: assets/vader_lexicon.json  `{ "word": mean }` (2 decimals,
sorted keys, compact separators).

100 KB asset law (mission Phase 5): VADER ships 7.5k tokens ≈ 120 KB raw.
Two honest prunes make it fit WITHOUT touching lookup behavior:
  1. tokens the app's tokenizer can never produce (pure punctuation /
     emoticon forms like '$:' or '%-)') — dead weight for lyric scoring;
  2. the weakest-magnitude tail, trimmed until the file fits the budget —
     in a bounded ±0.25 mood hint the |score| ≈ 0.x tail carries the
     least signal. The cut is deterministic: |score| desc, then A→Z.
The applied policy is stamped into assets/vader_lexicon.meta.json.

Re-run any time:  python3 scripts/bake_lexicon.py
"""

import json
import re
import sys
import urllib.request

LEXICON_URL = "https://raw.githubusercontent.com/cjhutto/vaderSentiment/master/vaderSentiment/vader_lexicon.txt"
OUT_PATH = "assets/vader_lexicon.json"
META_PATH = "assets/vader_lexicon.meta.json"
SIZE_CEILING = 100_000   # 100 KB — mission law for the COMBINED lexicon assets
VADER_BUDGET = 90_000    # leave room for the curated Hindi/Punjabi list
# The app's tokenize() keeps [a-z0-9'&-] (plus Devanagari) — anything else
# in the lexicon can never match a lyric token.
MATCHABLE = re.compile(r"[a-z0-9'&-]+")


def main() -> int:
    raw_text = None
    try:
        with urllib.request.urlopen(LEXICON_URL, timeout=30) as res:
            raw_text = res.read().decode("utf-8")
    except Exception as e:  # noqa: BLE001 — honest failure, human can place the file
        print(f"LEXICON FAIL: could not fetch {LEXICON_URL}: {e}", file=sys.stderr)
        print("Download it manually to scripts/data/vader_lexicon.txt and re-run.", file=sys.stderr)
        return 1
    return bake(raw_text)


def bake(raw_text: str) -> int:
    lex: dict[str, float] = {}
    for line in raw_text.splitlines():
        parts = line.strip().split("\t")
        if len(parts) < 2:
            continue
        token = parts[0].strip()
        try:
            mean = float(parts[1])
        except ValueError:
            continue
        if token and token not in lex:  # first occurrence wins (file is deduped anyway)
            lex[token] = round(mean, 2)

    # Prune 1: tokens the tokenizer can never produce.
    lex = {k: v for k, v in lex.items() if MATCHABLE.fullmatch(k)}

    # Prune 2: deterministic strongest-first trim into the budget.
    order = sorted(lex.items(), key=lambda kv: (-abs(kv[1]), kv[0]))
    kept: dict[str, float] = {}
    size = 0
    for k, v in order:
        entry = json.dumps({k: v}, separators=(",", ":"), ensure_ascii=False)[1:-1]  # "k":v
        if size + len(entry.encode("utf-8")) + 1 > VADER_BUDGET:  # +1 comma
            continue
        kept[k] = v
        size += len(entry.encode("utf-8")) + 1

    data = json.dumps(kept, separators=(",", ":"), sort_keys=True, ensure_ascii=False).encode("utf-8")
    if len(data) > SIZE_CEILING:
        print(f"LEXICON FAIL: {len(data)} bytes over the {SIZE_CEILING} B ceiling", file=sys.stderr)
        return 1
    with open(OUT_PATH, "wb") as f:
        f.write(data)
    dropped = len(lex) - len(kept)
    weakest = min((abs(v) for v in kept.values()), default=0)
    with open(META_PATH, "w", encoding="utf-8") as f:
        json.dump({
            "source": "VADER lexicon (Hutto & Gilbert, MIT) — github.com/cjhutto/vaderSentiment",
            "words": len(kept),
            "droppedWeakest": dropped,
            "weakestKeptAbsScore": weakest,
            "prunes": ["unmatchable punctuation/emoticon tokens", "weakest-magnitude tail to fit the 100 KB law"],
            "precision": 2,
        }, f, indent=2)
    print(f"OK wrote {OUT_PATH}: {len(kept)} words, {len(data)} bytes ({dropped} weakest dropped, floor |{weakest}|)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
