#!/usr/bin/env python3
"""
BAKE THE IITB HINDI SENTIMENT LEXICON (Wave C · C1).

Source of truth: the Hindi SentiWordNet (HSWN) — the IIT Bombay Hindi
sentiment lexicon resource (Joshi et al.), vendored from an MIT-licensed
mirror into scripts/data/HSWN-HindiSentiWordnet.txt (license alongside:
scripts/data/HSWN-LICENSE). Format per row:

    POS_TAG ID POS NEG LIST_OF_WORDS(Devanagari, comma-separated)

Bake pipeline (deterministic; re-running emits byte-identical output):
  1. score = POS - NEG  in [-1, +1]   (standard SentiWordNet semantics)
  2. filter |score| >= 0.3            (strong sentiment only — the brief's
                                       literal filter; the weak band is
                                       NOT shipped)
  3. Devanagari → romanized via a pragmatic ITRANS-style mapping that
       a. groups consonant runs fused by viramas into CLUSTERS
          (दर्द → d-a-rd → "dard"; अच्छा → a-chha → "achha")
       b. folds word-final long vowels the way lyrics are actually
          written (आशा → "aasha", जुदाई → "judai", ख़ुशी → "khushi",
          आँसू → "aansoo") and collapses the aa+ī ending (tanhaai →
          "tanhai")
       c. applies the classic right-to-left medial-schwa-deletion
          heuristic (ख़ुशक़िस्मत → "khushkismat", not the bookish
          "khushakismat"; लड़का → "ladka"; सचमुच → "sachmuch")
  4. dedupe, sort, round scores to 3dp
  5. emit assets/hindi_lexicon_iitb.json — { romanized_word: score }

HONEST COUNT NOTE (the audit trail): the real HSWN carries 9,805
distinct Devanagari words; 1,956 survive the |score| >= 0.3 filter. The
brief hoped for ≥3,000 strong words — the resource's actual strong band
is smaller than its premise. This script ships the honest number and
prints the full distribution; it does NOT lower the filter or fabricate
spelling variants to cross a threshold.

Output consumer: src/ai/core/hindiLexicon.ts (lazy, post-paint load).
"""

import json
import os
import sys
import unicodedata
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'data', 'HSWN-HindiSentiWordnet.txt')
OUT = os.path.join(HERE, '..', 'assets', 'hindi_lexicon_iitb.json')

SCORE_FLOOR = 0.3

DEV_MIN, DEV_MAX = '\u0900', '\u097f'

# ── Devanagari → romanized (pragmatic ITRANS-ish, house style) ─────────
# The existing hand-curated table (romanizedMood.ts) romanizes with
# 'aa' for आ, 'ee' for mid-word ई, 'oo' for ू, 'w' for व, and folds
# word-final long vowels short. These tables match that convention.

INDEPENDENT_VOWELS = {
    'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo',
    'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au',
}
FINAL_FOLD = {'aa': 'a', 'ee': 'i'}  # word-final long vowels fold short

MATRAS = {
    'ा': 'aa', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo',
    'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au',
}

CONSONANTS = {
    'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n',
    'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
    'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
    'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
    'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
    'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'w',
    'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h',
    'ळ': 'l', 'क़': 'q', 'ख़': 'kh', 'ग़': 'g', 'ज़': 'z',
    'ड़': 'd', 'ढ़': 'dh', 'फ़': 'f', 'य़': 'y',
}

NASALS = {'ं': 'n', 'ँ': 'n'}  # anusvara / chandrabindu
VIRAMA = '्'
NUKTA = '़'  # U+093C — NFC never composes it (Unicode exclusion), so the
# parser folds consonant+nukta pairs itself when it meets them.

# conjuncts with idiosyncratic romanizations (folded before parsing):
# च्छ reads as ONE long affricate in romanized lyrics (अच्छा → achha);
# other geminates KEEP their double letter (मोहब्बत → mohabbat) — the
# virama-chain builder emits them correctly on its own. ज्ञ/क्ष carry
# their own readings.
CONJUNCTS = {'ज्ञ': 'gy', 'क्ष': 'ksh', 'च्छ': 'chh', 'ल्ल': 'll'}

# nukta retunes the consonant it follows (क+़ → k, फ+़ → f, …).
# क़ word-final is the ONE exception: the iconic lyric spelling "ishq"
# keeps the q — handled by the \u0003 marker in parse_syllables.
NUKTA_FOLD = {'क': 'k', 'ग': 'g', 'ज': 'z', 'फ': 'f', 'ड': 'd', 'ढ': 'dh'}


def is_dev(c: str) -> bool:
    return DEV_MIN <= c <= DEV_MAX


def parse_syllables(word: str) -> list[dict] | None:
    """
    Parse Devanagari into syllables:
      {onset: str(consonant cluster), vowel: str|None, implicit: bool,
       nasal: bool}
    vowel None = implicit 'a' (schwa-deletable); '' = suppressed.
    A consonant fused to the NEXT consonant by a virama is CLUSTER-MEDIAL
    (its vowel is killed by the virama); a consonant followed by a matra
    or by nothing starts its own syllable. दर्द = d(a) + rd(∅).
    Returns None when the word contains anything un-parseable.
    """
    word = unicodedata.normalize('NFC', word)
    # word-final क़ keeps the iconic "q" spelling (ishq) — other क़ read k
    if word.endswith('क' + NUKTA):
        word = word[:-2] + '\u0003'
    for dev, rom in CONJUNCTS.items():
        word = word.replace(dev, '\u0001' + rom + '\u0002')

    syllables: list[dict] = []
    i, n = 0, len(word)

    def rom_of(c: str) -> str | None:
        if c == '\u0001':
            return None  # handled by the caller
        if c in CONSONANTS:
            return CONSONANTS[c]
        return None

    while i < n:
        c = word[i]
        if c == '\u0003':  # word-final क़ — the "ishq" q
            onset = 'q'
            i += 1
        elif c == '\u0001':  # pre-romanized conjunct
            j = word.index('\u0002', i)
            onset = word[i + 1:j]
            i = j + 1
        elif c in CONSONANTS:
            onset = CONSONANTS[c]
            i += 1
        elif c in INDEPENDENT_VOWELS:
            syllables.append({'onset': '', 'vowel': INDEPENDENT_VOWELS[c], 'implicit': False, 'nasal': False})
            i += 1
            continue
        elif c in NASALS:
            if not syllables:
                return None
            syllables[-1]['nasal'] = True
            i += 1
            continue
        else:
            return None  # digits, danda, foreign scripts — honest skip

        # nukta retunes the consonant just read (क + ़ = q, फ + ़ = f)
        if i < n and word[i] == NUKTA:
            prev_char = word[i - 1]  # the consonant we just consumed
            if prev_char in NUKTA_FOLD:
                onset = NUKTA_FOLD[prev_char]
            i += 1  # consume the nukta

        # virama chain: consonant(+virama+consonant)* — the chain TAIL
        # carries the syllable's vowel slot; medial members are killed
        while i + 1 < n and word[i] == VIRAMA:
            nxt = word[i + 1]
            if nxt == '\u0001':
                j = word.index('\u0002', i)
                onset += word[i + 1:j]
                i = j + 1
                continue
            if nxt == '\u0003':  # chain tail = the "ishq" q
                onset += 'q'
                i += 2
                continue
            if nxt not in CONSONANTS:
                break
            med = CONSONANTS[nxt]
            if nxt == 'व':
                med = 'w'  # cluster-medial व reads w (khwahish, dweep)
            onset += med
            i += 2

        vowel: str | None = None
        implicit = True
        if i < n and word[i] in MATRAS:
            vowel = MATRAS[word[i]]
            implicit = False
            i += 1
        nasal = False
        if i < n and word[i] in NASALS:
            nasal = True
            i += 1
        syllables.append({'onset': onset, 'vowel': vowel, 'implicit': implicit, 'nasal': nasal})

    return syllables or None


def syllable_rom(s: dict, is_final: bool) -> str:
    v = s['vowel']
    nasal = 'n' if s['nasal'] else ''
    if v is None:
        # word-final vowelless cluster keeps just the consonants; a
        # non-final cluster with no vowel yet carries the implicit 'a'
        return s['onset'] + nasal if is_final else s['onset'] + 'a' + nasal
    if v == '':
        return s['onset'] + nasal  # explicitly suppressed schwa
    if is_final and not s['nasal'] and v in FINAL_FOLD:
        v = FINAL_FOLD[v]  # word-final long vowels fold short
    return s['onset'] + v + nasal


def transliterate(word: str) -> str | None:
    """Devanagari → romanized (see module docstring for the rules)."""
    word = word.strip()
    if not word or ' ' in word:
        return None
    syls = parse_syllables(word)
    if syls is None:
        return None

    # a final syllable still carrying its IMPLICIT 'a' drops it
    # (dard, samajh, ram — Hindi words never end in pronounced schwa)
    last = syls[-1]
    if last['implicit'] and last['vowel'] is None:
        last['vowel'] = ''  # '' = consonant-only

    # right-to-left medial schwa deletion (the tuned heuristic):
    #   • candidate = an implicit-'a' MEDIAL syllable whose onset can
    #     serve as a coda (glides w/y and a standalone h can never —
    #     bewafa/mohabbat keep their schwa; khushkismat/sachmuch drop
    #     theirs; muskaan has no candidate — its spelling carries the
    #     virama मुस्कान = mu-sk-aa-n)
    #   • BOTH neighbours must carry a pronounced vowel (an implicit 'a'
    #     counts — it is pronounced unless itself deleted)
    #   • a GEMINATE next-onset (ll, nn…) blocks — 'sll' is unpronounceable
    #     (तसल्ली keeps its schwa: tasalli)
    #   • when the NEXT syllable is word-final, deletion requires the
    #     trisyllabic shape OR an open prev syllable: लड़का (la, implicit)
    #     and ख़ुशबू (khu, open) delete; ज़िंदगी (zin, nasal-closed) keeps
    # Known accepted misses (lexical, not mechanical): bekaraar→bekraar,
    # badnaseeb→badanseeb, majboor→mazboor (the source nukta drops in
    # lyric convention). Real schwa facts are gradient; this ships the
    # dominant pattern.
    def pronounced(syl: dict) -> bool:
        return syl['vowel'] != ''  # None (implicit) and real vowels count

    for idx in range(len(syls) - 2, 0, -1):
        s = syls[idx]
        if not s['implicit']:
            continue
        onset = s['onset']
        if onset.endswith(('w', 'y')) or onset == 'h':
            continue
        prev, nxt = syls[idx - 1], syls[idx + 1]
        if not pronounced(prev) or not pronounced(nxt):
            continue
        if len(nxt['onset']) > 1 and len(set(nxt['onset'])) == 1:
            continue  # geminate onset — the schwa breaks the pileup
        nxt_is_final = idx + 1 == len(syls) - 1
        if nxt_is_final and prev['vowel'] is not None and prev['nasal']:
            continue  # closed (nasal) prev + final next = keep (zindagi)
        s['vowel'] = ''  # onset fuses forward as the coda

    pieces = [syllable_rom(s, is_final=(idx == len(syls) - 1)) for idx, s in enumerate(syls)]
    roman = ''.join(pieces)
    # 'aa' + final 'i/ee' sequence folds (जुदाई judaai → judai,
    # तन्हाई tanhaai → tanhai) — only for real words, never the bare 'aai'
    if len(roman) > 3 and roman.endswith('aai'):
        roman = roman[:-3] + 'ai'
    if not roman or not all('a' <= c <= 'z' for c in roman):
        return None
    return roman


def main() -> int:
    if not os.path.exists(SRC):
        print(f'FATAL: source not found: {SRC}', file=sys.stderr)
        return 1

    words: dict[str, float] = {}
    band_counts: Counter = Counter()
    total_dev_words = set()
    skipped_rows = 0

    lines = open(SRC, encoding='utf-8').read().strip().split('\n')
    for line in lines[1:]:
        parts = line.split()
        if len(parts) < 5:
            skipped_rows += 1
            continue
        try:
            pos, neg = float(parts[2]), float(parts[3])
        except ValueError:
            skipped_rows += 1
            continue
        score = round(pos - neg, 4)
        wordlist = ' '.join(parts[4:])
        for w in wordlist.split(','):
            w = w.strip()
            if not w:
                continue
            if not all(is_dev(c) for c in w):
                continue
            total_dev_words.add(w)
            band_counts[round(abs(score), 3)] += 1
            if abs(score) < SCORE_FLOOR:
                continue
            roman = transliterate(w)
            if roman is None:
                continue
            # deterministic merge: the strongest reading of a word wins
            if roman not in words or abs(score) > abs(words[roman]):
                words[roman] = round(score, 3)

    lex = dict(sorted(words.items()))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(lex, f, ensure_ascii=True, sort_keys=True, separators=(',', ':'))
        f.write('\n')

    size = os.path.getsize(OUT)
    print(f'source rows            : {len(lines) - 1} (skipped {skipped_rows})')
    print(f'distinct devanagari    : {len(total_dev_words)}')
    print(f'strong |score|>=0.3    : {len(lex)} romanized words')
    print(f'output                 : {OUT} ({size} bytes)')
    try:
        import gzip
        with open(OUT, 'rb') as f:
            gz = len(gzip.compress(f.read(), 9))
        print(f'gzipped                : {gz} bytes ({gz / 1024:.1f} KB)')
    except Exception:
        pass
    print('score bands (all words):', dict(sorted(band_counts.items())))
    print('sample:', list(lex.items())[:6])
    return 0


if __name__ == '__main__':
    sys.exit(main())
