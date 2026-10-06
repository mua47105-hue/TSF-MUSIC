#!/usr/bin/env python3
"""
GENIUS P2 — THE BAKED KNOWLEDGE TABLE (one-time bake).

Reads a Spotify audio-features CSV (HuggingFace mirror of the Kaggle
"Spotify Tracks Dataset" — already downloaded to scripts/data/), bakes the
(energy, valence, danceability) of every usable row into a compact static
JSON the app ships in assets/.

House rules honored here:
  * Keys are baked with the repo's OWN recording identity — an exact port
    of src/api/recording.ts (normTitle / normSeg / primaryArtistOf /
    recordingKey / titleKeyOf) plus src/search/normalize.ts clusterKey for
    the third lookup key. NO invented normalization.
  * Features quantized to 2 decimals; version + bake date stamped in _meta.
  * Hard 2.5 MB gzip ceiling — the script FAILS LOUDLY (exit 1) over it,
    trimming the least-relevant rows (Indian-language genres + global
    popularity are kept preferentially, per the mission priority).
  * Deterministic output: sorted keys, stable tiebreaks — same CSV in,
    byte-identical file out.

Re-bake (documented in docs/GENIUS-NOTE.md):
    curl -L -o scripts/data/spotify_tracks.csv \\
      "https://huggingface.co/datasets/maharshipandya/spotify-tracks-dataset/resolve/main/dataset.csv"
    python3 scripts/bake_features.py [path/to/local.csv]
"""

import csv
import gzip
import json
import re
import sys
import unicodedata
from datetime import datetime, timezone

DEFAULT_CSV = "scripts/data/spotify_tracks.csv"
DEFAULT_PARQUET = "scripts/data/spotify_2p3m.parquet"
OUT_PATH = "assets/baked_features.json"
GZIP_CEILING = 2_621_440  # 2.5 MB — mission law
TARGET_ROWS_CAP = 200_000  # mission law (cap never bites today)
SUPPLEMENT_CAP = 6000      # spine rows taken from the popularity-less 2.3M set

# ── India-market spine for the supplement source ────────────────────────
# The 2.3M-row dataset carries NO popularity column, so relevance is
# decided by THIS hand-curated, reviewable list (baked-data curation, not
# a runtime tuning number). Order = prominence: when the gzip ceiling
# forces a trim, the tail of this list goes first.
INDIA_SPINE = [
    # film playback core
    "arijit singh", "shreya ghoshal", "atif aslam", "pritam", "ar rahman",
    "a r rahman", "vishal-shekhar", "sonu nigam", "kishore kumar",
    "mohammed rafi", "lata mangeshkar", "asha bhosle", "kumar sanu",
    "udit narayan", "alka yagnik", "rahat fateh ali khan", "shankar mahadevan",
    "mithoon", "ankit tiwari", "jubin nautiyal", "papon", "benny dayal",
    "mohit chauhan", "kk", "neeti mohan", "amit trivedi", "sachet-tandon",
    "sachet-parampara", "vishal mishra", "tanishk bagchi", "badshah",
    "yo yo honey singh", "neha kakkar", "tony kakkar", "dhvani bhanushali",
    "darshan raval", "armaan malik", "shalmali kholgade", "kanika kapoor",
    "sunidhi chauhan", "shaan", "kk", "jasleen royal",
    "anuv jain", "king", "mitraz", "kaifi khalil", "aditya rikhari",
    "varun jain", "sachin-jigar", "anirudh ravichander", "sid sriram",
    # punjabi / desi hip-hop
    "diljit dosanjh", "ap dhillon", "karan aujla", "sidhu moose wala",
    "guru randhawa", "shubh", "ammy virk", "b praak", "jaani", "harrdy sandhu",
    "jass manak", "gippy grewal", "divine", "seedhe maut", "krsna",
    # south
    "dhanush", "anirudh", "hesham abdul wahab", "gv prakash",
    "yuvan shankar raja", "harris jayaraj", "sunidhi",
    # ghazal / sufi / classical
    "nusrat fateh ali khan", "arijit", "javed ali", "hariharan", "shweta mohan",
    "kavita seth", "swanand kirkire", "rekha bhardwaj", "shilpa rao",
    "asees kaur", "dhvani", "yohani", "sanam puri", "sachet",
]

# ── EXACT PORT of src/api/recording.ts ─────────────────────────────────
# Attribution noise: movie/show credits + featured-artist credits. Version
# words (Lofi/Remix/Live/…) are NOT noise — they stay (different recordings).

ATTRIBUTION_NOISE = re.compile(
    r"\s*[\[(]\s*(?:from\s+[\"'][^)\"']{0,60}[\"']|feat\.?\s|ft\.?\s|with\s"
    r"|original motion picture[^)\]]{0,40}|ost\s)[^)\]]*[)\]]",
    re.IGNORECASE,
)


def norm_title(s: str) -> str:
    s = ATTRIBUTION_NOISE.sub(" ", s or "")
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not 0x0300 <= ord(ch) <= 0x036F)
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", "", s)
    return s[:80]


def norm_seg(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(ch for ch in s if not 0x0300 <= ord(ch) <= 0x036F)
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", "", s)
    return s[:80]


def primary_artist_of(artists: str) -> str:
    # JS: src.split(/,|&|\bfeat\.?\b|\bft\.?\b/i)[0].trim()
    parts = re.split(r",|&|\bfeat\.?\b|\bft\.?\b", artists or "", flags=re.IGNORECASE)
    return (parts[0] if parts else "").strip()


def recording_key(title: str, artist: str) -> str:
    t = norm_title(title)
    a = norm_seg(primary_artist_of(artist))
    if not t:
        return ""  # anon rows are NOT baked — identity-less keys could
        # collide across different songs by the same artist; runtime anon
        # rows simply fall through to priors (honest miss).
    return f"{t}|{a}"


def dataset_primary_artist(artists: str) -> str:
    """This CSV lists multi-artists Spotify-style, ';'-separated
    ('Neeraj Shridhar;Kavita Seth') — while the app's credit strings use
    ',' / '&'. Split the dataset's own separator FIRST, then apply the
    app's primaryArtistOf rules unchanged (no invented normalization)."""
    return (artists or "").split(";")[0]


def parse_parquet_artist(raw) -> str:
    """The 2.3M parquet stores artists as Python-list reprs
    ("['A', 'B']") or ';'-joined strings. Normalize BOTH to the plain
    credit-string shape, then the app's primaryArtistOf rules apply."""
    s = str(raw or "").strip()
    if s.startswith("["):
        s = s.lstrip("[").rstrip("]").replace("'", "").replace('"', "")
        s = s.split(",")[0]
    return s.split(";")[0].strip()


def title_key(title: str) -> str:
    return norm_title(title)


# ── EXACT PORT of src/search/normalize.ts clusterKey (+normalizeQuery) ──

HINGLISH_FOLDS = {
    "hai": "hai", "hain": "hai", "hein": "hai",
    "hoon": "hu", "hun": "hu",
    "nahi": "nahi", "naheen": "nahi", "nahin": "nahi", "nai": "nahi",
    "kyun": "kyu", "kion": "kyu", "kyon": "kyu", "kiun": "kyu",
    "tum": "tum", "thum": "tum", "tho": "tum",
    "faya": "faya", "faaya": "faya",
    "pyar": "pyaar",
    "songs": "song", "gaane": "gaana", "gane": "gaana",
}


def _fold_diacritics(s: str) -> str:
    s = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in s if not 0x0300 <= ord(ch) <= 0x036F)
    return unicodedata.normalize("NFC", s)


def normalize_query(raw: str) -> str:
    s = unicodedata.normalize("NFC", raw or "").lower()
    s = _fold_diacritics(s)
    s = re.sub(r"[.,/\\|!?;:()\[\]{}<>\"\u201c\u201d\u2018\u2019\u2026\u2014\u2013_*#@$%^+=~`]", " ", s)
    s = re.sub(r"(['-])\s+", " ", s)
    s = re.sub(r"\s+(['-])", " ", s)
    s = re.sub(r"(['-]){2,}", r"\1", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def cluster_key(title: str) -> str:
    t = unicodedata.normalize("NFC", title or "").lower()
    t = re.sub(r"\(from[^)]*\)", " ", t)
    t = re.sub(
        r"\([^)]*(version|remix|cover|reprise|unplugged|mix|edit|live|acoustic"
        r"|instrumental|motion picture|film|movie)[^)]*\)",
        " ",
        t,
    )
    t = re.sub(r"\bfeat\b\.?\s.*$", " ", t)
    t = re.sub(r"\bft\b\.?\s.*$", " ", t)
    t = re.sub(
        r"\b(remix|cover|reprise|unplugged|acoustic|instrumental|karaoke|version|mix|edit|live)\b",
        " ",
        t,
    )
    t = re.sub(r"\s*-\s*(cover|remix|live|acoustic)\b.*$", " ", t)
    return normalize_query(t)


# ── Bake ────────────────────────────────────────────────────────────────

# The dataset's own genre column — Indian-market priorities per the mission.
INDIAN_GENRES = {
    "bollywood", "hindi", "punjabi", "tamil", "telugu", "malayalam", "kannada",
    "bhojpuri", "marathi", "bengali", "indian classical", "sufi", "ghazal",
}


def q2(x) -> float:
    return round(float(x), 2)


def load_rows(path: str):
    rows = {}
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for r in reader:
            try:
                title = (r.get("track_name") or "").strip()
                artists = (r.get("artists") or "").strip()
                popularity = int(float(r.get("popularity") or 0))
                energy = float(r.get("energy") or 0)
                valence = float(r.get("valence") or 0)
                dance = float(r.get("danceability") or 0)
            except (TypeError, ValueError):
                continue
            if not title or not artists:
                continue
            if popularity <= 0 and not (0 < energy < 1):  # no identity AND no signal
                continue
            rk = recording_key(title, dataset_primary_artist(artists))
            if not rk:
                continue  # anon / Devanagari-title rows: no stable identity
            genre = (r.get("track_genre") or "").strip().lower()
            # Same recording re-listed across genre queries (and remasters):
            # keep the highest-popularity row; popularity ties keep the
            # FIRST CSV occurrence (deterministic — the file is stable).
            cand = {
                "key": rk,
                "title": title,
                "artists": artists,
                "popularity": popularity,
                "genre": genre,
                "rank": 0 if genre in INDIAN_GENRES else 2,
                "feat": {"e": q2(energy), "v": q2(valence), "d": q2(dance)},
            }
            cur = rows.get(rk)
            if cur is None or popularity > cur["popularity"]:
                rows[rk] = cand
    return list(rows.values())


def load_supplement(path: str, cap: int):
    """Spine-filtered rows from the popularity-less 2.3M parquet. Deterministic
    order: spine prominence (list order), then title. Popularity 0 — the
    popularity-bearing source always wins a key collision."""
    try:
        import pandas as pd
    except ImportError:
        print("supplement: pandas unavailable — skipping (backbone only)")
        return []
    try:
        df = pd.read_parquet(path, columns=["track_name", "artists", "energy", "valence", "danceability"])
    except Exception as e:  # noqa: BLE001 — supplement is optional
        print(f"supplement: parquet unreadable ({e}) — skipping")
        return []
    spine = {name.lower(): i for i, name in enumerate(INDIA_SPINE)}
    seen = set()
    pool = []
    for name, artists, energy, valence, dance in df.itertuples(index=False):
        primary = parse_parquet_artist(artists).lower()
        spine_idx = spine.get(primary)
        if spine_idx is None:
            continue
        title = str(name or "").strip()
        if not title:
            continue
        rk = recording_key(title, parse_parquet_artist(artists))
        if not rk or rk in seen:
            continue
        seen.add(rk)
        pool.append({
            "key": rk,
            "title": title,
            "artists": str(artists),
            "popularity": 0,
            "genre": "",
            "rank": 1,
            "spineIdx": spine_idx,
            "feat": {"e": q2(energy), "v": q2(valence), "d": q2(dance)},
        })
    # Scan order mirrors the source file (artist-clustered), so the CAP is
    # applied only AFTER a prominence sort — otherwise one prolific artist
    # eats the whole budget (found by the parity probe: 5899 rows all
    # Arijit-class, zero Vishal-Shekhar/King rows made it in).
    pool.sort(key=lambda r: (r["spineIdx"], norm_title(r["title"])))
    return pool[:cap]


def build_tables(rows):
    """Flat key → feature map, exactly the runtime lookup chain:
    recordingKey → bare titleKey → cluster-folded titleKey."""
    table = {}

    def put(key, feat, pop):
        if not key:
            return
        cur = table.get(key)
        if cur is None or pop > cur[0]:
            table[key] = (pop, feat)

    for row in rows:
        feat, pop = row["feat"], row["popularity"]
        put(row["key"], feat, pop)                                    # r: title|artist
        put(title_key(row["title"]), feat, pop)                       # t: bare title
        ck = norm_title(cluster_key(row["title"]))                    # c: cluster-folded
        if ck != title_key(row["title"]):
            put(ck, feat, pop)
    return {k: v[1] for k, v in table.items()}


def emit(rows) -> bytes:
    table = build_tables(rows)
    doc = {
        "_meta": {
            "version": 1,
            "bakedAt": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "source": "maharshipandya/spotify-tracks-dataset (HuggingFace mirror of the Kaggle Spotify Tracks Dataset)",
            "rows": len(rows),
            "keys": len(table),
            "quantization": "features rounded to 2 decimals",
            "keyLogic": "exact port of src/api/recording.ts recordingKey/titleKeyOf + src/search/normalize.ts clusterKey",
        },
        "k": dict(sorted(table.items())),
    }
    return json.dumps(doc, separators=(",", ":"), sort_keys=True, ensure_ascii=False).encode("utf-8")


def main() -> int:
    csv_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_CSV
    try:
        rows = load_rows(csv_path)
    except FileNotFoundError:
        print(f"BAKE FAIL: CSV not found at {csv_path}", file=sys.stderr)
        print("Download it first (see docs/GENIUS-NOTE.md) or pass a local path:", file=sys.stderr)
        print("  python3 scripts/bake_features.py /path/to/spotify_tracks.csv", file=sys.stderr)
        return 1
    if not rows:
        print("BAKE FAIL: no usable rows in the CSV", file=sys.stderr)
        return 1

    # Supplement (optional): spine-filtered regional depth from the 2.3M set.
    supp = load_supplement(DEFAULT_PARQUET, SUPPLEMENT_CAP)
    print(f"supplement: {len(supp)} spine rows loaded")
    rows = rows + supp

    # Trim priority: rank order (Indian backbone → spine supplement →
    # global popularity) — only applied if the ceiling forces a trim.
    rows.sort(key=lambda r: (
        r["rank"],
        -(r["spineIdx"] if r["rank"] == 1 else 0),
        -r["popularity"],
        r["key"],
    ))
    rows = rows[:TARGET_ROWS_CAP]

    factor = 1.0
    while True:
        keep = rows[: max(1000, int(len(rows) * factor))]
        data = emit(keep)
        gz = gzip.compress(data)
        print(f"bake: {len(keep)} rows | raw {len(data)/1e6:.2f} MB | gzip {len(gz)/1e6:.2f} MB")
        if len(gz) <= GZIP_CEILING:
            break
        factor -= 0.1
        if factor < 0.2:
            print("BAKE FAIL: cannot fit the 2.5 MB gzip ceiling even at 20% rows", file=sys.stderr)
            return 1

    with open(OUT_PATH, "wb") as f:
        f.write(data)
    keys = len(json.loads(data.decode("utf-8"))["k"])
    print(f"OK wrote {OUT_PATH}: {len(keep)} recordings, {keys} lookup keys, gzip {len(gz)/1e6:.2f} MB (ceiling 2.5 MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
