#!/usr/bin/env python3
"""Probe the v5.2.1 bundle's string table for the honest markers."""
import types
import zipfile

src = open('scripts/verify_v521_apk.py').read().replace('sys.exit(main())', 'pass')
mod = types.ModuleType('v')
exec(compile(src, 'v', 'exec'), mod.__dict__)

with zipfile.ZipFile('/tmp/v521-app-release.apk') as z:
    strings = mod.extract_strings(z.read('assets/index.android.bundle'))

sset = set(strings)
for probe in ['BoundedMap', 'FAKE BUTTONS', 'NOTHING HANGS', 'PINNED', 'CRATE DOWNLOADED', 'provider fetch timeout', 'positive integer']:
    hits = [s for s in sset if probe in s]
    print(f'{probe!r}: {len(hits)} hits')
    for h in hits[:4]:
        print('   ', repr(h[:110]))
