#!/usr/bin/env python3
"""v5.2.1 APK deep-verify (THE HARDENING PASS — every forensic-audit finding).

On top of every retained regression bar (the baked knowledge table, the
memory layer, the full v5.2.0 improvement arc), this verifier proves the
v5.2.1 hardening rode the bundle:

  V521-0  versionName in the compiled manifest is 5.2.1.
  V521-R  every retained v5.2.0 bar (knowledge table, memory layer, the
          improvement-arc markers) still rides — zero regression.
  V521-A  the honesty wave: the REAL crate actions replaced the fake
          toasts — the honest unpin/already/downloaded strings must ride;
          the pinned-first Library marker; the old fake literals must NOT.
  V521-N  the network discipline: the 10 s provider-fetch ceiling's error
          string rides; the WebView's third (jnn-pa) origin rides.
  V521-M  the bounded-cache law's construction error string rides.
  V521-G  the v5.2.1 bulletin key + headline + a sampled bullet.
  V521-H  mock hygiene (retained law): no webmock leak.

  Honest non-markers (the B1/DORMANT lesson — inventing a marker for
  code with no user-visible strings would be a fabrication, not a
  check): FIX-B1..B8, C1, C4, D1, D3, D6 assert at the bun level
  (tests/fix_v521_wave*_locks.test.ts), not against APK strings.

METHOD (the v4.2/v4.3 lesson, re-learned every release): the Hermes
string storage is ONE PACKED BLOB — substring probes false-positive
across string boundaries, so every check runs against the PARSED hbc
string table and requires EXACT string membership.

Usage:
  python3 scripts/verify_v521_apk.py [path-to-apk]
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
    o += function_count * 16
    o += (-o) % 4 + string_kind_count * 4
    o += (-o) % 4 + identifier_count * 4
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
        offset = (e >> 1) & 0x7FFFFF
        if length == 0xFF:
            idx = offset
            offset = overflow[idx * 2]
            length = overflow[idx * 2 + 1]
        if is_utf16:
            length *= 2
        raw = storage[offset:offset + length]
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
    print(f"v5.2.1 deep-verify: {apk}")

    # ── V521-0: manifest versionName ────────────────────────────────────
    vn = manifest_version_name(apk)
    check("V521-0 versionName is 5.2.1", vn == "5.2.1", f"versionName={vn}")

    with zipfile.ZipFile(apk) as z:
        names = z.namelist()
        bundle_name = next((n for n in names if n == "assets/index.android.bundle"), None)
        check("V521-P the Hermes bundle is present", bundle_name is not None)
        if not bundle_name:
            print(f"v5.2.1 verify: {len(failures)} FAILURE(S): {failures}")
            return 1
        try:
            strings = extract_strings(z.read(bundle_name))
        except ValueError as e:
            check("V521-P the bundle parses as Hermes hbc", False, str(e))
            print(f"v5.2.1 verify: {len(failures)} FAILURE(S): {failures}")
            return 1
        sset = set(strings)

        # ── V521-R1: the baked knowledge table + lexicons (regression) ──
        keypat = re.compile(r"^[a-z0-9 '’&(),.\-!?]{1,60}\|[a-z0-9 '’&(),.\-!?]{1,60}$")
        key_count = sum(1 for s in strings if keypat.match(s))
        check("V521-R1 baked recording keys inside the bundle", key_count >= 30_000, f"{key_count} title|artist keys")
        check("V521-R2 table __meta marker", "__meta" in sset)
        vader_tokens = ["zealot", "ungrateful", "welcoming", "catastrophe", "amazement", "screwed"]
        hits = sum(1 for t in vader_tokens if t in sset)
        check("V521-R3 VADER lexicon tokens inside the bundle", hits >= 5, f"{hits}/6 tokens")

        # ── V521-R4: the memory layer (regression, kept from v5.1.0) ────
        memory = {
            "V521-R4 SONG STORIES display": "song-story-line",
            "V521-R5 SONG STORIES editor": "Add a memory",
            "V521-R6 AUDIO BOOKMARKS service": "createBookmarks",
            "V521-R7 user-content database": "appcontent.db",
        }
        for name, marker in memory.items():
            check(name, marker in sset)

        # ── V521-R5: the v5.2.0 improvement arc (regression, kept) ──────
        arc = {
            "V521-R8 SQLite index names (Wave A1)": "idx_events_track_ts",
            "V521-R9 cipher-cache KV prefix (Wave A2)": "tsf.ytCipher.",
            "V521-R10 lazy-screen skeleton testID (Wave A3)": "lazy-screen-skeleton",
            "V521-R11 offline-queue storage key (Wave A4)": "tsf.queue.v1",
            "V521-R12 genre-haptics store key (Wave B2)": "tsf.hapticGenreMode.v1",
            "V521-R13 FTS5 notes statement (Wave C2)": "DELETE FROM personal_notes_fts WHERE entry_key = ?",
            "V521-R14 surprise button testID (Wave C3)": "surprise-me-btn",
            "V521-R15 parallax header-proxy key (Wave D1)": "fh-0",
        }
        for name, marker in arc.items():
            check(name, marker in sset)
        check("V521-R16 the HSWN lexicon rides the bundle", "aabhaaheen" in sset)

        # ── V521-A: the honesty wave (FIX-A2/A3) ────────────────────────
        honesty = {
            "V521-A1 the honest unpin toast (FIX-A3)": "REMOVED FROM YOUR CRATES",
            "V521-A2 the honest already-there toast (FIX-A2)": "ALREADY IN YOUR CRATES",
            "V521-A3 the honest download summary (FIX-A2)": "CRATE DOWNLOADED · ",
            "V521-A4 the honest partial summary (FIX-A2)": "CRATE PARTIAL · ",
            "V521-A5 the pinned-first Library marker (FIX-A3)": "PINNED · ",
        }
        for name, marker in honesty.items():
            check(name, marker in sset)
        # the FAKE literals are gone (the whole point of FIX-A2/A3)
        check("V521-A6 the fake added-toast literal is gone", "ADDED TO YOUR CRATES" not in sset)
        check("V521-A7 the fake downloading literal is gone", "DOWNLOADING CRATE…" not in sset)

        # ── V521-N: the network discipline (FIX-A4/A5 + D7) ─────────────
        check("V521-N1 the 10 s provider ceiling's error string (FIX-A4)",
              "provider fetch timeout after " in sset)
        check("V521-N2 the bounded-before-start abort (FIX-A4/A5)",
              "aborted before start" in sset)
        check("V521-N3 the po-token WebView's third origin (FIX-D7)",
              "https://jnn-pa.googleapis.com" in sset)

        # ── V521-M: the bounded-cache law (FIX-C2/C3) ───────────────────
        check("V521-M1 the BoundedMap construction law (FIX-C2/C3)",
              "BoundedMap cap must be a positive integer, got " in sset)

        # ── V521-G: the bulletin announces THIS release ─────────────────
        check("V521-G1 v5.2.1 bulletin key", "tsf.whatsNew.v5_2_1" in sset)
        check("V521-G2 THE HARDENING PASS bulletin", "TSF MUSIC 5.2.1 — THE HARDENING PASS" in sset)
        check("V521-G3 a sampled hardening bullet", "FAKE BUTTONS NOW DO REAL WORK \u2014 the collection heart adds every song you don't already love (and says exactly how many); the download button downloads the crate and reports the honest count; the crate pin REALLY pins \u2014 pinned crates list first in your library and survive restarts." in sset)
        check("V521-G4 the old bulletin key is retired", "tsf.whatsNew.v5_2_0" not in sset)

        # ── V521-H: mock hygiene (retained law) ─────────────────────────
        check("V521-H1 no webmock leak in the bundle", "webmocks/fixtures" not in sset
              and b"webmocks/fixtures" not in z.read(bundle_name))

    print()
    # V521-S — the verifier inventories ITSELF (the M5 lesson: deleting a
    # marker line was a SILENT loosening — the check merely stopped
    # running and the run stayed ALL GREEN. The executed-check count is
    # pinned; a check quietly removed or added anywhere is a RED.)
    PINNED_CHECK_COUNT = 35
    # (this line is the 35th executed check — the call-site args evaluate
    # BEFORE check() increments, so the condition is count+1 and the
    # detail shows the post-inventory number)
    check("V521-S the verifier executed its full pinned inventory",
          checks_run + 1 == PINNED_CHECK_COUNT, f"{checks_run + 1}/{PINNED_CHECK_COUNT}")
    if failures:
        print(f"v5.2.1 verify: {len(failures)} FAILURE(S): {failures}")
        return 1
    print("v5.2.1 verify: ALL GREEN — THE HARDENING PASS ships, sealed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
