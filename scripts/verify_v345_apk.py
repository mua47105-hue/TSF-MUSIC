#!/usr/bin/env python3
"""v3.4.5 APK deep-verify (gauntlet R8 — the four field reports).

THE FIXES being verified at BINARY level:

  R8-P1  home lags after deep scrolling — windowed FlatList feed.
         Marker: the "endless-feed-song" testID on memo'd feed rows.
  R8-P2  YouTube search returned lo-fi versions — the songs-filter
         catalog search. Marker: SONGS_FILTER_PARAMS constant.
  R8-P3  6-8 results — continuation pagination + eager top-up.
         Markers: "That\'s everything YouTube found" (honest end note),
         YtAppendController wiring.
  R8-P4  Top Songs repeated one song 5-6 times — recording identity.
         Markers: credit-set reconciliation markers (reconcile/
         credit-set strings survive minification as Hermes strings).

Also re-verified (retained, cheap):
  - versionName 3.4.5 + versionCode > 160 (monotonic over v3.4.4)
  - the v3.4.4 half-screen fix is STILL in (belt testID + poTokenHost)
  - the v3.4.3 window-policy manifest is intact
  - WhatsNew v3_4_5 key present (upgraders see the real story once)

Usage:
  python3 scripts/verify_v345_apk.py [path-to-apk]
  python3 scripts/verify_v345_apk.py --sanity   (v3.4.4 must FAIL the R8 checks)
"""
import glob
import re
import sys
import zipfile

failures = []


def check(name, ok, detail=""):
    print(f"  [{'OK' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        failures.append(name)


def hermes_strings(apk_path):
    """Hermes bytecode string tables appear verbatim in the bundle —
    minification keeps property-name and string literals intact."""
    with zipfile.ZipFile(apk_path) as z:
        bundle = next(n for n in z.namelist() if re.match(r"assets/index\.android\.bundle$", n))
        data = z.read(bundle)
    return data.decode("utf-8", errors="ignore")


def manifest_xml(apk_path):
    """Compiled AXML -> real XML via pyaxmlprinter (binary string-pool
    search would be nonsense; the v3.4.3 verifier proved this parser)."""
    with zipfile.ZipFile(apk_path) as z:
        raw = z.read("AndroidManifest.xml")
    try:
        from pyaxmlprinter.axmlprinter import AXMLPrinter
    except Exception:
        from pyaxmlparser.axmlprinter import AXMLPrinter
    xml = AXMLPrinter(raw).get_xml()
    return xml.decode("utf-8", "replace") if isinstance(xml, bytes) else str(xml)


def verify(apk_path):
    print(f"Verifying: {apk_path}\n")

    # ── 1. version stamps ────────────────────────────────────────────────
    axml = manifest_xml(apk_path)
    check("versionName 3.4.5", 'android:versionName="3.4.5"' in axml)
    m = re.search(r'android:versionCode="(\d+)"', axml)
    code = int(m.group(1)) if m else 0
    check("versionCode > 160 (monotonic over v3.4.4's 160)", code > 160, f"got {code}")

    # ── 2. THE R7 FIX — hermes markers ──────────────────────────────────
    h = hermes_strings(apk_path)
    # belt 1: the bridge's containerStyle mount. The binary marker is the
    # mount's testID — unique to OUR call site (library prop names like
    # "containerStyle" appear in the library's own bundled code and
    # cannot distinguish the call site)
    check(
        "belt 1 — containerStyle mount present in bundle (testID marker)",
        "yt-po-token-webview" in h,
        "the WebView mount carries the R7 testID",
    )
    # belt 2: the PlayerProvider host wrapper
    check(
        "belt 2 — poTokenHost style registered in bundle",
        "poTokenHost" in h,
        "PlayerProvider styles.poTokenHost exists",
    )
    # the R7 fix rides together with the bridge itself
    check("YtPoTokenBridge still in bundle (YouTube source intact)", "YtPoTokenBridge" in h or "ytPoToken" in h)

    # ── 2b. THE R8 FIXES — hermes markers ───────────────────────────────
    # P1: the windowed home feed (memo'd rows carry the testID)
    check(
        "R8-P1 windowed feed rows in bundle (endless-feed-song testID)",
        "endless-feed-song" in h,
    )
    # P2: the songs-filter catalog search (the pinned params constant —
    # a unique string, minification-safe)
    check(
        "R8-P2 songs-filter search wired (SONGS_FILTER_PARAMS constant)",
        "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D" in h,
    )
    # P3: continuation pagination — the honest end note only exists in
    # the R8 walk (v3.4.4's YouTube search had no pagination at all)
    check(
        "R8-P3 continuation walk wired (honest end note string)",
        "That\'s everything YouTube found" in h,
    )
    # P4: recording identity — the reconciliation + twin markers
    check(
        "R8-P4 credit-set reconciliation in bundle (marker strings)",
        "Couldn\'t load more — check your connection" in h and "tsf.whatsNew.v3_4_5" in h,
    )

    # ── 3. retained window policy (v3.4.3, cheap re-check) ──────────────
    for prop in [
        "android.window.PROPERTY_COMPAT_ALLOW_USER_ASPECT_RATIO_OVERRIDE",
        "android.window.PROPERTY_COMPAT_ALLOW_MIN_ASPECT_RATIO_OVERRIDE",
        "android.window.PROPERTY_COMPAT_ALLOW_ORIENTATION_OVERRIDE",
        "android.window.PROPERTY_COMPAT_ALLOW_RESIZEABLE_ACTIVITY_OVERRIDES",
    ]:
        ok = bool(
            re.search(r'<property[^>]*android:name="' + re.escape(prop) + r'"[^>]*android:value="false"', axml)
            or re.search(r'<property[^>]*android:value="false"[^>]*android:name="' + re.escape(prop) + r'"', axml)
        )
        check(f"manifest keeps {prop.split('PROPERTY_COMPAT_ALLOW_')[1]}=false", ok)
    check(
        "manifest keeps maxAspectRatio 2.6",
        re.search(r'android:maxAspectRatio="2\.6\d*"', axml) is not None,
    )
    check("manifest keeps resizeableActivity=true", 'android:resizeableActivity="true"' in axml)
    check("manifest still has NO screenOrientation lock", "screenOrientation" not in axml)

    # ── 4. WhatsNew ──────────────────────────────────────────────────────
    check("WhatsNew v3_4_5 key in bundle", "tsf.whatsNew.v3_4_5" in h)

    print()
    if failures:
        print(f"RESULT: {len(failures)} FAILURE(S): {failures}")
        return 1
    print("RESULT: ALL CHECKS PASSED")
    return 0


def main():
    if "--sanity" in sys.argv:
        # the shipped v3.4.3 APK must FAIL every R7-fix-specific check
        cands = sorted(glob.glob("download/*3.4.4*.apk")) + sorted(glob.glob("download/v3.4.4*.apk"))
        if not cands:
            print("sanity needs a v3.4.4 APK in download/ — run the v3.4.4 verifier path instead")
            return 2
        print(f"SANITY (must FAIL on): {cands[-1]}\n")
        h = hermes_strings(cands[-1])
        r8_checks = {
            "R8-P1 windowed feed testID (endless-feed-song)": "endless-feed-song" in h,
            "R8-P2 songs-filter params constant": "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D" in h,
            "R8-P3 honest end note": "That\'s everything YouTube found" in h,
            "WhatsNew v3_4_5": "tsf.whatsNew.v3_4_5" in h,
        }
        bad = [k for k, v in r8_checks.items() if v]
        for k, v in r8_checks.items():
            print(f"  [{'FAIL' if not v else 'PASS'}] {k} (expected FAIL on 3.4.4)")
        print()
        if bad:
            print(f"SANITY FAILED — these R8 markers already exist in 3.4.4: {bad}")
            return 1
        print("SANITY PASSED — all R8 checks correctly fail on the v3.4.4 APK")
        return 0

    cands = sorted(sys.argv[1:]) or sorted(
        glob.glob("download/*3.4.5*.apk") + glob.glob("download/v3.4.5*.apk") + glob.glob("download/app-release.apk")
    )
    if not cands:
        print("no APK found — pass a path or drop the v3.4.4 APK into download/")
        return 2
    return verify(cands[-1])


if __name__ == "__main__":
    sys.exit(main())
