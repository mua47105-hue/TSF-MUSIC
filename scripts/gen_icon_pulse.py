#!/usr/bin/env python3
"""PULSE icon suite (v4.0) — editorial brutalism:
paper field, ink border frame, acid equalizer bars with the hard orange
offset shadow, TSF·M wordmark. Supersampled 4x for crisp edges.
Installs: assets/icon.png (1024), adaptive-icon.png (1024 fg),
splash.png (1284x2778-ish safe art), favicon.png (48).
"""
from PIL import Image, ImageDraw, ImageFont
import os

SS = 4
OUT = "/home/z/my-project/scripts/icon_variants"
os.makedirs(OUT, exist_ok=True)

PAPER = (244, 241, 234)
PAPER2 = (236, 234, 223)
INK = (22, 21, 19)
ACID = (217, 255, 61)
ORANGE = (255, 77, 0)

S = 1024 * SS

img = Image.new("RGB", (S, S), PAPER)
d = ImageDraw.Draw(img)

# outer ink frame (the broadsheet border)
m = int(S * 0.045)
d.rectangle([m, m, S - m, S - m], outline=INK, width=int(S * 0.02))

# the EQ mark: three acid bars on a shared ink base — hard shadows, zero radius
BASE = int(S * 0.66)          # shared baseline
bars = [(0.24, 0.42), (0.36, 0.30), (0.31, 0.35)]  # (top, height) — bottoms all hit BASE
bw = int(S * 0.10)
gap = int(S * 0.05)
x0 = int(S * 0.26)
off = int(S * 0.024)

for i, (top, h) in enumerate(bars):
    x = x0 + i * (bw + gap)
    y = int(S * top)
    hh = BASE - y
    d.rectangle([x + off, y + off, x + bw + off, y + hh + off], fill=ORANGE)  # shadow
    d.rectangle([x, y, x + bw, y + hh], fill=ACID, outline=INK, width=int(S * 0.009))

# ink base slab (the bars sit on it) + orange shadow
d.rectangle([x0 - int(S * 0.03) + off, BASE + off, x0 + 3 * bw + 2 * gap + int(S * 0.03) + off, BASE + int(S * 0.055) + off], fill=ORANGE)
d.rectangle([x0 - int(S * 0.03), BASE, x0 + 3 * bw + 2 * gap + int(S * 0.03), BASE + int(S * 0.055)], fill=INK, outline=INK)

# TSF·M wordmark on the base slab (paper text)
try:
    wfont = ImageFont.truetype('/home/z/my-project/TSF-MUSIC/assets/fonts/ArchivoBlack-400.ttf', int(S * 0.035))
except Exception:
    wfont = ImageFont.load_default()
d.text(((x0 - int(S * 0.03) + x0 + 3 * bw + 2 * gap + int(S * 0.03)) // 2, BASE + int(S * 0.0275)), 'TSF M', font=wfont, fill=PAPER, anchor='mm')

img = img.resize((1024, 1024), Image.LANCZOS)

# adaptive icon: same mark, safe-zone padded (no outer frame — the OS masks)
ad = Image.new("RGB", (1024, 1024), PAPER)
ad.save(f"{OUT}/adaptive-raw.png")

icon = img.copy()
icon.save("/home/z/my-project/TSF-MUSIC/assets/icon.png")

# adaptive foreground: mark centered at ~66% safe area
fg = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
mark = img.crop((int(1024 * 0.18), int(1024 * 0.18), int(1024 * 0.82), int(1024 * 0.82)))
fg.paste(mark, (int(1024 * 0.18), int(1024 * 0.18)))
fg.save("/home/z/my-project/TSF-MUSIC/assets/adaptive-icon.png")

# splash: paper field + the icon art centered (Expo contain-mode)
splash = Image.new("RGB", (1284, 2778), PAPER)
d2 = ImageDraw.Draw(splash)
art = img.resize((512, 512), Image.LANCZOS)
splash.paste(art, ((1284 - 512) // 2, (2778 - 512) // 2 - 120))
try:
    font = ImageFont.truetype("/home/z/my-project/TSF-MUSIC/assets/fonts/SpaceMono-700.ttf", 44)
except Exception:
    font = ImageFont.load_default()
d2.text((1284 // 2, (2778 // 2) + 240), "TSF MUSIC", font=font, fill=INK, anchor="mm")
splash.save("/home/z/my-project/TSF-MUSIC/assets/splash.png")

# favicon
img.resize((48, 48), Image.LANCZOS).save("/home/z/my-project/TSF-MUSIC/assets/favicon.png")

print("PULSE icon suite installed: icon/adaptive/splash/favicon")
