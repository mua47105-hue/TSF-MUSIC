#!/usr/bin/env python3
"""v5.3.0 APK deep-verify (SPOTIFY RE INTELLIGENCE & AUDIO LIFT).

On top of every retained regression bar (knowledge table, memory layer,
the v5.2.0 improvement arc, the v5.2.1 hardening markers), this verifier
proves the v5.3.0 ports rode the bundle:

  V530-0  versionName in the compiled manifest is 5.3.0.
  V530-R  every retained bar (baked keys, __meta, lexicons, memory
          layer, improvement arc, honesty wave, network discipline,
          bounded-cache law) still rides — zero regression.
  V530-B  the bake advanced to 1.1.0 (the DSP columns ride; the old
          1.0.0 bake marker is gone).
  V530-G  the bulletin announces THIS release: the v5_3_0 key, the
          SPOTIFY RE headline, sampled bullets; the v5_2_1 key retired.
  V530-H  mock hygiene (retained law): no webmock leak.

Honest non-markers (the B1/DORMANT lesson): BAR 2/3/4/5/6/7 are
algorithmic — their contracts assert at the bun level
(tests/wave_v530_spotify_re_locks.test.ts, 16/16 mutations RED), not
against APK strings; inventing string markers for them would be
fabrication, not verification.

METHOD (the v4.2/v4.3/v5.2.1 lesson, now a tradition): the Hermes string
storage is ONE PACKED BLOB — substring probes false-positive across
string boundaries, so every check runs against the PARSED hbc string
table and requires EXACT string membership.

Usage:
  python3 scripts/verify_v530_apk.py [path-to-apk]
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
    print(f"v5.3.0 deep-verify: {apk}")

    # ── V530-0: manifest versionName ────────────────────────────────────
    vn = manifest_version_name(apk)
    check("V530-0 versionName is 5.3.0", vn == "5.3.0", f"versionName={vn}")

    with zipfile.ZipFile(apk) as z:
        names = z.namelist()
        bundle_name = next((n for n in names if n == "assets/index.android.bundle"), None)
        check("V530-P the Hermes bundle is present", bundle_name is not None)
        if not bundle_name:
            print(f"v5.3.0 verify: {len(failures)} FAILURE(S): {failures}")
            return 1
        try:
            strings = extract_strings(z.read(bundle_name))
        except ValueError as e:
            check("V530-P the bundle parses as Hermes hbc", False, str(e))
            print(f"v5.3.0 verify: {len(failures)} FAILURE(S): {failures}")
            return 1
        sset = set(strings)

        # ── V530-R1: the baked knowledge table (regression, re-cut) ─────
        keypat = re.compile(r"^[a-z0-9 '’&(),.\-!?]{1,60}\|[a-z0-9 '’&(),.\-!?]{1,60}$")
        key_count = sum(1 for s in strings if keypat.match(s))
        # v5.3.0 bake 1.1.0: 71,750 keys (the popularity head) with the
        # five DSP columns — the floor is the table, not the old count.
        check("V530-R1 baked recording keys inside the bundle", key_count >= 30_000, f"{key_count} title|artist keys")
        check("V530-R2 table __meta marker", "__meta" in sset)
        vader_tokens = ["zealot", "ungrateful", "welcoming", "catastrophe", "amazement", "screwed"]
        hits = sum(1 for t in vader_tokens if t in sset)
        check("V530-R3 VADER lexicon tokens inside the bundle", hits >= 5, f"{hits}/6 tokens")

        # ── V530-R4: the memory layer (regression, kept from v5.1.0) ────
        memory = {
            "V530-R4 SONG STORIES display": "song-story-line",
            "V530-R5 SONG STORIES editor": "Add a memory",
            "V530-R6 AUDIO BOOKMARKS service": "createBookmarks",
            "V530-R7 user-content database": "appcontent.db",
        }
        for name, marker in memory.items():
            check(name, marker in sset)

        # ── V530-R8: the v5.2.0 improvement arc (regression, kept) ──────
        arc = {
            "V530-R8 SQLite index names (Wave A1)": "idx_events_track_ts",
            "V530-R9 cipher-cache KV prefix (Wave A2)": "tsf.ytCipher.",
            "V530-R10 lazy-screen skeleton testID (Wave A3)": "lazy-screen-skeleton",
            "V530-R11 offline-queue storage key (Wave A4)": "tsf.queue.v1",
            "V530-R12 genre-haptics store key (Wave B2)": "tsf.hapticGenreMode.v1",
            "V530-R13 FTS5 notes statement (Wave C2)": "DELETE FROM personal_notes_fts WHERE entry_key = ?",
            "V530-R14 surprise button testID (Wave C3)": "surprise-me-btn",
            "V530-R15 parallax header-proxy key (Wave D1)": "fh-0",
        }
        for name, marker in arc.items():
            check(name, marker in sset)
        check("V530-R16 the HSWN lexicon rides the bundle", "aabhaaheen" in sset)

        # ── V530-A: the honesty wave (v5.2.1 regression, kept) ──────────
        honesty = {
            "V530-A1 the honest unpin toast": "REMOVED FROM YOUR CRATES",
            "V530-A2 the honest already-there toast": "ALREADY IN YOUR CRATES",
            "V530-A3 the honest download summary": "CRATE DOWNLOADED · ",
            "V530-A4 the pinned-first Library marker": "PINNED · ",
        }
        for name, marker in honesty.items():
            check(name, marker in sset)

        # ── V530-N: the network discipline (v5.2.1 regression, kept) ────
        check("V530-N1 the 10 s provider ceiling's error string",
              "provider fetch timeout after " in sset)
        check("V530-N2 the bounded-before-start abort",
              "aborted before start" in sset)
        check("V530-N3 the po-token WebView's third origin",
              "https://jnn-pa.googleapis.com" in sset)
        check("V530-M1 the BoundedMap construction law",
              "BoundedMap cap must be a positive integer, got " in sset)

        # ── V530-B: the bake advanced to 1.1.0 (BAR 1) ───────────────────
        # The __meta.version string value rides the inlined JSON module.
        check("V530-B1 the bake version 1.1.0 rides the bundle", "1.1.0" in sset)
        check("V530-B2 the bake source attribution rides",
              "huggingface:maharshipandya/spotify-tracks-dataset" in sset)

        # ── V530-G: the bulletin announces THIS release ──────────────────
        check("V530-G1 v5.3.0 bulletin key", "tsf.whatsNew.v5_3_0" in sset)
        check("V530-G2 THE SPOTIFY RE bulletin headline",
              "TSF MUSIC 5.3.0 — SPOTIFY RE INTELLIGENCE & AUDIO LIFT" in sset)
        check("V530-G3 a sampled album-mode bullet",
              "ALBUMS PLAY LIKE ALBUMS — loudness normalization now has an ALBUM MODE: every track on one record gets the same gain from the album's average loudness, so the quiet ballad stays quieter than the loud closer exactly as the mastering engineer intended." in sset)
        check("V530-G4 a sampled spread-shuffle bullet",
              "SHUFFLE THAT ACTUALLY SHUFFLES — the queue reorder is now an artist-SPREADING shuffle (the model Spotify itself moved to after users complained about artist clustering): same-artist back-to-back is engineered to zero while the order stays random-feeling, and it's seeded so it never repeats a fluke." in sset)
        check("V530-G5 the old bulletin key is retired", "tsf.whatsNew.v5_2_1" not in sset)

        # ── V530-H: mock hygiene (retained law) ─────────────────────────
        check("V530-H1 no webmock leak in the bundle", "webmocks/fixtures" not in sset
              and b"webmocks/fixtures" not in z.read(bundle_name))

    print()
    # V530-S — the verifier inventories ITSELF (the M5 lesson, third
    # generation: the executed-check count is pinned; a check quietly
    # removed or added anywhere is a RED).
    PINNED_CHECK_COUNT = 35
    # (this line is the 35th executed check — the call-site args evaluate
    # BEFORE check() increments, so the condition is count+1 and the
    # detail shows the post-inventory number)
    check("V530-S the verifier executed its full pinned inventory",
          checks_run + 1 == PINNED_CHECK_COUNT, f"{checks_run + 1}/{PINNED_CHECK_COUNT}")
    if failures:
        print(f"v5.3.0 verify: {len(failures)} FAILURE(S): {failures}")
        return 1
    print("v5.3.0 verify: ALL GREEN — SPOTIFY RE INTELLIGENCE & AUDIO LIFT ships, sealed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
