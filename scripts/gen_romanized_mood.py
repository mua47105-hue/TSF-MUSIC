#!/usr/bin/env python3
"""
Generate the romanized Hindi/Punjabi mood lexicon (Phase 5).

Emits src/ai/core/romanizedMood.ts — a GENERATED, reviewable source file
(the dictionary below IS the audit artifact; every word carries its
valence score in −1..+1). Hand-curated for romanized film/pop lyrics:
love, longing, heartbreak, celebration, devotion.

Scores follow the same polarity axis as VADER (negative = sad/dark,
positive = joyful/bright) but live in −1..+1 directly. Variants fold at
runtime by prefix token match — only base forms live here.
"""

import os
import sys

# word → (score, gloss)  — gloss keeps the file reviewable
WORDS = {
    # ── love / affection (strong positive) ────────────────────────────
    "pyaar": (0.9, "love"), "pyar": (0.9, "love (alt spelling)"),
    "pyaar mein": (0.9, None), "ishq": (0.85, "passionate love"),
    "mohabbat": (0.85, "love"), "prem": (0.8, "love"),
    "dilbar": (0.8, "beloved"), "jaan": (0.75, "life/beloved"),
    "sanam": (0.75, "beloved"), "habibi": (0.8, "my love"),
    "mahboob": (0.75, "beloved"), "mehbooba": (0.75, "beloved (f)"),
    "sajan": (0.7, "beloved"), "saajan": (0.7, "beloved (alt)"),
    "piya": (0.7, "beloved"), "priya": (0.7, "beloved"),
    "dilruba": (0.75, "heart-stealer"), "dildar": (0.75, "dear one"),
    "chand": (0.5, "moon (beauty)"), "chanda": (0.5, "moon (endearment)"),
    "khoobsurat": (0.7, "beautiful"), "haseen": (0.65, "beautiful"),
    "sundar": (0.6, "beautiful"), "soniye": (0.75, "beautiful one"),
    "soniye ni": (0.75, None), "ni soniye": (0.75, None),
    "mahive": (0.7, "beloved (punjabi)"), "mahiya": (0.75, "beloved (punjabi)"),
    "ve mahi": (0.7, None), "cham cham": (0.7, "sparkle"),
    "bawra": (0.4, "smitten"), "deewana": (0.5, "crazy in love"),
    "diwana": (0.5, "crazy in love (alt)"),
    # ── joy / celebration ──────────────────────────────────────────────
    "khush": (0.8, "happy"), "khushi": (0.85, "joy"),
    "khusi": (0.85, "joy (alt)"), "hasna": (0.7, "to laugh"),
    "hanju nahi": (0.2, None), "muskurahat": (0.75, "smile"),
    "muskane": (0.7, "smile"), "muskan": (0.7, "smile"),
    "jashn": (0.8, "celebration"), "mela": (0.6, "festival"),
    "nach": (0.7, "dance"), "nachna": (0.7, "to dance"),
    "balle balle": (0.95, "punjabi exultation"), "balle": (0.85, "exultation"),
    "oye hoye": (0.8, "delight"), "goriye": (0.7, "fair one"),
    "chham chham": (0.65, "anklets jingling"), "mast": (0.7, "carefree joy"),
    "masti": (0.8, "fun"), "rang": (0.5, "color/festivity"),
    "sajan ghar aana": (0.7, None), "shaava": (0.85, "punjabi cheer"),
    "ni mainu": (0.0, None), "yaar": (0.4, "friend/beloved"),
    "dost": (0.5, "friend"), "yaari": (0.6, "friendship"),
    "dosti": (0.65, "friendship"),
    # ── longing / tenderness (mild) ────────────────────────────────────
    "intezaar": (-0.2, "waiting"), "intezar": (-0.2, "waiting (alt)"),
    " yaad": (-0.1, "memory/missing"), "yaad": (-0.1, "missing"),
    "yaadan": (-0.3, "memories (punjabi)"), "tanha": (-0.6, "alone"),
    "tanhai": (-0.65, "loneliness"), "tanhaiyan": (-0.7, "loneliness (pl)"),
    "judai": (-0.8, "separation"), "bichhad": (-0.7, "parting"),
    "bichhda": (-0.75, "separated"), "virha": (-0.7, "separation pangs"),
    "virani": (-0.6, "desolate"), "fer": (0.0, None),
    "milan": (0.6, "union"), "mulaqat": (0.4, "meeting"),
    "dharkan": (0.1, "heartbeat"), "dhadkan": (0.1, "heartbeat"),
    "sapna": (0.35, "dream"), "sapne": (0.35, "dreams"),
    "khwab": (0.3, "dream"), "khwaab": (0.3, "dream (alt)"),
    "aankhein": (0.0, "eyes"), "aansu": (-0.7, "tears"),
    "aansoo": (-0.7, "tears (alt)"), "ansoo": (-0.7, "tears (alt)"),
    "tham": (-0.2, "halt/still"), "raat": (-0.2, "night (longing)"),
    "chandni": (0.3, "moonlight"), "savera": (0.5, "dawn/hope"),
    "subah": (0.4, "morning/hope"), "aasha": (0.6, "hope"),
    "umeed": (0.6, "hope"), "dua": (0.55, "prayer/blessing"),
    # ── heartbreak / pain (strong negative) ───────────────────────────
    "dard": (-0.8, "pain"), "peer": (-0.7, "ache (punjabi)"),
    "gham": (-0.8, "sorrow"), "gam": (-0.8, "sorrow (alt)"),
    "dukh": (-0.8, "pain/sorrow"), "sukoon": (0.5, "peace/relief"),
    "chot": (-0.7, "wound"), "zakham": (-0.75, "wound"),
    "zakhmi": (-0.75, "wounded"), "bewafa": (-0.9, "faithless lover"),
    "bewafai": (-0.9, "betrayal"), "dhoka": (-0.85, "betrayal"),
    "dhokha": (-0.85, "betrayal (alt)"), "farebi": (-0.7, "deceiver"),
    "judaiyan": (-0.85, "separations"), "akela": (-0.65, "alone"),
    "akela hai": (-0.6, None), "roothna": (-0.4, "sulking"),
    "roya": (-0.6, "cried"), "rona": (-0.6, "to cry"),
    "rote": (-0.6, "crying"), "khwahish": (0.2, "desire"),
    "tute": (-0.6, "broken"), "toota": (-0.65, "broken"),
    "tuta dil": (-0.8, None), "bikhre": (-0.6, "scattered/shattered"),
    "adhoora": (-0.7, "incomplete"), "adhura": (-0.7, "incomplete (alt)"),
    "tanhaai": (-0.65, "loneliness"), "veerana": (-0.7, "wilderness/desolation"),
    "barbaad": (-0.8, "ruined"), "tabah": (-0.8, "destroyed"),
    "pagal": (-0.3, "mad (love-pain)"), "deewangi": (0.2, "infatuation"),
    "nafrat": (-0.85, "hatred"), "dushman": (-0.7, "enemy"),
    "zindagi": (0.1, "life"), "maut": (-0.8, "death"),
    "maut ka": (-0.8, None), "khatam": (-0.5, "ended"),
    "anjaam": (-0.4, "outcome/consequence"), "aarzu": (0.2, "wish"),
    "arzoo": (0.2, "wish"), "hasrat": (-0.3, "unfulfilled longing"),
    "tamanna": (0.3, "desire"), "tamananna": (0.3, None),
    "bepanah": (0.3, "boundless (love)"), "befikre": (0.6, "carefree"),
    "guzarishein": (-0.3, "pleadings"), "guzaari": (-0.2, "passed (time)"),
    "bewajah": (-0.3, "without reason"), "bechain": (-0.6, "restless"),
    "bekarar": (-0.5, "restless"), "betaab": (-0.3, "yearning"),
    "tadap": (-0.65, "anguish"), "tadap": (-0.65, "anguish (alt)"),
    "aatma": (0.1, "soul"), "rooh": (0.1, "soul"),
    "sukun": (0.5, "peace (alt)"), "khamoshi": (-0.5, "silence"),
    "khamosh": (-0.45, "silent"), "sannata": (-0.55, "silence/void"),
    "andhera": (-0.6, "darkness"), "ujala": (0.6, "light"),
    "roshni": (0.6, "light"), "noor": (0.6, "divine light"),
    "sitare": (0.4, "stars"), "taare": (0.3, "stars (alt)"),
    "aasmaan": (0.3, "sky"), "aasman": (0.3, "sky (alt)"),
    "zameen": (0.1, "earth"), "saawan": (0.45, "monsoon (romance)"),
    "sawan": (0.45, "monsoon (alt)"), "baadal": (0.2, "clouds"),
    "baarish": (0.35, "rain"), "barish": (0.35, "rain (alt)"),
    "bheega": (0.2, "drenched"), "thandi": (0.1, "cool"),
    "hawa": (0.2, "breeze"), "ghata": (0.15, "cloud"),
    # ── devotion / spiritual (positive-calm) ──────────────────────────
    "rab": (0.6, "god (punjabi)"), "rabba": (0.6, "o god"),
    "khuda": (0.55, "god"), "bhagwan": (0.55, "god"),
    "ishwar": (0.55, "god"), "allah": (0.55, "god"),
    "maula": (0.5, "protector"), "saiyaan": (0.6, "beloved/divine"),
    "saiyan": (0.6, "beloved (alt)"), "har": (0.3, "god (punjabi)"),
    "gopal": (0.5, "divine name"), "kanha": (0.5, "divine name"),
    "bhakti": (0.6, "devotion"), "puja": (0.5, "worship"),
    "prarthana": (0.5, "prayer"), "aaradhna": (0.55, "devotion"),
    "satsang": (0.5, "spiritual gathering"), "manzil": (0.35, "destination"),
    "raah": (0.2, "path"), "rasta": (0.2, "road"),
    "safar": (0.25, "journey"), "musafir": (0.2, "traveler"),
    # ── energy / dance-floor (upbeat punjabi) ─────────────────────────
    "gori": (0.55, "fair one"), "chitti": (0.3, "white/fair"),
    "kala": (0.2, "black (style)"), "jatta": (0.5, "punjabi pride"),
    "jatt": (0.5, "punjabi identity"), "desi": (0.55, "homeland pride"),
    "swag": (0.6, "style"), "chhora": (0.5, "young man (punjabi)"),
    "chhori": (0.55, "young woman"), "mutiyaar": (0.6, "young woman (punjabi)"),
    "pind": (0.45, "village (nostalgia+)"), "shehar": (0.1, "city"),
    "gaadi": (0.45, "car (flex)"), "koka": (0.45, "nose-pin (flirt)"),
    "jhumka": (0.45, "earring (flirt)"), "chashmish": (0.3, None),
    "suit": (0.4, "punjabi suit (pride)"), "patiala": (0.5, "patiala pride"),
    "chandigarh": (0.45, None), "amritsar": (0.45, None),
    "billo": (0.55, "flirt address"), "ni billo": (0.55, None),
    "gabru": (0.55, "young stud"), "mutiyar": (0.6, None),
    "bhangra": (0.75, "dance form"), "giddha": (0.7, "dance form"),
    "dhol": (0.7, "drum"), "beat": (0.6, "rhythm"),
    "party": (0.7, "party"), "kudi": (0.5, "girl"),
    "kuri": (0.5, "girl (alt)"), "munda": (0.45, "boy"),
    "gold": (0.5, None), "koka tare": (0.4, None),
    # ── motivational (positive) ────────────────────────────────────────
    "himmat": (0.6, "courage"), "hausla": (0.6, "courage (alt)"),
    "jung": (0.2, "battle"), "jeet": (0.8, "victory"),
    "haar": (-0.6, "defeat"), "sapno ki udaan": (0.8, None),
    "udaan": (0.7, "flight/aspiration"), "aag": (0.4, "fire (drive)"),
    "toofan": (0.35, "storm (drive)"), "sitaare": (0.4, None),
    "badhta": (0.4, "rising"), "rukna": (-0.3, "to stop"),
    "chalta": (0.2, "keeps going"), "jugar": (0.55, "hustle (colloq)"),
    "sangharsh": (0.3, "struggle"), "kamyaabi": (0.75, "success"),
    "safalta": (0.75, "success"), "asafal": (-0.6, "failure"),
    # ── night / melancholy ambience ────────────────────────────────────
    "shyam": (0.1, "dusk"), "sandhya": (0.15, "evening"),
    "chandamama": (0.35, "moon (endearment)"), "tara": (0.25, "star"),
    "nadiya": (0.2, "river"), "dariya": (0.2, "river/sea"),
    "saahil": (0.25, "shore"), "kinara": (0.25, "shore (alt)"),
    "behta": (0.05, "flowing"), "bujh": (-0.4, "extinguish"),
    "bhujha": (-0.45, "extinguished"), "sard": (-0.3, "cold"),
    "sardi": (-0.25, "winter"), "garm": (0.1, "warm"),
    "door": (-0.4, "far/distant"), "paas": (0.4, "near"),
    "bheed": (-0.2, "crowd"), "shehar mein": (-0.1, None),
    "ghar": (0.45, "home"), "ghar aaja": (0.5, None),
    "videsi": (-0.5, "foreign/exiled"), "pardesi": (-0.45, "outsider/traveler"),
    "nadiya paar": (0.3, None), "kinare": (0.25, None),
}

GENERATED_NOTE = """/**
 * GENERATED — ROMANIZED HINDI/PUNJABI MOOD LEXICON (Phase 5).
 * Source of truth + audit trail: scripts/gen_romanized_mood.py
 * (edit THAT file and re-run; never hand-edit this output).
 *
 * Each entry: word → valence in −1..+1 (polarity axis matches VADER:
 * negative = sad/dark, positive = joyful/bright). Curated for romanized
 * film/pop lyric lines — love, longing, heartbreak, celebration,
 * devotion, dance-floor flex, motivation, night ambience.
 *
 * MIT-licensed stack overall: VADER (MIT) carries the English lexicon;
 * this table is original work, same license as the app.
 */

export const ROMANIZED_MOOD: Record<string, number> = {
"""


def main() -> int:
    lines = []
    for word, (score, gloss) in sorted(WORDS.items()):
        entry = f"  '{word}': {score:.2f},"
        if gloss:
            entry += f"  // {gloss}"
        lines.append(entry)
    body = "\n".join(lines)
    out = GENERATED_NOTE + body + "\n};\n"
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "ai", "core", "romanizedMood.ts")
    with open(path, "w", encoding="utf-8") as f:
        f.write(out)
    print(f"OK → {os.path.abspath(path)}: {len(WORDS)} entries")
    return 0


if __name__ == "__main__":
    sys.exit(main())
