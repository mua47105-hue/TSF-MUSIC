#!/usr/bin/env python3
"""
Convert the VADER lexicon (MIT, cjhutto/vaderSentiment) into the compact
JSON the app bundles: {word: mean_valence} — raw VADER means in -4..4,
rounded to 3dp; the runtime normalizes by /4.

Trim rules to keep the asset <100 KB (mission law):
  * drop punctuation/emoji-only tokens (lyric lines rarely carry them and
    the word tokenizer never emits them)
  * drop weak tokens (|mean| < 0.3) — below LYRIC_MOOD.minHits gating
    they are noise; the valence shift only needs signal words
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "bake_data", "vader_lexicon.txt")
OUT = os.path.join(HERE, "..", "assets", "vader_lexicon.json")

MIN_ABS = 0.3
MAX_BYTES = 100_000


def main() -> int:
    if not os.path.exists(SRC):
        print(f"FATAL: {SRC} missing — download vader_lexicon.txt first", file=sys.stderr)
        return 1
    table = {}
    with open(SRC, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line:
                continue
            parts = line.split("\t")
            if len(parts) < 2:
                continue
            token, mean = parts[0], parts[1]
            try:
                m = float(mean)
            except ValueError:
                continue
            # Tokenizer contract: word tokens are letters/digits/apostrophes.
            # Anything else (punct, emoji) can never be hit — drop it.
            clean = "".join(ch for ch in token if ch.isalnum() or ch == "'")
            if not clean or not any(ch.isalpha() for ch in clean):
                continue
            if abs(m) < MIN_ABS:
                continue
            table[clean.lower()] = round(m, 3)

    payload = json.dumps(table, ensure_ascii=False, separators=(",", ":"))
    size = len(payload.encode("utf-8"))
    if size > MAX_BYTES:
        # progressive trim: raise the signal floor
        for floor in (0.5, 0.75, 1.0):
            trimmed = {k: v for k, v in table.items() if abs(v) >= floor}
            payload = json.dumps(trimmed, ensure_ascii=False, separators=(",", ":"))
            size = len(payload.encode("utf-8"))
            print(f"trim floor={floor}: {len(trimmed)} tokens, {size} bytes")
            if size <= MAX_BYTES:
                table = trimmed
                break
        else:
            print("FATAL: cannot fit under 100KB even at floor 1.0", file=sys.stderr)
            return 1

    with open(OUT, "w", encoding="utf-8") as f:
        f.write(payload)
    print(f"OK → {os.path.abspath(OUT)}: {len(table)} tokens, {size} bytes (< {MAX_BYTES})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
