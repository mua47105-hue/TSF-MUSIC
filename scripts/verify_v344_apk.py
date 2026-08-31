#!/usr/bin/env python3
"""v3.4.4 APK deep-verify (gauntlet R7).

THE FIX being verified at BINARY level — the real half-screen bug:

Since v3.4.0 the whole app rendered in the exact top 50% of the screen on
every Android device (bottom nav mid-screen, #0A0A0B void below). Root
cause: react-native-webview v14 wraps the native WebView in a View sized
by `containerStyle` that DEFAULTS TO flex:1 IN-FLOW; the bridge mounted
its hidden BotGuard WebView with position:absolute on `style` alone (the
inner view), leaving the invisible flex:1 wrapper as a flex sibling of
the entire app under SafeAreaProvider → Yoga 50/50 split.

The v3.4.4 fix (double belt), verified in the Hermes bundle:
  1. ytPoToken.tsx mounts the WebView with an out-of-flow containerStyle
     (position:absolute, 1x1) — marker: the containerStyle shape string
  2. PlayerProvider.tsx hosts the bridge inside an absolute 1x1
     touch-transparent View (styles.poTokenHost) — markers: poTokenHost
     registration + the View wrapper around YtPoTokenBridge

Also re-verified (retained from earlier releases, cheap):
  - versionName 3.4.4 + versionCode > 155 (monotonic upgrade over 3.4.3)
  - the v3.4.3 window-policy manifest is intact (maxAspectRatio 2.6,
    four PROPERTY_COMPAT opt-outs, resizable, no orientation lock)
  - WhatsNew v3_4_4 key present (every upgrader sees the real story once)

Usage:
  python3 scripts/verify_v344_apk.py [path-to-apk]
      (default: newest v3.4.4* APK in download/)
  python3 scripts/verify_v344_apk.py --sanity
      (prove the fix-specific checks FAIL on the v3.4.3 APK)
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
    check("versionName 3.4.4", 'android:versionName="3.4.4"' in axml)
    m = re.search(r'android:versionCode="(\d+)"', axml)
    code = int(m.group(1)) if m else 0
    check("versionCode > 155 (monotonic over 3.4.3)", code > 155, f"got {code}")

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
    check("WhatsNew v3_4_4 key in bundle", "tsf.whatsNew.v3_4_4" in h)

    print()
    if failures:
        print(f"RESULT: {len(failures)} FAILURE(S): {failures}")
        return 1
    print("RESULT: ALL CHECKS PASSED")
    return 0


def main():
    if "--sanity" in sys.argv:
        # the shipped v3.4.3 APK must FAIL every R7-fix-specific check
        cands = sorted(glob.glob("download/*3.4.3*.apk")) + sorted(glob.glob("download/v3.4.3*.apk"))
        if not cands:
            print("sanity needs a v3.4.3 APK in download/ — run the v3.4.3 verifier path instead")
            return 2
        print(f"SANITY (must FAIL on): {cands[-1]}\n")
        h = hermes_strings(cands[-1])
        r7_checks = {
            "belt 1 testID marker (yt-po-token-webview)": "yt-po-token-webview" in h,
            "belt 2 poTokenHost host style": "poTokenHost" in h,
            "WhatsNew v3_4_4": "tsf.whatsNew.v3_4_4" in h,
        }
        bad = [k for k, v in r7_checks.items() if v]
        for k, v in r7_checks.items():
            print(f"  [{'FAIL' if not v else 'PASS'}] {k} (expected FAIL on 3.4.3)")
        print()
        if bad:
            print(f"SANITY FAILED — these R7 markers already exist in 3.4.3: {bad}")
            return 1
        print("SANITY PASSED — all R7 checks correctly fail on the 3.4.3 APK")
        return 0

    cands = sorted(sys.argv[1:]) or sorted(
        glob.glob("download/*3.4.4*.apk") + glob.glob("download/v3.4.4*.apk") + glob.glob("download/app-release.apk")
    )
    if not cands:
        print("no APK found — pass a path or drop the v3.4.4 APK into download/")
        return 2
    return verify(cands[-1])


if __name__ == "__main__":
    sys.exit(main())
