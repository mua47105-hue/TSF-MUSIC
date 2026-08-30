#!/usr/bin/env python3
"""v3.4.3 APK deep-verify (gauntlet R6).

The fix being verified at BINARY level:
  1. versionName 3.4.3 + versionCode > 151 (monotonic upgrade)
  2. THE ASPECT-CLAMP IMMUNITY (withWindowPolicy v3), all in the
     COMPILED AndroidManifest:
       - all four official PROPERTY_COMPAT opt-out <property> tags on
         <application>, each android:value="false":
           android.window.PROPERTY_COMPAT_ALLOW_USER_ASPECT_RATIO_OVERRIDE
           android.window.PROPERTY_COMPAT_ALLOW_MIN_ASPECT_RATIO_OVERRIDE
           android.window.PROPERTY_COMPAT_ALLOW_ORIENTATION_OVERRIDE
           android.window.PROPERTY_COMPAT_ALLOW_RESIZEABLE_ACTIVITY_OVERRIDES
       - android:maxAspectRatio="2.6" (full-bleed declaration for
         Samsung's legacy layer; stock ignores it while resizable)
       - legacy <meta-data android:name="android.max_aspect" 2.6>
       - application resizeableActivity="true"
       - NO screenOrientation on any activity (v3.4.2 fix, kept)
       - NO minAspectRatio restriction
  3. Hermes bundle marker for the 3.4.3 WhatsNew key

Usage:
  python3 scripts/verify_v343_apk.py [path-to-apk]
      (default: newest v3.4.3* APK in download/)
  python3 scripts/verify_v343_apk.py --sanity
      (prove the checks can FAIL by running them against the v3.4.2 APK)
"""
import glob
import re
import sys
import zipfile

PROPERTIES = [
    'android.window.PROPERTY_COMPAT_ALLOW_USER_ASPECT_RATIO_OVERRIDE',
    'android.window.PROPERTY_COMPAT_ALLOW_MIN_ASPECT_RATIO_OVERRIDE',
    'android.window.PROPERTY_COMPAT_ALLOW_ORIENTATION_OVERRIDE',
    'android.window.PROPERTY_COMPAT_ALLOW_RESIZEABLE_ACTIVITY_OVERRIDES',
]

failures = []
passed = []


def check(name, ok, note=''):
    (passed if ok else failures).append(f'{name} {note}')
    print(f"[{'OK ' if ok else 'FAIL'}] {name} {note}")


def manifest_xml(zf):
    try:
        from pyaxmlprinter.axmlprinter import AXMLPrinter
    except Exception:
        from pyaxmlparser.axmlprinter import AXMLPrinter
    xml = AXMLPrinter(zf.read('AndroidManifest.xml')).get_xml()
    return xml.decode('utf-8', 'replace') if isinstance(xml, bytes) else str(xml)


def run(apk_path, expect_version='3.4.3'):
    print(f'=== verifying {apk_path} ===')
    zf = zipfile.ZipFile(apk_path)
    xml = manifest_xml(zf)

    check(f'versionName {expect_version}', f'android:versionName="{expect_version}"' in xml)
    m = re.search(r'android:versionCode="(\d+)"', xml)
    vc = int(m.group(1)) if m else -1
    check('versionCode monotonic (> 151)', vc > 151, f'got {vc}')

    # THE FIX — compat-framework opt-outs
    for prop in PROPERTIES:
        pat = re.compile(
            r'<property[^>]*android:name="' + re.escape(prop) + r'"[^>]*android:value="false"'
        )
        pat_rev = re.compile(
            r'<property[^>]*android:value="false"[^>]*android:name="' + re.escape(prop) + r'"'
        )
        ok = bool(pat.search(xml) or pat_rev.search(xml))
        check(f'property {prop.rsplit(".", 1)[-1]}=false', ok)

    # full-bleed declarations
    check('android:maxAspectRatio="2.6"', 'android:maxAspectRatio="2.6"' in xml)
    check('legacy android.max_aspect meta = 2.6',
          re.search(r'<meta-data[^>]*android:name="android\.max_aspect"[^>]*android:value="2\.6"', xml)
          is not None
          or re.search(r'<meta-data[^>]*android:value="2\.6"[^>]*android:name="android\.max_aspect"', xml)
          is not None)

    # v3.4.2 fix retained
    check('NO screenOrientation on any activity', 'screenOrientation' not in xml)
    check('application resizeableActivity=true', 'android:resizeableActivity="true"' in xml)
    check('NO minAspectRatio restriction', 'minAspectRatio' not in xml)
    check('supports-screens largeScreens=true',
          re.search(r'<supports-screens[^>]*android:largeScreens="true"', xml) is not None)

    # Hermes bundle marker
    bundle_name = next((n for n in zf.namelist() if n.endswith('index.android.bundle')), None)
    check('Hermes bundle present', bundle_name is not None, bundle_name or '')
    if bundle_name:
        blob = zf.read(bundle_name)
        bundle = blob.decode('latin-1', errors='replace')
        bundle_u16 = blob.decode('utf-16-le', errors='replace')
        check('WhatsNew 3.4.3 seen-key in bundle',
              'tsf.whatsNew.v3_4_3' in bundle or 'tsf.whatsNew.v3_4_3' in bundle_u16)

    print(f'\n{len(passed)} OK, {len(failures)} FAIL')
    if failures:
        for f in failures:
            print('  FAIL:', f)
        sys.exit(1)
    print('ALL CHECKS PASSED')


if __name__ == '__main__':
    if '--sanity' in sys.argv:
        # The v3.4.2 APK must FAIL every fix-specific check — proves the
        # checks can actually detect absence.
        old = sorted(glob.glob('/home/z/my-project/download/v3.4.2-app-release.apk'))
        run(old[0], expect_version='3.4.2')
    else:
        args = [a for a in sys.argv[1:] if not a.startswith('--')]
        if args:
            run(args[0])
        else:
            cands = sorted(glob.glob('/home/z/my-project/download/*v3.4.3*.apk'))
            if not cands:
                print('no v3.4.3 APK found in download/ — pass a path explicitly')
                sys.exit(2)
            run(cands[-1])
