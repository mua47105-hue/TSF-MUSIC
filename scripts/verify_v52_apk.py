#!/usr/bin/env python3
"""v5.2.0 APK deep-verify (THE IMPROVEMENT ARC — Waves A–D + the mock-leak fix).

On top of every retained regression bar (knowledge table, lexicons,
memory layer, waves 2-5), this verifier proves the IMPROVEMENT ARC rode
the bundle:

  V520-0  versionName in the compiled manifest is 5.2.0 (the workflow
          stamps it from the tag).
  V520-A  the baked knowledge table + lexicons still ride inside the
          Hermes bundle (regression, kept from v4.3).
  V520-B  the MEMORY LAYER markers (regression, kept from v5.1.0).
  V520-W  THE IMPROVEMENT ARC, wave by wave, each an exact marker:
          - Wave A1 (SQLite indexes): the migration's index names;
          - Wave A2 (cipher cache): the KV key prefix;
          - Wave A3 (lazy screens): the skeleton testID;
          - Wave A4 (offline queue): the storage key;
          - Wave B2 (genre haptics): the settings-store key;
            Wave B1 (ReplayGain) is DORMANT — wired but inert until
            baked_features.json carries a loudness column — it adds NO
            user-visible strings, so it is asserted by the bun suite
            (waveb_b1 locks), not by the APK. Inventing a marker for a
            dormant feature would be a fabrication, not a check.
          - Wave C1 (Hindi lexicon): the bundled asset + sampled
            romanized HSWN words (the JSON is a Metro-inlined module,
            so the words are in the string table even though the
            require is lazy);
          - Wave C2 (FTS5 notes): the virtual-table name + the
            SearchScreen section header;
          - Wave C3 (Surprise Me): the button testID + the toast line;
          - Wave D1 (parallax): the 'fh-0' first-feed-row proxy key.
  V520-G  the v5.2.0 bulletin key + headline (the update is the one it
          announces).
  V520-H  Mock hygiene (retained law): no webmock leak.

METHOD (the v4.2/v4.3 lesson): the Hermes string storage is ONE PACKED
BLOB — substring probes false-positive across string boundaries, so
every check below runs against the PARSED hbc string table (v84–v96,
parser embedded) and requires EXACT string membership. testID literals,
SQL DDL, storage keys and user-facing strings survive minification;
local variable names do not (the v4.3 lesson).

Usage:
  python3 scripts/verify_v52_apk.py [path-to-apk]
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
    print(f"v5.2.0 deep-verify: {apk}")

    # ── V520-0: manifest versionName ────────────────────────────────────
    vn = manifest_version_name(apk)
    check("V520-0 versionName is 5.2.0", vn == "5.2.0", f"versionName={vn}")

    with zipfile.ZipFile(apk) as z:
        names = z.namelist()
        bundle_name = next((n for n in names if n == "assets/index.android.bundle"), None)
        check("V520-P the Hermes bundle is present", bundle_name is not None)
        if not bundle_name:
            print(f"v5.2.0 verify: {len(failures)} FAILURE(S): {failures}")
            return 1
        try:
            strings = extract_strings(z.read(bundle_name))
        except ValueError as e:
            check("V520-P the bundle parses as Hermes hbc", False, str(e))
            print(f"v5.2.0 verify: {len(failures)} FAILURE(S): {failures}")
            return 1
        sset = set(strings)

        # ── V520-A: the baked knowledge table + lexicons (regression) ───
        keypat = re.compile(r"^[a-z0-9 '’&(),.\-!?]{1,60}\|[a-z0-9 '’&(),.\-!?]{1,60}$")
        key_count = sum(1 for s in strings if keypat.match(s))
        check("V520-A1 baked recording keys inside the bundle", key_count >= 30_000, f"{key_count} title|artist keys")
        check("V520-A2 table __meta marker", "__meta" in sset)
        vader_tokens = ["zealot", "ungrateful", "welcoming", "catastrophe", "amazement", "screwed"]
        hits = sum(1 for t in vader_tokens if t in sset)
        check("V520-A3 VADER lexicon tokens inside the bundle", hits >= 5, f"{hits}/6 tokens")

        # ── V520-B: the MEMORY LAYER (regression, kept from v5.1.0) ─────
        memory = {
            "V520-B1 SONG STORIES display": "song-story-line",
            "V520-B2 SONG STORIES editor": "Add a memory",
            "V520-B3 AUDIO BOOKMARKS service": "createBookmarks",
            "V520-B4 user-content database": "appcontent.db",
        }
        for name, marker in memory.items():
            check(name, marker in sset)

        # ── V520-W: THE IMPROVEMENT ARC (Waves A–D) ─────────────────────
        arc = {
            "V520-W-A1 SQLite index names (Wave A1)": "idx_events_track_ts",
            "V520-W-A1b index DDL rides the bundle": "CREATE INDEX IF NOT EXISTS",
            "V520-W-A2 cipher-cache KV prefix (Wave A2)": "tsf.ytCipher.",
            "V520-W-A3 lazy-screen skeleton testID (Wave A3)": "lazy-screen-skeleton",
            "V520-W-A4 offline-queue storage key (Wave A4)": "tsf.queue.v1",
            "V520-W-B2 genre-haptics store key (Wave B2)": "tsf.hapticGenreMode.v1",
            "V520-W-C2 FTS5 notes virtual table (Wave C2)": "personal_notes_fts",
            "V520-W-C2b YOUR NOTES section header (Wave C2)": "\U0001F4DD YOUR NOTES",
            "V520-W-C3 surprise button testID (Wave C3)": "surprise-me-btn",
            "V520-W-C3b surprise toast line (Wave C3)": "Playing a surprise pick \u2014 see if it sticks",
            "V520-W-D1 parallax header-proxy key (Wave D1)": "fh-0",
        }
        for name, marker in arc.items():
            check(name, marker in sset)

        # ── V520-W-C1: the Hindi lexicon (bundled asset + sampled words) ─
        check("V520-W-C1 the HSWN lexicon asset is packaged",
              "assets/hindi_lexicon_iitb.json" in names)
        hindi_samples = ["aabhaaheen", "aadamkhor", "zeest", "khamoshi", "tanhai"]
        hhits = sum(1 for w in hindi_samples if w in sset)
        check("V520-W-C1b romanized HSWN words inside the bundle", hhits >= 3, f"{hhits}/5 sampled words")

        # ── V520-G: the bulletin announces THIS release ─────────────────
        check("V520-G1 v5.2.0 bulletin key", "tsf.whatsNew.v5_2_0" in sset)
        check("V520-G2 THE IMPROVEMENT ARC bulletin", "TSF MUSIC 5.2.0 \u2014 THE IMPROVEMENT ARC" in sset)

        # ── V520-H: mock hygiene (retained law) ─────────────────────────
        check("V520-H1 no webmock leak in the bundle", "webmocks/fixtures" not in sset
              and b"webmocks/fixtures" not in z.read(bundle_name))

    print()
    # V520-S — the verifier inventories ITSELF (the M5 lesson, v5.2.0:
    # deleting a marker line from this script was a SILENT loosening —
    # the check merely stopped running and the run stayed ALL GREEN.
    # The executed-check count is pinned; a check quietly removed or
    # added anywhere is a RED, not a gap.)
    PINNED_CHECK_COUNT = 25
    check("V520-S the verifier executed its full pinned inventory",
          checks_run == PINNED_CHECK_COUNT, f"{checks_run}/{PINNED_CHECK_COUNT}")
    if failures:
        print(f"v5.2.0 verify: {len(failures)} FAILURE(S): {failures}")
        return 1
    print("v5.2.0 verify: ALL GREEN — THE IMPROVEMENT ARC ships, sealed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
