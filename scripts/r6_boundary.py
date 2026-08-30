#!/usr/bin/env python3
"""Detail scan: rows around the app->void boundary (y~447) and void top/bottom edges."""
from PIL import Image

SRC = "/home/z/my-project/upload/pasted_image_1788094785024.png"
im = Image.open(SRC).convert("RGB")
W, H = im.size
px = im.load()

def col_mn_mx_row(y):
    vals = [px[x, y] for x in range(W)]
    mn = [min(v[i] for v in vals) for i in range(3)]
    mx = [max(v[i] for v in vals) for i in range(3)]
    return mn, mx

print("=== rows 438..478 (app->void boundary) ===")
for y in range(438, 479):
    mn, mx = col_mn_mx_row(y)
    print(f"  y={y:4d} mn={tuple(mn)} mx={tuple(mx)}")

print("\n=== rows 905..959 (void->taskbar boundary) ===")
for y in range(905, 960):
    mn, mx = col_mn_mx_row(y)
    print(f"  y={y:4d} mn={tuple(mn)} mx={tuple(mx)}")

# vertical profile at a few x positions across the boundary
print("\n=== vertical pixel columns x=6,300,593 at y=440..470 ===")
for x in (6, 300, 593):
    col = [px[x, y] for y in range(440, 471)]
    print(f" x={x}: {col}")
