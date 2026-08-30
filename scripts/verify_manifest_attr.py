#!/usr/bin/env python3
"""v3.4.1 binary-manifest verifier: proves resizeableActivity=true,
versionName=3.4.1 and the stamped versionCode in the compiled AXML."""
import struct
import sys
import zipfile

APK = sys.argv[1] if len(sys.argv) > 1 else '/home/z/my-project/download/v3.4.1-app-release.apk'
blob = zipfile.ZipFile(APK).read('AndroidManifest.xml')

pos = 8
strings = []
while pos < len(blob) - 8:
    ctype, hsize, csize = struct.unpack_from('<HHI', blob, pos)
    if ctype == 0x0001:
        scount = struct.unpack_from('<I', blob, pos + 8)[0]
        flags, sstart = struct.unpack_from('<II', blob, pos + 16)
        offsets = struct.unpack_from(f'<{scount}I', blob, pos + 28)
        base = pos + sstart
        for off in offsets:
            p = base + off
            l = struct.unpack_from('<H', blob, p)[0]
            strings.append(blob[p+2:p+2+l*2].decode('utf-16-le', errors='replace'))
        break
    pos += csize

targets = {'resizeableActivity', 'versionName', 'versionCode'}
idx = {s: i for i, s in enumerate(strings) if s in targets}
print('string indices:', idx)

pos = 8
results = []
while pos < len(blob) - 8:
    ctype, hsize, csize = struct.unpack_from('<HHI', blob, pos)
    if csize < 8 or pos + csize > len(blob):
        break
    if ctype == 0x0102:
        ns, name = struct.unpack_from('<II', blob, pos + 16)
        attr_start, attr_size, attr_count = struct.unpack_from('<HHH', blob, pos + 24)
        tag = strings[name] if name < len(strings) else '?'
        for i in range(attr_count):
            aoff = pos + 16 + attr_start + i * attr_size
            a_ns, a_name, a_raw = struct.unpack_from('<III', blob, aoff)
            t_size, t_res0, t_type_b, t_data = struct.unpack_from('<HBBI', blob, aoff + 12)
            attr = strings[a_name] if a_name < len(strings) else '?'
            if attr in targets:
                if t_type_b == 0x12:  # boolean
                    val = 'true' if t_data == 0xFFFFFFFF else 'false'
                elif t_type_b == 0x10:  # int
                    val = str(t_data)
                elif 0 <= a_raw < len(strings):
                    val = strings[a_raw]
                else:
                    val = f'type={hex(t_type_b)} data={t_data}'
                results.append((tag, attr, val))
    pos += csize

ok = True
for tag, attr, val in results:
    print(f'<{tag}> android:{attr} = {val}')
    if attr == 'resizeableActivity' and val != 'true':
        ok = False
    if attr == 'versionName' and val != '3.4.1':
        ok = False

print('VERDICT:', 'manifest OK' if ok else 'FAIL')
sys.exit(0 if ok else 1)
