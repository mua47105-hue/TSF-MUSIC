#!/usr/bin/env python3
"""v4.3.1 APK deep-verify (THE TEN, sealed by the auditor's gauntlet).

THE FEATURES being verified at BINARY level:

  V43-0  versionName in the compiled manifest matches the 4.3.x line
         (the workflow stamps it from the tag).
  V43-A  THE BAKED KNOWLEDGE TABLE is inside the Hermes bundle. Metro
         INLINES required JSON modules — the table never ships as a
         loose asset (the v4.2 zip-level check was a false-fail by
         construction; it is replaced by exact string-table evidence:
         the 122k `title|artist` recording keys are visible as exact
         strings, plus the __meta and 'dataset' markers).
  V43-B  THE LYRIC MOOD LEXICONS are inside the bundle (same inlining):
         distinctive VADER tokens + the ROMANIZED_MOOD table marker.
  V43-C  the v4.2 genius intelligence code (exact facade/property/kv
         names: bandit arms, flow memory, sound-alike, feed queries,
         session vibe, lyric-mood cache).
  V43-D  **THE TEN — all ten features, each with an exact marker**:
         smart volume, crossfade, playback rate, smart folders, meta
         overrides, local rewind, taste-dna blend, kinetic lyrics,
         aura visualizer, focus mode.
  V43-E  Mock hygiene (retained law): no webmock leak.

METHOD (the v4.2 lesson, learned the hard way): the Hermes string
storage is ONE PACKED BLOB — raw substring probes false-positive across
string boundaries ("sweet little bandit" + "Armsaudade" contains
"banditArms"; "downloading" + "replay_bonus" contains "GOLDEN_HOUR").
So every bundle check below runs against the PARSED hbc string table
(v96 layout, parser embedded, ~40 lines) and requires EXACT string
membership. Every marker was verified to exist as an exact string in
the shipped v4.3.0 APK (58,869 table keys, 6/6 VADER tokens) and to be
ABSENT from the v4.1.0 APK (red-on-old-APK sanity).

Usage:
  python3 scripts/verify_v43_apk.py [path-to-apk]
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
    print(f"v4.3.1 deep-verify: {apk}")

    # ── V43-0: manifest versionName ─────────────────────────────────────
    vn = manifest_version_name(apk)
    check("V43-0 versionName matches the 4.3.x line", bool(vn and re.match(r"^4\.3\.\d+$", vn)), f"versionName={vn}")

    with zipfile.ZipFile(apk) as z:
        names = z.namelist()
        bundle_name = next((n for n in names if n == "assets/index.android.bundle"), None)
        check("V43-P the Hermes bundle is present", bundle_name is not None)
        if not bundle_name:
            print(f"v4.3.1 verify: {len(failures)} FAILURE(S): {failures}")
            return 1
        try:
            strings = extract_strings(z.read(bundle_name))
        except ValueError as e:
            check("V43-P the bundle parses as Hermes hbc", False, str(e))
            print(f"v4.3.1 verify: {len(failures)} FAILURE(S): {failures}")
            return 1
        sset = set(strings)

        # ── V43-A: the baked knowledge table (inlined by Metro) ─────────
        keypat = re.compile(r"^[a-z0-9 '’&(),.\-!?]{1,60}\|[a-z0-9 '’&(),.\-!?]{1,60}$")
        key_count = sum(1 for s in strings if keypat.match(s))
        check("V43-A1 baked recording keys inside the bundle", key_count >= 30_000, f"{key_count} title|artist keys")
        check("V43-A2 table __meta marker", "__meta" in sset)
        check("V43-A3 dataset source tag", "dataset" in sset)

        # ── V43-B: the lyric mood lexicons (inlined by Metro) ───────────
        vader_tokens = ["zealot", "ungrateful", "welcoming", "catastrophe", "amazement", "screwed"]
        hits = sum(1 for t in vader_tokens if t in sset)
        check("V43-B1 VADER lexicon tokens inside the bundle", hits >= 5, f"{hits}/6 tokens")
        check("V43-B2 romanized Hindi/Punjabi mood table", "ROMANIZED_MOOD" in sset)

        # ── V43-C: the genius intelligence code (exact markers) ─────────
        genius = {
            "V43-C1 lyric-mood cache": "lyricMoodCache",
            "V43-C2 bandit arms": "banditArms",
            "V43-C3 flow memory": "flowTracks",
            "V43-C4 sound-alike ranking": "rankSoundAlike",
            "V43-C5 sound-alike facade": "soundAlike",
            "V43-C6 feed query generator": "feedSongQueries",
            "V43-C7 vibe-aligned search": "sessionVibe",
            "V43-C8 lyric mood reader": "scoreLyrics",
        }
        for name, marker in genius.items():
            check(name, marker in sset)

        # ── V43-D: THE TEN — one exact marker per feature ───────────────
        ten = {
            "V43-D1 SMART VOLUME": "tsf.smartVolume.v1",
            "V43-D2 CROSSFADE": "tsf.crossfade.v1",
            "V43-D3 PLAYBACK RATE": "tsf.playbackRate.v1",
            "V43-D4 SMART FOLDERS": "Heavy Rotation",
            "V43-D5 META OVERRIDES": "tsf.metaOverrides.v1",
            "V43-D6 LOCAL REWIND": "MIDNIGHT OBSESSION",
            "V43-D7 TASTE DNA BLEND": "CREATE BLEND PLAYLIST",
            "V43-D8 KINETIC LYRICS": "activeFontSize",
            "V43-D9 AURA VISUALIZER": "aura-visualizer",
            "V43-D10 FOCUS MODE": "focus-toggle",
        }
        for name, marker in ten.items():
            check(name, marker in sset)
        # ride-along exact markers: the other three crate names + the
        # kinetic constants block + the sing-along scroll testID
        check("V43-D4b the other three crates", all(
            s in sset for s in ("The Graveyard", "Forgotten Gems", "Recently Rescued")))
        check("V43-D8b the kinetic constants block", "KINETIC" in sset
              and "inactiveFontSize" in sset and "singalong-scroll" in sset)

        # ── V43-E: mock hygiene (retained law) ──────────────────────────
        check("V43-E1 no webmock leak in the bundle", "webmocks/fixtures" not in sset
              and b"webmocks/fixtures" not in z.read(bundle_name))

    print()
    if failures:
        print(f"v4.3.1 verify: {len(failures)} FAILURE(S): {failures}")
        return 1
    print("v4.3.1 verify: ALL GREEN — THE TEN ship, sealed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
