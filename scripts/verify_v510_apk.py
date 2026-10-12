#!/usr/bin/env python3
"""v5.1.0 APK deep-verify (WAVE 1 — THE MEMORY LAYER: Song Stories + Audio Bookmarks).

On top of every retained regression bar (knowledge table, lexicons,
intelligence markers, waves 2-5), this verifier proves the MEMORY LAYER
rode the bundle:

  V510-0  versionName in the compiled manifest is 5.1.0 (the workflow
          stamps it from the tag).
  V510-A  the baked knowledge table + lexicons still ride inside the
          Hermes bundle (regression, kept from v4.3).
  V510-B  the MEMORY LAYER surface, each an exact marker:
          - SONG STORIES: display (song-story-line), editor
            ("Add a memory"), service (createSongStories);
          - AUDIO BOOKMARKS: service (createBookmarks), the pure gesture
            classifier (classifyPress), the NEW list view ("Your
            bookmarks for this song"), the NEW honest empty states
            (NO BOOKMARKS YET / NO MEMORY YET), the NEW pure row label
            (bookmarkTimeLabel);
          - the SQLite layer (appcontent.db) and the webmock-free law.
  V510-G  the v5.1.0 bulletin key + headline (the update is the one it
          announces).
  V510-H  Mock hygiene (retained law): no webmock leak.

METHOD (the v4.2/v4.3 lesson): the Hermes string storage is ONE PACKED
BLOB — substring probes false-positive across string boundaries, so
every check below runs against the PARSED hbc string table (v84–v96,
parser embedded) and requires EXACT string membership. Function/
property identifiers and testID literals survive minification and are
the same evidence class v4.3 shipped on.

Usage:
  python3 scripts/verify_v510_apk.py [path-to-apk]
"""
import glob
import re
import struct
import sys
import zipfile

failures = []
checks_run = 0


def check(name, ok, detail=""):
    global checks_run
    checks_run += 1
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
    print(f"v5.1.0 deep-verify: {apk}")

    # ── V510-0: manifest versionName ────────────────────────────────────
    vn = manifest_version_name(apk)
    check("V510-0 versionName is 5.1.0", vn == "5.1.0", f"versionName={vn}")

    with zipfile.ZipFile(apk) as z:
        names = z.namelist()
        bundle_name = next((n for n in names if n == "assets/index.android.bundle"), None)
        check("V510-P the Hermes bundle is present", bundle_name is not None)
        if not bundle_name:
            print(f"v5.1.0 verify: {len(failures)} FAILURE(S): {failures}")
            return 1
        try:
            strings = extract_strings(z.read(bundle_name))
        except ValueError as e:
            check("V510-P the bundle parses as Hermes hbc", False, str(e))
            print(f"v5.1.0 verify: {len(failures)} FAILURE(S): {failures}")
            return 1
        sset = set(strings)

        # ── V510-A: the baked knowledge table + lexicons (regression) ───
        keypat = re.compile(r"^[a-z0-9 '’&(),.\-!?]{1,60}\|[a-z0-9 '’&(),.\-!?]{1,60}$")
        key_count = sum(1 for s in strings if keypat.match(s))
        check("V510-A1 baked recording keys inside the bundle", key_count >= 30_000, f"{key_count} title|artist keys")
        check("V510-A2 table __meta marker", "__meta" in sset)
        vader_tokens = ["zealot", "ungrateful", "welcoming", "catastrophe", "amazement", "screwed"]
        hits = sum(1 for t in vader_tokens if t in sset)
        check("V510-A3 VADER lexicon tokens inside the bundle", hits >= 5, f"{hits}/6 tokens")

        # ── V510-B: THE MEMORY LAYER — song stories + audio bookmarks ───
        memory = {
            "V510-B1 SONG STORIES display": "song-story-line",
            "V510-B2 SONG STORIES editor": "Add a memory",
            "V510-B3 SONG STORIES service": "createSongStories",
            "V510-B4 AUDIO BOOKMARKS service": "createBookmarks",
            "V510-B5 AUDIO BOOKMARKS classifier": "classifyPress",
            "V510-B6 BOOKMARKS LIST view (new in 5.1.0)": "Your bookmarks for this song",
            "V510-B7 honest bookmarks empty state (new)": "NO BOOKMARKS YET \u2014 HOLD THE PROGRESS BAR WHILE PLAYING TO PIN ONE",
            "V510-B8 honest memory empty state (new)": "NO MEMORY YET \u2014 YOUR NOTE STAYS ON THIS DEVICE",
            "V510-B9 pure row label (new)": "bookmarkTimeLabel",
            "V510-B10 user-content database": "appcontent.db",
            "V510-B11 stories table": "DELETE FROM song_stories WHERE recordingKey = ?",
            "V510-B12 bookmarks table": "INSERT OR REPLACE INTO bookmarks (id, recordingKey, positionMs, note, createdAt) VALUES (?,?,?,?,?)",
            # bmReqRef is a MINIFIED-AWAY local (the v4.3 lesson: only string
            # literals + property names survive) — the stale-response guard
            # itself is locked by the bun suite (wave_v510 locks). The APK bar
            # proves the per-row delete affordance rode the bundle instead.
            "V510-B13 per-row delete affordance (new)": "bookmark-del-",
        }
        for name, marker in memory.items():
            check(name, marker in sset)

        # ── V510-C: waves 2-5 regression spot checks (retained) ─────────
        regression = {
            "V510-C1 TASTE RADAR core": "computeRadarAxes",
            "V510-C2 MOOD JOURNEY planner": "planMoodPath",
            "V510-C3 CONCERT encoder": "encodeConcert",
            "V510-C4 MEMORY TAGS service": "createMemoryTags",
            "V510-C5 haptic hydration gate": "isHapticsHydrated",
            "V510-C6 network kind refresh": "refreshNetworkKind",
        }
        for name, marker in regression.items():
            check(name, marker in sset)

        # ── V510-G: the bulletin announces THIS release ─────────────────
        check("V510-G1 v5.1.0 bulletin key", "tsf.whatsNew.v5_1_0" in sset)
        check("V510-G2 THE MEMORY LAYER bulletin", "TSF MUSIC 5.1.0 — THE MEMORY LAYER" in sset)

        # ── V510-H: mock hygiene (retained law) ─────────────────────────
        check("V510-H1 no webmock leak in the bundle", "webmocks/fixtures" not in sset
              and b"webmocks/fixtures" not in z.read(bundle_name))

    print()
    # V510-S — the verifier inventories ITSELF (the v5.2.0 M5 lesson:
    # deleting a marker line was a SILENT loosening — the check merely
    # stopped running and the run stayed ALL GREEN. The executed-check
    # count is pinned; a quietly removed or added check is a RED.)
    PINNED_CHECK_COUNT = 27
    check("V510-S the verifier executed its full pinned inventory",
          checks_run == PINNED_CHECK_COUNT, f"{checks_run}/{PINNED_CHECK_COUNT}")
    if failures:
        print(f"v5.1.0 verify: {len(failures)} FAILURE(S): {failures}")
        return 1
    print("v5.1.0 verify: ALL GREEN — THE MEMORY LAYER ships, sealed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
