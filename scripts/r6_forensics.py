#!/usr/bin/env python3
"""R6 forensics: fresh-eyes analysis of the tablet screenshot.
Goal: determine whether the app half is an OS letterbox WINDOW (chrome,
rounded corners, border) or an in-app layout artifact (hard edge, no chrome).
"""
from PIL import Image
import os

SRC = "/home/z/my-project/upload/pasted_image_1788094785024.png"
im = Image.open(SRC).convert("RGB")
W, H = im.size
print(f"size: {W}x{H}")

px = im.load()

# 1) Row-by-row "activity" profile: count non-uniform pixels per row
def row_signature(y):
    vals = [px[x, y] for x in range(0, W, 4)]
    return vals

def is_uniform_row(y, tol=2):
    vals = row_signature(y)
    mn = [min(v[i] for v in vals) for i in range(3)]
    mx = [max(v[i] for v in vals) for i in range(3)]
    return all(mx[i] - mn[i] <= tol for i in range(3)), mn, mx

prev_active = False
transitions = []
for y in range(0, H, 1):
    u, mn, mx = is_uniform_row(y)
    active = not u
    if active != prev_active:
        transitions.append((y, "active" if active else "uniform", mn, mx))
        prev_active = active

print("\nactive/uniform transitions (row, kind, minRGB, maxRGB):")
for t in transitions[:40]:
    print(f"  y={t[0]:4d} {t[1]:8s} mn={tuple(t[2])} mx={tuple(t[3])}")

# 2) Zoom the boundary band: find the tab bar bottom, then scan 12 rows around it
# First find the void: longest uniform stretch
best_start, best_len = 0, 0
cur_start, cur_len = 0, 0
for y in range(H):
    u, mn, mx = is_uniform_row(y)
    if u:
        if cur_len == 0:
            cur_start = y
        cur_len += 1
        if cur_len > best_len:
            best_start, best_len = cur_start, cur_len
    else:
        cur_len = 0
print(f"\nlongest uniform band: y={best_start}..{best_start+best_len-1} len={best_len}")
mid = best_start + best_len // 2
print(f"void mid color: {px[W//2, mid]}  left {px[10, mid]}  right {px[W-10, mid]}")

# 3) Look for a horizontal border/rounded-corner at the app->void boundary
bnd = None
for y in range(H):
    u, mn, mx = is_uniform_row(y)
    if not u:
        bnd = y  # last active row overall
print("\nscanning rows around last-active boundary for a border line:")
if bnd:
    for y in range(max(0, bnd - 8), min(H, bnd + 14)):
        vals = row_signature(y)
        mn = [min(v[i] for v in vals) for i in range(3)]
        mx = [max(v[i] for v in vals) for i in range(3)]
        spread = tuple(mx[i] - mn[i] for i in range(3))
        print(f"  y={y:4d} mn={tuple(mn)} mx={tuple(mx)} spread={spread}")

# 4) Column profile inside the void band: does the void span full width?
print("\nvoid horizontal extent check (row at void mid):")
y = mid
runs = []
run = None
for x in range(W):
    c = px[x, y]
    if run and abs(c[0]-run['c'][0])<=2 and abs(c[1]-run['c'][1])<=2 and abs(c[2]-run['c'][2])<=2:
        run['e'] = x
    else:
        if run: runs.append(run)
        run = {'s': x, 'e': x, 'c': c}
if run: runs.append(run)
runs.sort(key=lambda r: r['e']-r['s'], reverse=True)
for r in runs[:5]:
    print(f"  run x={r['s']}..{r['e']} len={r['e']-r['s']+1} color={r['c']}")

# 5) crops for VLM: boundary area at 2x, top area, taskbar area
bnd2 = bnd if bnd else best_start
im.crop((0, max(0, bnd2-160), W, min(H, bnd2+60))).resize((W*2, (min(H,bnd2+60)-max(0,bnd2-160))*2), Image.LANCZOS).save("/home/z/my-project/upload/_r6_boundary_2x.png")
im.crop((0, 0, W, 120)).resize((W*2, 240), Image.LANCZOS).save("/home/z/my-project/upload/_r6_top_2x.png")
im.crop((0, H-120, W, H)).resize((W*2, 240), Image.LANCZOS).save("/home/z/my-project/upload/_r6_bottom_2x.png")
print("\ncrops saved: _r6_boundary_2x.png, _r6_top_2x.png, _r6_bottom_2x.png")
