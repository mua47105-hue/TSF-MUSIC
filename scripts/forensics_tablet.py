"""Deep forensics on the user's tablet screenshot (600x960).

Goals:
1. Where exactly does app content end (row-by-row variance scan)?
2. What color is the void, and is it uniform (OS letterbox) or textured
   (app content, e.g. scrollview, artwork)?
3. Is there a taskbar / system UI strip at the bottom? Status bar at top?
4. Column scan: does content span the FULL width or a centered window?
5. Detect a second boundary: maybe content ends and ANOTHER app / home
   screen / recents view lives below (that would mean split-screen).
"""
from PIL import Image
import numpy as np

p = "/home/z/my-project/upload/pasted_image_1788094785024.png"
im = Image.open(p).convert("RGB")
a = np.asarray(im).astype(int)
H, W = a.shape[:2]
print(f"image {W}x{H}")

# --- row-wise statistics -------------------------------------------------
# per-row std dev and mean brightness
row_std = a.std(axis=(1, 2))
row_mean = a.mean(axis=(1, 2))

# find rows that are "flat" (uniform color, std < 2) vs textured
flat = row_std < 2.0

# contiguous regions
def regions(mask):
    out = []
    start = None
    for i, v in enumerate(mask):
        if v and start is None:
            start = i
        elif not v and start is not None:
            out.append((start, i - 1))
            start = None
    if start is not None:
        out.append((start, len(mask) - 1))
    return out

flat_regs = regions(flat)
print("\n== uniform (std<2) row bands (start,end,len) ==")
for s, e in flat_regs:
    if e - s > 3:
        col = a[s : e + 1].reshape(-1, 3).mean(axis=0).astype(int)
        print(f"  y {s}-{e} (len {e-s+1}) color RGB{tuple(col)}")

# --- texture bands (content) --------------------------------------------
tex_regs = regions(~flat)
print("\n== textured (content) row bands ==")
for s, e in tex_regs:
    if e - s > 2:
        print(f"  y {s}-{e} (len {e-s+1})")

# --- dominant colors of bottom half -------------------------------------
print("\n== bottom half (y=480..960) row means sampled ==")
for y in range(480, H, 40):
    col = a[y]
    print(f"  y={y}: mean RGB{tuple(col.mean(axis=0).astype(int))} std {col.std(axis=0).mean():.1f}")

# --- column scan in the content zone (0..450) and void zone (500..900) ---
def colscan(y0, y1, label):
    seg = a[y0:y1]
    cs = seg.std(axis=(0, 2))
    print(f"\n== {label}: column std profile (min {cs.min():.1f} max {cs.max():.1f}) ==")
    marks = []
    for x in range(0, W, 50):
        marks.append(f"{x}:{cs[x]:.0f}")
    print("   " + " ".join(marks))

colscan(0, 440, "content zone y0-440")
colscan(500, 900, "void zone y500-900")

# --- find the last row with meaningful texture anywhere ------------------
last_tex = max([e for s, e in tex_regs], default=0)
first_tex_after_void = None
for s, e in tex_regs:
    if s > 500 and e - s > 3:
        first_tex_after_void = (s, e)
        break
print(f"\nlast textured row overall: {last_tex}")
print(f"first textured band below y=500: {first_tex_after_void}")

# --- exact colors at key locations --------------------------------------
print("\n== sampled pixels ==")
for (x, y) in [(300, 100), (300, 300), (300, 430), (300, 445), (300, 460), (300, 550), (300, 700), (300, 850), (300, 935), (300, 950)]:
    print(f"  ({x},{y}) RGB{tuple(a[y, x])}")

# --- where does the tab bar sit? look for near-black uniform band --------
print("\n== row std + mean around y=400..500 ==")
for y in range(400, 500, 4):
    print(f"  y={y}: std {row_std[y]:5.1f} mean {row_mean[y]:6.1f} RGB{tuple(a[y].mean(axis=0).astype(int))}")
