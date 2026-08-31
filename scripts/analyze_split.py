#!/usr/bin/env python3
"""Pixel-level analysis of the split-screen bug screenshots.
Finds the exact row where app content ends (black void begins)."""
from PIL import Image
import numpy as np
import os

def analyze(path):
    img = np.array(Image.open(path).convert('RGB')).astype(int)
    h, w, _ = img.shape
    # row-wise statistics: mean brightness and variance (content = bright/varied, void = near-black uniform)
    row_mean = img.mean(axis=(1, 2))
    row_std = img.std(axis=(1, 2))
    # The void is near-black AND uniform. Find the LAST row (scanning from bottom up)
    # that has meaningful content (mean > 12 or std > 8).
    content_rows = np.where((row_mean > 12) | (row_std > 8))[0]
    # System nav bar at very bottom has faint buttons; find the biggest black gap
    # Strategy: find largest contiguous run of "void" rows (mean < 10, std < 6)
    void_mask = (row_mean < 10) & (row_std < 6)
    best_start, best_len, cur_start, cur_len = -1, 0, -1, 0
    for y in range(h):
        if void_mask[y]:
            if cur_len == 0:
                cur_start = y
            cur_len += 1
            if cur_len > best_len:
                best_len, best_start = cur_len, cur_start
        else:
            cur_len = 0
    print(f"\n=== {path} ({w}x{h}) ===")
    if best_len > 20:
        gap_end = best_start + best_len
        print(f"  Largest void band: rows {best_start}..{gap_end-1} ({best_len}px = {100*best_len/h:.1f}% of height)")
        print(f"  App content ends (last content row above void): {best_start-1} -> {100*best_start/h:.1f}% of height")
        print(f"  Void ends at row {gap_end} ({100*gap_end/h:.1f}%), below that: {h-gap_end}px")
    else:
        print("  No large void found")
    # Print row profile every 5% for reference
    for pct in range(0, 101, 5):
        y = min(int(h * pct / 100), h - 1)
        print(f"    y={pct:3d}%: mean={row_mean[y]:6.1f} std={row_std[y]:6.1f}")

base = "/home/z/my-project/upload"
for p in ["itelp55/potraititelp55.jpg", "itelp55/potrait2itelp55.jpg",
          "oppopad/potrait.jpg", "oppopad/potrait1.jpg", "oppopad/potrait2.jpg",
          "oppopad/landscape.jpg"]:
    analyze(os.path.join(base, p))
