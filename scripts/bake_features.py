#!/usr/bin/env python3
"""
BAKE THE FEATURE TABLE (Phase 2 — "the biggest single intelligence jump").

Reads the HuggingFace spotify-tracks-dataset CSV, keeps the most popular
rows, and emits assets/baked_features.json — a compact knowledge table of
{energy, valence, danceability} keyed EXACTLY like the runtime looks them
up.

THE CONTRACT:
  * The normalize/cluster functions below are a VERBATIM port of
    src/search/normalize.ts (normalizeQuery + clusterKey). Character for
    character — including the JS quirk that ONLY combining marks
    U+0300-U+036f are folded (Devanagari signs pass through untouched)
    and that '|' is stripped INSIDE normalization but ADDED AFTER as the
    recordingKey separator.
  * Keys: recordingKey ("title|primaryArtist"), bare titleKey (only for
    UNAMBIGUOUS titles), clusterKey (decoration-stripped title, same
    unambiguity rule).
  * Features quantized to 2 decimals. Popularity-sorted, first (hottest)
    row wins per key.
  * Size law: the gzipped asset must stay <= 2.5 MB (DATASET.maxGzipBytes).
    The script retries with a smaller popularity tail and FAILS LOUDLY
    if even the floor cannot fit.
"""

import csv
import gzip
import json
import os
import re
import sys
import unicodedata
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
CSV_PATH = os.path.join(HERE, "bake_data", "dataset.csv")
OUT_PATH = os.path.join(HERE, "..", "assets", "baked_features.json")

BAKE_VERSION = "1.0.0"
MAX_ROWS = 200_000
MIN_ROWS_FLOOR = 30_000          # below this the table is not worth shipping
MAX_GZIP_BYTES = 2_621_440       # 2.5 MB hard ceiling
STEP_FRACTION = 0.8              # tail-cut step when over the ceiling

# ── VERBATIM port of src/search/normalize.ts ────────────────────────────

# JS: s.replace(/[.,/\\|!?;:()\[\]{}<>"“”‘’…—–_*#@$%^+=~`]/g, ' ')
_PUNCT = re.compile(r'[.,/\\|!?;:()\[\]{}<>"\u201c\u201d\u2018\u2019\u2026\u2014\u2013_*#@$%^+=~`]')


def normalize_query(raw) -> str:
    s = str(raw or "")
    # 1. NFC + lowercase
    s = unicodedata.normalize("NFC", s).lower()
    # 2. Diacritic fold — JS strips ONLY [\u0300-\u036f] after NFD.
    #    (unicodedata.combining() would ALSO fold Devanagari signs — a
    #    drift bug; replicate the JS range exactly.)
    s = "".join(c for c in unicodedata.normalize("NFD", s) if not ("\u0300" <= c <= "\u036f"))
    s = unicodedata.normalize("NFC", s)
    # 3. Strip punctuation EXCEPT apostrophes/hyphens inside words
    s = _PUNCT.sub(" ", s)
    s = re.sub(r"(['-])\s+", " ", s)
    s = re.sub(r"\s+(['-])", " ", s)
    s = re.sub(r"(['-]){2,}", r"\1", s)
    # 4. Collapse whitespace
    s = re.sub(r"\s+", " ", s).strip()
    return s


_CLUSTER_PARENS = re.compile(
    r"\([^)]*(version|remix|cover|reprise|unplugged|mix|edit|live|acoustic"
    r"|instrumental|motion picture|film|movie)[^)]*\)"
)
_CLUSTER_FEAT = re.compile(r"\bfeat\b\.?\s.*$")
_CLUSTER_FT = re.compile(r"\bft\b\.?\s.*$")
_CLUSTER_WORDS = re.compile(
    r"\b(remix|cover|reprise|unplugged|acoustic|instrumental|karaoke|version|mix|edit|live)\b"
)
_CLUSTER_DASH = re.compile(r"\s*-\s*(cover|remix|live|acoustic)\b.*$")


def cluster_key(title) -> str:
    t = unicodedata.normalize("NFC", str(title or "")).lower()
    t = re.sub(r"\(from[^)]*\)", " ", t)
    t = _CLUSTER_PARENS.sub(" ", t)
    t = _CLUSTER_FEAT.sub(" ", t)
    t = _CLUSTER_FT.sub(" ", t)
    t = _CLUSTER_WORDS.sub(" ", t)
    t = _CLUSTER_DASH.sub(" ", t)
    return normalize_query(t)


# ── Baking ───────────────────────────────────────────────────────────────

def r2(x: float) -> float:
    return round(float(x) + 0.0, 2)


def bake_clean(limit: int) -> dict:
    """The real implementation (bake() above was the sketch; this is used)."""
    rows = []
    with open(CSV_PATH, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                pop = int(row.get("popularity") or 0)
                energy = float(row.get("energy") or 0.0)
                valence = float(row.get("valence") or 0.0)
                dance = float(row.get("danceability") or 0.0)
            except ValueError:
                continue
            title = (row.get("track_name") or "").strip()
            artists_raw = (row.get("artists") or "").strip()
            if not title or not artists_raw:
                continue
            primary = artists_raw.split(",")[0].strip()
            if not primary:
                continue
            rows.append((pop, title, primary, r2(energy), r2(valence), r2(dance)))

    rows.sort(key=lambda r: (-r[0], r[1], r[2]))
    rows = rows[: min(limit, MAX_ROWS)]

    table = {}
    title_feats = {}
    cluster_feats = {}

    for pop, title, primary, e, v, d in rows:
        n_title = normalize_query(title)
        n_artist = normalize_query(primary)
        if not n_title or not n_artist:
            continue
        rec = f"{n_title}|{n_artist}"
        if rec not in table:
            table[rec] = {"e": e, "v": v, "d": d}
        title_feats.setdefault(n_title, set()).add((e, v, d))
        ck = cluster_key(title)
        if ck:
            cluster_feats.setdefault(ck, set()).add((e, v, d))

    # Bare titleKey only when EVERY row sharing that title agrees on the
    # features (unambiguous) — a collision means two different recordings
    # and a bare key would lie.
    for n_title, feats in title_feats.items():
        if len(feats) == 1 and n_title not in table:
            e, v, d = next(iter(feats))
            table[n_title] = {"e": e, "v": v, "d": d}
    for ck, feats in cluster_feats.items():
        if len(feats) == 1 and ck not in table:
            e, v, d = next(iter(feats))
            table[ck] = {"e": e, "v": v, "d": d}

    return table


def main() -> int:
    if not os.path.exists(CSV_PATH):
        print(f"FATAL: dataset CSV not found at {CSV_PATH}", file=sys.stderr)
        print("Download it first:", file=sys.stderr)
        print("  curl -L -o scripts/bake_data/dataset.csv "
              "'https://huggingface.co/datasets/maharshipandya/spotify-tracks-dataset/resolve/main/dataset.csv'",
              file=sys.stderr)
        return 1

    limit = MAX_ROWS
    while limit >= MIN_ROWS_FLOOR:
        table = bake_clean(limit)
        table["__meta"] = {
            "version": BAKE_VERSION,
            "bakedAt": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "rows": len(table) - 1,
            "source": "huggingface:maharshipandya/spotify-tracks-dataset",
        }
        payload = json.dumps(table, ensure_ascii=False, separators=(",", ":"))
        gz = gzip.compress(payload.encode("utf-8"), 9)
        size = len(gz)
        print(f"bake(limit={limit:>7}): {len(table)-1:>7} keys, "
              f"raw={len(payload)/1e6:.1f}MB, gzip={size/1e6:.2f}MB")
        if size <= MAX_GZIP_BYTES:
            os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
            with open(OUT_PATH, "w", encoding="utf-8") as f:
                f.write(payload)
            print(f"OK → {os.path.abspath(OUT_PATH)} "
                  f"({size/1e6:.2f}MB gzipped, cap {MAX_GZIP_BYTES/1e6:.1f}MB)")
            print(f"version={BAKE_VERSION} bakedAt={table['__meta']['bakedAt']}")
            return 0
        limit = int(limit * STEP_FRACTION)

    print(f"FATAL: even {MIN_ROWS_FLOOR} rows exceed the {MAX_GZIP_BYTES/1e6:.1f}MB "
          f"gzip ceiling — the table shape needs a redesign, not a smaller cut.",
          file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
