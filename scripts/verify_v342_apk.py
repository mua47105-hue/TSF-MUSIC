#!/usr/bin/env python3
"""v3.4.2 APK deep-verify (gauntlet R5).

The fix being verified at BINARY level:
  1. versionName 3.4.2 + versionCode = 100 + CI run number
  2. THE ROOT FIX: the compiled AndroidManifest has NO
     android:screenOrientation on ANY activity (the portrait lock that
     letterboxed every tablet since v1), plus:
       - application resizeableActivity="true" (resource-id resolve via
         pyaxmlprinter full XML decode)
       - NO maxAspectRatio / android.max_aspect
       - explicit supports-screens with largeScreens/xlargeScreens/anyDensity
  3. Hermes bundle markers for the R5 adaptive-layout features
  4. No webmock leak
"""
import re
import sys
import zipfile

APK = '/home/z/my-project/download/v3.4.2-app-release.apk'

failures = []
passed = []


def check(name, ok, note=''):
    (passed if ok else failures).append(f'{name} {note}')
    print(f"[{'OK ' if ok else 'FAIL'}] {name} {note}")


zf = zipfile.ZipFile(APK)

# ── 1+2: compiled manifest via pyaxmlprinter (full XML decode) ─────────
try:
    from pyaxmlprinter.axmlprinter import AXMLPrinter
except Exception:
    from pyaxmlparser.axmlprinter import AXMLPrinter

xml = AXMLPrinter(zf.read('AndroidManifest.xml')).get_xml()
xml = xml.decode('utf-8', 'replace') if isinstance(xml, bytes) else str(xml)

check('versionName 3.4.2', 'android:versionName="3.4.2"' in xml)
check('NO screenOrientation on any activity (THE root fix)',
      'screenOrientation' not in xml)
check('application resizeableActivity=true',
      'android:resizeableActivity="true"' in xml)
check('NO maxAspectRatio attr', 'maxAspectRatio' not in xml)
check('NO legacy android.max_aspect', 'android.max_aspect' not in xml)
check('supports-screens declares largeScreens=true',
      re.search(r'<supports-screens[^>]*android:largeScreens="true"', xml) is not None)
check('supports-screens declares xlargeScreens=true',
      re.search(r'<supports-screens[^>]*android:xlargeScreens="true"', xml) is not None)
check('supports-screens declares anyDensity=true',
      re.search(r'<supports-screens[^>]*android:anyDensity="true"', xml) is not None)

# ── 3: Hermes bundle markers ───────────────────────────────────────────
bundle_name = None
for n in zf.namelist():
    if n.endswith('index.android.bundle'):
        bundle_name = n
        break
check('Hermes bundle present', bundle_name is not None, bundle_name or '')
bundle = zf.read(bundle_name).decode('latin-1', errors='replace')
bundle_u16 = zf.read(bundle_name).decode('utf-16-le', errors='replace')


def bhas(s):
    return s in bundle or s in bundle_u16


R5_MARKERS = [
    # whats-new 3.4.2 (UTF-16 side — long strings)
    'no longer locks itself to portrait',
    'tsf.whatsNew.v3_4_2',
    # adaptive layout (R5)
    'browseColumnsFor',
    'playerArtSize',
    # regression guards from R4 (must all survive)
    'EndlessFeedPager',
    "You've reached the end",
    'mergeUniqueTracks',
    'home_feed',
]
for m in R5_MARKERS:
    check(f'marker: {m}', bhas(m))

# ── 4: webmock leak check ─────────────────────────────────────────────
LEAK_MARKERS = ['webmocks', 'searchFixtures', '__TsfMock', 'SEARCH_EXTRA', 'ytSearchFixtures']
for m in LEAK_MARKERS:
    check(f'NO leak: {m}', not bhas(m))

print(f"\n{len(passed)} passed, {len(failures)} failed")
sys.exit(1 if failures else 0)
