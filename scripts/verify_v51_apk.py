#!/usr/bin/env python3
"""v5.0.1 APK deep-verify (THE VERIFICATION ROUND — the auditor's 8 findings sealed).

On top of every v4.3/v5.0.0 bar (all retained below as regression
bars), this verifier proves the FIX ROUND rode the bundle:

  V51-0  versionName in the compiled manifest matches the 5.0.x line
         (the workflow stamps it from the tag).
  V51-A  the baked knowledge table + lyric lexicons still ride inside
         the Hermes bundle (regression bars kept from v4.3).
  V51-B  the v4.2/4.3 intelligence + THE TEN markers (regression bars).
  V51-C  **WAVE 2** — Song Stories, Audio Bookmarks, Taste Radar,
         Time Machine (historical fold), each with an exact marker.
  V51-D  **WAVE 3** — Haptic Choreography, Pseudo-Visualizer, Karaoke
         Words, Shuffle-by-Vibe, each with an exact marker.
  V51-E  **WAVE 4** — Mood Journey, Session Memory, Decade Radio,
         Artist Timeline, each with an exact marker.
  V51-F  **WAVE 5** — Concert Mode (codec + join/share testIDs), Genre
         Explorer (layout + PRNG + screen), Memory Tags (attacher +
         service + player testIDs), each with an exact marker.
  V51-G  the v5.0.1 bulletin key + headline (the update is the one it announces).
  V51-R  **THE FIX ROUND** — the v5.0.1 function/marker surface (atomic
         fold, network kind, hydration gate, art cache contract, honest
         refusals, resolved-count toasts), each an exact marker.
  V51-H  Mock hygiene (retained law): no webmock leak.

METHOD (the v4.2/v4.3 lesson): the Hermes string storage is ONE PACKED
BLOB — substring probes false-positive across string boundaries, so
every check below runs against the PARSED hbc string table (v84–v96,
parser embedded) and requires EXACT string membership. Function/
property identifiers and testID literals survive minification and are
the same evidence class v4.3 shipped on.

Usage:
  python3 scripts/verify_v50_apk.py [path-to-apk]
"""
import glob
import re
import struct
import sys
import zipfile

failures = []


def check(name, ok, detail=""):
    print(f"  [{'OK' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        failures.append(name)


# ── embedded Hermes hbc string-table parser (v84–v96) ───────────────────

HEADER_MAGIC = bytes.fromhex("c61fbc03c103191f")


def extract_strings(bundle_bytes):
    """Decode the exact string table of a Hermes bytecode bundle."""
    d = bundle_bytes
    if d[:8] != HEADER_MAGIC:
        raise ValueError(f"not a Hermes bytecode bundle (magic {d[:8].hex()})")
    (version,) = struct.unpack_from("<I", d, 8)
    if not (84 <= version <= 96):
        raise ValueError(f"unsupported hbc version {version} — extend the parser")
    o = 12
    o += 20  # sourceHash (SHA1)
    (_file_length, _gci, function_count, string_kind_count, identifier_count,
     string_count, overflow_string_count, string_storage_size, *_rest) = struct.unpack_from("<19I", d, o)
    o += 76 + 3  # 19 u32 header fields + 3 option bytes
    o += (-o) % 32  # header block is padded to a 32-byte multiple
    # every function header occupies exactly 16 bytes (large headers for
    # overflowed functions live elsewhere in the file, not inline)
    o += function_count * 16
    o += (-o) % 4 + string_kind_count * 4      # string kinds
    o += (-o) % 4 + identifier_count * 4       # identifier hashes
    o += (-o) % 4
    small = struct.unpack_from(f"<{string_count}I", d, o)
    o += string_count * 4
    o += (-o) % 4
    overflow = struct.unpack_from(f"<{overflow_string_count * 2}I", d, o) if overflow_string_count else ()
    o += overflow_string_count * 8
    o += (-o) % 4
    storage = d[o:o + string_storage_size]

    out = []
    for e in small:
        is_utf16 = e & 1
        length = (e >> 24) & 0xFF
        offset = (e >> 1) & 0x7FFFFF  # 23-bit offset field (hbc >= 56)
        if length == 0xFF:  # long string: the offset field indexes the overflow table
            idx = offset
            offset = overflow[idx * 2]
            length = overflow[idx * 2 + 1]
        if is_utf16:
            length *= 2  # the entry length counts CHARACTERS, not bytes
        raw = storage[offset:offset + length]
        # 8-bit strings are one byte per char (Latin-1 style), NOT UTF-8
        out.append(raw.decode("utf-16-le", errors="surrogatepass")
                   if is_utf16 else raw.decode("latin-1"))
    return out


def manifest_version_name(apk_path):
    """versionName from the compiled binary AXML (AndroidManifest.xml)."""
    blob = zipfile.ZipFile(apk_path).read("AndroidManifest.xml")
    pos = 8
    strings = []
    while pos < len(blob) - 8:
        ctype, _hsize, csize = struct.unpack_from("<HHI", blob, pos)
        if ctype == 0x0001:  # string pool
            scount = struct.unpack_from("<I", blob, pos + 8)[0]
            _flags, sstart = struct.unpack_from("<II", blob, pos + 16)
            offsets = struct.unpack_from(f"<{scount}I", blob, pos + 28)
            base = pos + sstart
            for off in offsets:
                p = base + off
                l = struct.unpack_from("<H", blob, p)[0]
                strings.append(blob[p + 2:p + 2 + l * 2].decode("utf-16-le", errors="replace"))
            break
        pos += csize
    while pos < len(blob) - 8:
        ctype, _hsize, csize = struct.unpack_from("<HHI", blob, pos)
        if csize < 8 or pos + csize > len(blob):
            break
        if ctype == 0x0102:  # element start
            _ns, name = struct.unpack_from("<II", blob, pos + 16)
            attr_start, _attr_size, attr_count = struct.unpack_from("<HHH", blob, pos + 24)
            if name < len(strings) and strings[name] == "manifest":
                for i in range(attr_count):
                    aoff = pos + 16 + attr_start + i * 20
                    _a_ns, a_name, a_raw = struct.unpack_from("<III", blob, aoff)
                    _t_size, _t_res0, t_type, t_data = struct.unpack_from("<HBBI", blob, aoff + 12)
                    if a_name < len(strings) and strings[a_name] == "versionName":
                        if 0 <= a_raw < len(strings):
                            return strings[a_raw]
                        return f"type={hex(t_type)} data={t_data}"
        pos += csize
    return None


def main():
    apk = sys.argv[1] if len(sys.argv) > 1 else sorted(glob.glob("release/*.apk") + glob.glob("*.apk"))
    if isinstance(apk, list):
        apk = apk[-1] if apk else ""
    if not apk:
        print("FATAL: no APK given (pass a path or drop one in ./)")
        return 1
    print(f"v5.0.1 deep-verify: {apk}")

    # ── V51-0: manifest versionName ─────────────────────────────────────
    vn = manifest_version_name(apk)
    check("V51-0 versionName is 5.0.1", vn == "5.0.1", f"versionName={vn}")

    with zipfile.ZipFile(apk) as z:
        names = z.namelist()
        bundle_name = next((n for n in names if n == "assets/index.android.bundle"), None)
        check("V51-P the Hermes bundle is present", bundle_name is not None)
        if not bundle_name:
            print(f"v5.0.1 verify: {len(failures)} FAILURE(S): {failures}")
            return 1
        try:
            strings = extract_strings(z.read(bundle_name))
        except ValueError as e:
            check("V51-P the bundle parses as Hermes hbc", False, str(e))
            print(f"v5.0.1 verify: {len(failures)} FAILURE(S): {failures}")
            return 1
        sset = set(strings)

        # ── V51-A: the baked knowledge table + lexicons (regression) ────
        keypat = re.compile(r"^[a-z0-9 '’&(),.\-!?]{1,60}\|[a-z0-9 '’&(),.\-!?]{1,60}$")
        key_count = sum(1 for s in strings if keypat.match(s))
        check("V51-A1 baked recording keys inside the bundle", key_count >= 30_000, f"{key_count} title|artist keys")
        check("V51-A2 table __meta marker", "__meta" in sset)
        vader_tokens = ["zealot", "ungrateful", "welcoming", "catastrophe", "amazement", "screwed"]
        hits = sum(1 for t in vader_tokens if t in sset)
        check("V51-A3 VADER lexicon tokens inside the bundle", hits >= 5, f"{hits}/6 tokens")
        check("V51-A4 romanized Hindi/Punjabi mood table", "ROMANIZED_MOOD" in sset)

        # ── V51-B: pre-existing intelligence + THE TEN (regression) ─────
        regression = {
            "V51-B1 lyric-mood cache": "lyricMoodCache",
            "V51-B2 bandit arms": "banditArms",
            "V51-B3 sound-alike facade": "soundAlike",
            "V51-B4 vibe-aligned search": "sessionVibe",
            "V51-B5 SMART VOLUME": "tsf.smartVolume.v1",
            "V51-B6 CROSSFADE": "tsf.crossfade.v1",
            "V51-B7 SMART FOLDERS": "Heavy Rotation",
            "V51-B8 LOCAL REWIND": "MIDNIGHT OBSESSION",
            "V51-B9 TASTE DNA BLEND": "CREATE BLEND PLAYLIST",
            "V51-B10 KINETIC LYRICS": "activeFontSize",
            "V51-B11 AURA VISUALIZER": "aura-visualizer",
            "V51-B12 FOCUS MODE": "focus-toggle",
        }
        for name, marker in regression.items():
            check(name, marker in sset)

        # ── V51-C: WAVE 2 — the emotional features ──────────────────────
        wave2 = {
            "V51-C1 SONG STORIES display": "song-story-line",
            "V51-C2 SONG STORIES editor": "Add a memory",
            "V51-C3 SONG STORIES service": "createSongStories",
            "V51-C4 AUDIO BOOKMARKS service": "createBookmarks",
            "V51-C5 AUDIO BOOKMARKS classifier": "classifyPress",
            "V51-C6 TASTE RADAR core": "computeRadarAxes",
            "V51-C7 TASTE RADAR chart": "RadarChart",
            "V51-C8 TIME MACHINE facade": "thisDayLastYear",
            "V51-C9 historical fold core": "foldEventsIntoDays",
        }
        for name, marker in wave2.items():
            check(name, marker in sset)

        # ── V51-D: WAVE 3 — the intelligent playback ────────────────────
        wave3 = {
            "V51-D1 HAPTIC CHOREOGRAPHY core": "hapticEvent",
            "V51-D2 reduced-haptics switch": "reducedHaptics",
            "V51-D3 PSEUDO-VISUALIZER component": "PseudoVisualizer",
            "V51-D4 visualizer pure mapping": "visualizerState",
            "V51-D5 KARAOKE WORDS interpolator": "activeWord",
            "V51-D6 SHUFFLE BY VIBE core": "optimizeQueueByVibe",
        }
        for name, marker in wave3.items():
            check(name, marker in sset)

        # ── V51-E: WAVE 4 — the deep intelligence ───────────────────────
        wave4 = {
            "V51-E1 MOOD JOURNEY planner": "planMoodPath",
            "V51-E2 MOOD JOURNEY facade": "moodJourney",
            "V51-E3 SESSION MEMORY gate": "shouldSnapshot",
            "V51-E4 SESSION MEMORY facade": "resumeSession",
            "V51-E5 DECADE RADIO ladder": "decadeQuery",
            "V51-E6 DECADE RADIO facade": "decadeRadio",
            "V51-E7 ARTIST TIMELINE grouping": "groupAlbumsByYear",
        }
        for name, marker in wave4.items():
            check(name, marker in sset)

        # ── V51-F: WAVE 5 — social & exploration ────────────────────────
        wave5 = {
            "V51-F1 CONCERT encoder": "encodeConcert",
            "V51-F2 CONCERT decoder": "decodeConcert",
            "V51-F3 CONCERT start plan": "concertStartPlan",
            "V51-F4 CONCERT resolvable map": "concertRowToTrack",
            "V51-F5 CONCERT share surface": "concert-share-btn",
            "V51-F6 CONCERT join surface": "concert-import-btn",
            "V51-F7 GENRE layout core": "genreMapLayout",
            "V51-F8 GENRE seeded PRNG": "mulberry32",
            "V51-F9 GENRE screen door": "genre-map-btn",
            "V51-F10 MEMORY TAGS attacher": "attachMemory",
            "V51-F11 MEMORY TAGS service": "createMemoryTags",
            "V51-F12 MEMORY TAGS chip": "memory-chip",
            "V51-F13 MEMORY TAGS action": "memory-tag-btn",
        }
        for name, marker in wave5.items():
            check(name, marker in sset)
        # the v5 tuning constants ride as property names
        check("V51-F14 wave-5 constants block", all(
            s in sset for s in ("clockDriftMs", "shareLeadInMs", "joinScheduleThresholdMs",
                                "relaxGap", "artProbeSeed", "previewCount")))

        # ── V51-G: the bulletin announces THIS release ──────────────────
        check("V51-G1 v5.0.1 bulletin key", "tsf.whatsNew.v5_0_1" in sset)
        check("V51-G2 THE VERIFICATION ROUND bulletin", "TSF MUSIC 5.0.1 — THE VERIFICATION ROUND" in sset)

        # ── V51-R: THE FIX ROUND markers (v5.0.1's own surface) ─────────
        fixround = {
            "V51-R1 atomic fold watermark key": "historical.foldedThroughTs",
            "V51-R2 queue fingerprint (FNV-1a)": "queueFingerprintOf",
            "V51-R3 real network kind refresh": "refreshNetworkKind",
            "V51-R4 haptic hydration gate setter": "markHapticsHydrated",
            "V51-R5 haptic hydration gate probe": "isHapticsHydrated",
            "V51-R6 genre art cache read": "cachedGenreArt",
            "V51-R7 genre art cache write": "storeGenreArt",
            "V51-R8 concert size-cap constants": "maxCodeChars",
            "V51-R9 concert field-cap constants": "maxTitleChars",
            "V51-R10 honest resume toast": "MOSTLY YOUR SESSION",
            "V51-R11 honest relabel (freshly added)": "freshly added rows",
            "V51-R12 room-full refusal": "THE ROOM IS FULL — CONCERT CODES CARRY",
            "V51-R13 too-big refusal": "THE CODE WOULD BE TOO BIG — SHARE A SMALLER QUEUE",
            "V51-R14 zero-resolved (resume)": "COULD NOT START PLAYBACK — THE SESSION DID NOT RESOLVE",
            "V51-R15 zero-resolved (decade)": "COULD NOT START PLAYBACK — THE DECADE DID NOT RESOLVE",
            "V51-R16 zero-resolved (journey)": "COULD NOT START PLAYBACK — THE JOURNEY DID NOT RESOLVE",
            "V51-R17 zero-resolved (radio)": "COULD NOT START PLAYBACK — THE RADIO DID NOT RESOLVE",
            "V51-R18 zero-resolved (genre tap)": "— NOTHING RESOLVED",
            "V51-R19 the round's headline": "THE VERIFICATION ROUND",
            "V51-R20 the dependency of record": "expo-network",
        }
        for name, marker in fixround.items():
            check(name, marker in sset)

        # ── V51-H: mock hygiene (retained law) ──────────────────────────
        check("V51-H1 no webmock leak in the bundle", "webmocks/fixtures" not in sset
              and b"webmocks/fixtures" not in z.read(bundle_name))

    print()
    if failures:
        print(f"v5.0.1 verify: {len(failures)} FAILURE(S): {failures}")
        return 1
    print("v5.0.1 verify: ALL GREEN — THE MAGNUM OPUS ships, sealed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
