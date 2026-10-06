#!/usr/bin/env python3
"""
GENIUS P5-asset — the curated romanized Hindi/Punjabi mood lexicon.

VADER is English-only; this file carries the romanized South-Asian mood
vocabulary the app's catalog lives on (pyaar, judai, naina, nach…). Each
word scores −1..+1 (positivity hint; negative = sad/heavy). The table IS
the reviewable source — edit words here, re-run, commit the asset.

Format out: assets/hindi_lexicon.json `{ "word": score }` (2 decimals,
sorted, compact). ~300 words ≈ 6 KB → combined with the 90 KB VADER
asset the lexicon total stays under the 100 KB law.

Both word forms are listed when romanization varies (pyaar/pyar is
handled by the app's Hinglish fold at lookup time — one canonical form
per word here; the fold does the rest).

Re-run any time:  python3 scripts/bake_hindi_lexicon.py
"""

import json

# ── THE REVIEWABLE SOURCE ───────────────────────────────────────────────
# Positivity hints on the −1..+1 scale. Curated by hand:
#   love/joy/party block, nature/beauty block (mild positive),
#   longing (mild negative), grief/betrayal block (strong negative),
#   anger/struggle block (negative), devotional block (calm positive).
WORDS: dict[str, float] = {
    # love & devotion
    "pyaar": 0.9, "pyar": 0.9, "ishq": 0.9, "mohabbat": 0.9, "prem": 0.8,
    "dilbar": 0.8, "sanam": 0.8, "jaanam": 0.8, "mahboob": 0.8, "habibi": 0.7,
    "junoon": 0.4, "dil": 0.4, "dharkan": 0.3, "swoon": 0.5, "nain": 0.4,
    "naina": 0.4, "ankhiyan": 0.4, "ada": 0.6, "nazaara": 0.6, "noor": 0.7,
    "chaand": 0.6, "chand": 0.6, "chandni": 0.6, "sitara": 0.5, "sitare": 0.5,
    "suraj": 0.5, "savitri": 0.3, "radha": 0.6, "krishna": 0.6, "shyam": 0.5,
    "kanha": 0.6, "gopal": 0.5, "govinda": 0.6, "gopi": 0.5, "bansuri": 0.4,
    # joy & celebration
    "khush": 0.9, "khushi": 0.9, "khushiyan": 0.9, "khushiyon": 0.9,
    "hasna": 0.7, "hansi": 0.8, "muskurahat": 0.8, "muskurana": 0.8,
    "jashn": 0.8, "jashn-e": 0.8, "mehfil": 0.6, "mehfils": 0.6,
    "nach": 0.8, "naach": 0.8, "nachna": 0.8, "dance": 0.8, "nachdi": 0.8,
    "party": 0.8, "shaava": 0.8, "shava": 0.7, "balle": 0.9, "balleballe": 0.9,
    "masti": 0.8, "maza": 0.8, "mazaa": 0.8, "josh": 0.9, "jigar": 0.5,
    "dum": 0.7, "dam": 0.6, "himmat": 0.6, "hausla": 0.6, "jeet": 0.9,
    "vijay": 0.8, "fateh": 0.8, "sher": 0.7, "sherni": 0.7, "raja": 0.6,
    "rani": 0.6, "maharaja": 0.6, "jalsa": 0.7, "tooh": 0.6, "chinti": 0.3,
    "gabru": 0.7, "mutiyaar": 0.7, "kudi": 0.6, "munda": 0.6, "soniye": 0.7,
    "soni": 0.7, "chhammak": 0.7, "chikni": 0.5, "rang": 0.4, "rangeela": 0.6,
    "holi": 0.7, "diwali": 0.7, "tyohaar": 0.7, "festival": 0.6,
    # nature & beauty (mild positive)
    "phool": 0.7, "phoolon": 0.7, "gulab": 0.6, "gulal": 0.6, "baagh": 0.5,
    "bahaar": 0.7, "bahaaron": 0.7, "sawan": 0.5, "saawan": 0.5, "baarish": 0.3,
    "barish": 0.3, "baadalon": 0.3, "hawa": 0.3, "lehar": 0.4, "dariya": 0.4,
    "samandar": 0.4, "pani": 0.2, "khet": 0.3, "khetan": 0.3, "pind": 0.4,
    "gaon": 0.4, "maati": 0.5, "mitti": 0.5, "sarson": 0.5, "motiya": 0.5,
    "mehndi": 0.5, "chudi": 0.4, "chudiyan": 0.5, "ghungroo": 0.5, "dupatta": 0.4,
    "pagdi": 0.4, "kajra": 0.4, "kajraare": 0.5, "bindiya": 0.4, "jhumka": 0.5,
    "sitaare": 0.5, "aasmaan": 0.4, "aasman": 0.4, "subah": 0.5, "savera": 0.6,
    "shaam": 0.2, "sandhya": 0.4, "sooraj": 0.5,
    # longing & separation (mild negative)
    "yaad": -0.2, "yaadein": -0.3, "yaadan": -0.3, "yaadon": -0.3,
    "intezaar": -0.3, "intezar": -0.3, "sapna": 0.2, "sapne": 0.2, "khwaab": 0.2,
    "khwab": 0.2, "aas": 0.2, "aasha": 0.4, "ummeed": 0.4, "umeed": 0.4,
    "arzu": 0.3, "khwaahish": 0.3, "chaahat": 0.4, "chaah": 0.3, "taraana": 0.4,
    "doori": -0.7, "dooriyan": -0.7, "firaq": -0.5, "virha": -0.7, "virah": -0.7,
    "adhoora": -0.6, "adhura": -0.6, "adhoori": -0.6, "bekaboo": -0.2,
    "naam": 0.1, "nishaani": 0.1, "nishaan": 0.1,
    # grief & betrayal (strong negative)
    "judai": -0.9, "vidai": -0.5, "bichhda": -0.8, "bichhadna": -0.8,
    "tanhai": -0.8, "tanha": -0.8, "akela": -0.6, "akelapan": -0.7,
    "dard": -0.9, "dukh": -0.9, "dukhon": -0.9, "gham": -0.9, "gham-e": -0.9,
    "aansu": -0.9, "aansoo": -0.9, "aankhon": -0.2, "rona": -0.8, "rote": -0.8,
    "bewafa": -0.9, "bewafai": -0.9, "dhoka": -0.9, "dhokha": -0.9,
    "daghabaazi": -0.8, "thagi": -0.8, "loot": -0.6, "lut": -0.5,
    "toota": -0.7, "toot": -0.7, "bikhra": -0.5, "bikhri": -0.5, "kacha": -0.2,
    "majboor": -0.6, "majboori": -0.7, "bezubaan": -0.4, "bekas": -0.6,
    "laachaar": -0.7, "barbaad": -0.9, "tabah": -0.9, "ujiada": -0.8,
    "udaasi": -0.8, "udas": -0.8, "ghut": -0.6, "ghutan": -0.7, "khamoshi": -0.4,
    "khamosh": -0.4, "andhera": -0.6, "andhere": -0.6, "sannata": -0.6,
    "virana": -0.7, "kabristan": -0.7, "mazaar": -0.3, "chita": -0.6,
    "shikwa": -0.5, "shikve": -0.5, "gila": -0.4, "fariyaad": -0.6,
    "dua": 0.4, "badua": -0.7, "saazish": -0.6, "zulm": -0.9, "zulmi": -0.8,
    "sitam": -0.8, "sitamgar": -0.8, "jaalim": -0.8, "zaalim": -0.8,
    "bechain": -0.6, "bechaini": -0.7, "ghabra": -0.6, "ghabrahat": -0.6,
    "pareshan": -0.6, "pareshaani": -0.6, "tension": -0.5, "fikr": -0.4,
    "chinta": -0.5, "bhay": -0.6, "darr": -0.6, "dar": -0.5, "khauf": -0.6,
    "aatank": -0.8, "hungaama": 0.1, "laash": -0.8, "maut": -0.9, "mrigtrishna": -0.6,
    # struggle & anger
    "ladai": -0.6, "larai": -0.6, "jung": -0.5, "yudh": -0.5, "danga": -0.6,
    "phasna": -0.5, "phansi": -0.7, "bandish": -0.5, "zanjir": -0.6,
    "kaala": -0.2, "kala": -0.2, "kothri": -0.4, "qaid": -0.6, "qaidi": -0.6,
    "gaddar": -0.9, "dagha": -0.8, "chughli": -0.5, "zeher": -0.9, "zeherili": -0.8,
    "khoon": -0.5, "khanjar": -0.6, "talwar": -0.4, "bandook": -0.5, "goli": -0.5,
    # devotional & calm positive
    "bhakti": 0.7, "bhajan": 0.6, "kirtan": 0.6, "aarti": 0.6, "puja": 0.6,
    "pooja": 0.6, "mandir": 0.5, "gurdwara": 0.5, "gurudwara": 0.5,
    "raghav": 0.5, "ram": 0.6, "sita": 0.5, "hanuman": 0.6, "shiva": 0.6,
    "shankar": 0.5, "mahadev": 0.6, "ganesha": 0.6, "ganpati": 0.6,
    "allah": 0.5, "rab": 0.6, "rabb": 0.6, "khuda": 0.5, "maula": 0.5,
    "maulaa": 0.5, "peer": 0.4, "fakir": 0.3, "sufi": 0.4, "qawwali": 0.5,
    "sach": 0.4, "sachi": 0.5, "satya": 0.5, "premika": 0.5, "shanti": 0.7,
    "sukoon": 0.8, "aaram": 0.5, "chain": 0.5, "neend": 0.3, "khwaabon": 0.2,
    # misc frequent words
    "billo": 0.6, "ni": 0.1, "ve": 0.1, "o": 0.0, "hai": 0.0, "hoya": 0.0,
    "challa": 0.3, "ki": 0.0, "kithhe": 0.1, "ranjha": 0.3, "heer": 0.3,
    "sassi": 0.3, "punnu": 0.3, "sohni": 0.5, "mahival": 0.3, "jugni": 0.5,
    "charkha": 0.2, "ghar": 0.4, "maaye": 0.5, "mata": 0.5, "pita": 0.5,
    "bhai": 0.5, "yaar": 0.6, "dost": 0.6, "dosti": 0.8, "bairi": -0.5,
    "begani": -0.4, "paraya": -0.4, "apna": 0.4, "apnaa": 0.4, "ghareeb": -0.3,
    "amir": 0.3, "paisa": 0.2, "daulat": 0.2, "shohrat": 0.3, "izzat": 0.5,
    "badnami": -0.6, "rusvai": -0.6, "rusvaa": -0.6, "kalank": -0.7, "abhimaan": 0.0,
}


def main() -> int:
    lex = {k.strip(): round(float(v), 2) for k, v in WORDS.items() if k.strip()}
    data = json.dumps(lex, separators=(",", ":"), sort_keys=True, ensure_ascii=False).encode("utf-8")
    with open("assets/hindi_lexicon.json", "wb") as f:
        f.write(data)
    print(f"OK wrote assets/hindi_lexicon.json: {len(lex)} words, {len(data)} bytes")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
