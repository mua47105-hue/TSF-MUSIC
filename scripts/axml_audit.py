#!/usr/bin/env python3
"""Download shipped release APKs and fully decode their compiled
AndroidManifest.xml (AXML) — dump every element + attribute with typed
values, then diff v3.3.0 vs v3.4.0 vs v3.4.1.

This is the ground truth for what the OS actually sees on the tablets.
"""
import io, json, os, re, struct, sys, urllib.request, zipfile

TOKEN = None
# token from git remote
url = os.popen("git -C /home/z/my-project config --get remote.origin.url").read().strip()
m = re.search(r'https://([^:]+):([^@]+)@', url)
if m:
    TOKEN = m.group(2)

REPO = 'mua47105-hue/TSF-MUSIC'
OUT = '/home/z/my-project/download/_apk_audit'
os.makedirs(OUT, exist_ok=True)

def api(path):
    req = urllib.request.Request(f'https://api.github.com/repos/{REPO}/{path}',
        headers={'Authorization': f'token {TOKEN}', 'Accept': 'application/vnd.github+json'})
    return json.load(urllib.request.urlopen(req))

# ---- list releases & assets -------------------------------------------------
rels = api('releases?per_page=10')
want = {}
for rel in rels:
    tag = rel['tag_name']
    for a in rel.get('assets', []):
        if a['name'].endswith('.apk'):
            want[tag] = a['browser_download_url']

print('releases found:', list(want))
targets = [t for t in ('v3.3.0', 'v3.4.0', 'v3.4.1') if t in want]
for tag in targets:
    dest = os.path.join(OUT, f'{tag}.apk')
    if os.path.exists(dest) and os.path.getsize(dest) > 10_000_000:
        print(tag, 'already downloaded', os.path.getsize(dest))
        continue
    req = urllib.request.Request(want[tag], headers={'Authorization': f'token {TOKEN}'})
    with urllib.request.urlopen(req) as r, open(dest, 'wb') as f:
        f.write(r.read())
    print(tag, 'downloaded', os.path.getsize(dest))

# ---- AXML parser ------------------------------------------------------------
ARSC = {}

def parse_string_pool(buf, off):
    (ctype, hsize, ssize, scount, stcount, flags, strstart, _) = struct.unpack_from('<HHIIIIII', buf, off)
    is_utf8 = bool(flags & (1 << 8))
    strings = []
    abs_str_start = off + strstart
    for i in range(scount):
        o = abs_str_start + struct.unpack_from('<I', buf, off + 28 + i * 4)[0]
        if is_utf8:
            # u8 len (may be 2 bytes), then byte len, then bytes
            def u8len(p):
                b = buf[p]
                if b & 0x80:
                    return ((b & 0x7F) << 8) | buf[p + 1], p + 2
                return b, p + 1
            n1, p = u8len(o)      # char count
            n2, p = u8len(p)      # byte count
            s = buf[p:p + n2].decode('utf-8', 'replace')
        else:
            def u16len(p):
                b = struct.unpack_from('<H', buf, p)[0]
                if b & 0x8000:
                    return ((b & 0x7FFF) << 16) | struct.unpack_from('<H', buf, p + 2)[0], p + 4
                return b, p + 2
            n, p = u16len(o)
            s = buf[p:p + n * 2].decode('utf-16-le', 'replace')
        strings.append(s)
    return strings

def format_value(vtype, data, raw, strings):
    if vtype == 0x03:  # string
        return repr(strings[data]) if data < len(strings) else f'str@{data}'
    if vtype == 0x12:  # boolean
        return 'true' if data else 'false'
    if vtype == 0x10:  # int dec
        return str(data if data < 2**31 else data - 2**32)
    if vtype == 0x11:
        return hex(data)
    if vtype == 0x01:  # reference
        return f'@ref/{hex(data)}'
    if vtype == 0x02:
        return f'@attr/{hex(data)}'
    if vtype == 0x05:  # dimension
        unit = ['px', 'dip', 'sp', 'pt', 'in', 'mm'][data & 0xF]
        radix = data >> 4 & 0x3
        mant = data >> 8
        return f'{mant}{unit}'
    if raw is not None and raw < len(strings):
        return repr(strings[raw])
    return f'type{vtype:02x}:0x{data:08x}'

SCREEN_ORIENT = {-1:'unspecified',0:'landscape',1:'portrait',2:'user',3:'behind',4:'sensor',
                 5:'nosensor',6:'sensorLandscape',7:'sensorPortrait',8:'reverseLandscape',
                 9:'reversePortrait',10:'userLandscape',11:'userPortrait',12:'fullSensor',
                 13:'userNoSensor',14:'locked'}

def parse_axml(buf):
    strings = []
    off = 8
    elements = []   # (depth, name, attrs[(ns,name,value_str)])
    depth = 0
    while off < len(buf):
        ctype, hsize, ssize = struct.unpack_from('<HHI', buf, off)
        if ctype == 0x0001 and hsize == 28:  # RES_STRING_POOL_TYPE
            strings = parse_string_pool(buf, off)
        elif ctype == 0x0102:  # START_ELEMENT
            nsn = struct.unpack_from('<I', buf, off + 16)[0]
            nameidx = struct.unpack_from('<I', buf, off + 20)[0]
            acount = struct.unpack_from('<H', buf, off + 26)[0]
            name = strings[nameidx] if nameidx < len(strings) else f'?{nameidx}'
            attrs = []
            abase = off + 36
            for i in range(acount):
                a_ns, a_name, a_raw, a_vtype, _res, a_data = struct.unpack_from('<IIIIII', buf, abase + i * 20)
                aname = strings[a_name] if a_name < len(strings) else f'?{a_name}'
                raw = a_raw if (a_raw != 0xFFFFFFFF and a_raw < len(strings)) else None
                val = format_value(a_vtype, a_data, a_raw, strings)
                nsname = None
                if a_ns != 0xFFFFFFFF and a_ns < len(strings):
                    nsname = strings[a_ns]
                attrs.append((nsname, aname, val))
            elements.append(('open', depth, name, attrs))
            depth += 1
        elif ctype == 0x0103:  # END_ELEMENT
            depth -= 1
            nameidx = struct.unpack_from('<I', buf, off + 20)[0]
            elements.append(('close', depth, strings[nameidx] if nameidx < len(strings) else '?', []))
        off += ssize
    return elements

def dump_manifest(apk_path):
    from pyaxmlparser.axmlprinter import AXMLPrinter
    zf = zipfile.ZipFile(apk_path)
    buf = zf.read('AndroidManifest.xml')
    xml = AXMLPrinter(buf).get_xml().decode('utf-8', 'replace') if isinstance(
        AXMLPrinter(buf).get_xml(), bytes) else str(AXMLPrinter(buf).get_xml())
    return xml

for tag in targets:
    p = os.path.join(OUT, f'{tag}.apk')
    if not os.path.exists(p):
        continue
    out = os.path.join(OUT, f'{tag}-manifest.txt')
    with open(out, 'w') as f:
        f.write(dump_manifest(p))
    print('wrote', out)
