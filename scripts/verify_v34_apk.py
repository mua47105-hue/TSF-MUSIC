#!/usr/bin/env python3
"""Deep-verify the shipped v3.4.0 APK: versionName, bundle markers
(Search V2 + rescue ladder + YouTube source + window policy), manifest
window-policy attributes, webmocks-leak check."""
import re
import subprocess
import sys
import urllib.request
import os

URL = "https://github.com/mua47105-hue/TSF-MUSIC/releases/download/v3.4.0/app-release.apk"
OUT = "/tmp/app-release-v34.apk"

print("downloading APK...")
urllib.request.urlretrieve(URL, OUT)
print(f"size: {os.path.getsize(OUT)/1024/1024:.1f} MB")

subprocess.run(["rm", "-rf", "/tmp/apk34"], check=True)
subprocess.run(["unzip", "-o", "-q", OUT, "assets/index.android.bundle", "AndroidManifest.xml", "-d", "/tmp/apk34"], check=True)

bundle = open("/tmp/apk34/assets/index.android.bundle", "rb").read()
# Hermes stores short ASCII strings in the small-string table (MUTF-8) and
# longer/non-ASCII strings in the string table as UTF-16LE — search BOTH.
text = bundle.decode("utf-8", "replace") + bundle.decode("utf-16-le", "replace")

# manifest versionName via UTF-16 probe
man = open("/tmp/apk34/AndroidManifest.xml", "rb").read()
utf16 = man.decode("utf-16-le", "replace")
m = re.search(r"3\.4\.0", utf16)
print("manifest versionName 3.4.0:", "PASS" if m else "FAIL")

# window-policy attributes (config plugin output, UTF-16 in binary XML)
wp_resize = "resizeableActivity" in utf16
wp_ratio = "2.4" in utf16
print("manifest resizeableActivity present:", "PASS" if wp_resize else "WARN (binary attr form)")
print("manifest maxAspectRatio 2.4:", "PASS" if wp_ratio else "WARN (binary attr form)")

# v3.3.0 Search V2 markers (regression guard) + v3.4.0 markers
markers = [
    # ── Search V2 (v3.3, must survive the port) ──
    "searchLexicon", "getAutocomplete", "searchLyricByFragment",
    "lyricMatch", "Best guess", "LYRIC_MATCH", "YOUR_PAST_CLICK",
    "planSearch", "correctToken", "clusterKey", "Did you mean",
    "lrclib", "versionCount",
    # ── SIG rescue (v3.4) ──
    "runRescueLadder", "titleAuthorityMissing", "rescueRung",
    "AUTHORITY_FLOOR", "Found on YouTube", "Found via Apple Music",
    "Found under a different spelling", "Found via its album",
    "MATCHES_SEARCH",
    # ── YouTube source (v3.4) ──
    "ytSearchMusic", "ytResolveStream", "VISIONOS", "WEB_REMIX",
    "ANDROID_VR", "ytLastDiagnostics", "jnn-pa.googleapis.com",
    "GenerateIT", "mintPlayerPot", "signatureCipher",
    "ytRefreshStream",
    # ── never-blank + kill switch ──
    "secure resolver", "That YouTube track is unavailable",
    "taking a break after repeated failures",
    # composed template literal prefix (testID={\`source-toggle-${opt.key}\`})
    "source-toggle-",
]
ok = True
for mk in markers:
    present = mk in text
    ok = ok and present
    print(f"  marker {mk}: {'PASS' if present else 'FAIL'}")

leaks = ["webmocks", "searchFixtures", "__TsfMock", "SEARCH_EXTRA", "ytSearchFixtures"]
clean = True
for l in leaks:
    leaked = l in text
    clean = clean and not leaked
    print(f"  leak {l}: {'!!! LEAKED !!!' if leaked else 'clean'}")

print("hbc size:", f"{len(bundle)/1024/1024:.2f} MB")
verdict = ok and clean and m
print("VERDICT:", "PASS" if verdict else "FAIL")
sys.exit(0 if verdict else 1)
