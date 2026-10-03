# WAVE 6 BARS — the share card + the weekly crate

The bar is Spotify. Not "a music app" — Spotify's own artifacts, judged side by side.

## 6a · THE SHARE CARD

**Bar:** Spotify's song share card — the image that lands in a chat when you
share a track. Artwork dominant, song + artist legible at a glance, one brand
mark. A stranger who has never seen the app must understand it in under 2
seconds inside a WhatsApp thread.

**Our edge (must be visible, not claimed):** the card carries the exact
moment — the active synced-lyric line — because we know what is being sung
right now. Spotify's card cannot do that.

**Measurable halves:**
- 1080px-class image lands in the native share sheet (expo-sharing), not text
- artwork, title, artist, brand all present; nothing clipped; PULSE contract
  (zero radius, hard offset shadow, Archivo Black display, mono kickers)
- ANY capture failure falls back to today's text share — the button can never
  regress below v4.0.5 behavior
- web build never crashes on the capture path (guard + fallback)

**Verification:** locks (cardSpec), web E2E walkthrough (card mounts, no page
errors), fresh-context blind critic on the rendered card PNG vs the bar.

## 6b · THE WEEKLY CRATE

**Bar:** Spotify Discover Weekly — ONE edition, ~30 tracks, refreshed on a
week boundary, discovery is the soul (you must not have heard most of it),
and every track feels chosen. The retention killer feature.

**Measurable halves:**
- exactly one crate per ISO week (same week → same crate, restart survives it)
- 30 tracks max: 35% core anchors / 40% co-play neighborhood / 25% unheard
  discovery — discovery weighted higher than any daily surface
- ≤30% overlap with the previous week's crate
- honest reason line on every track (reasonLine, no blank reasons)
- cold profile → honest empty (shelf hidden, never a crash, never filler)
- every track passes the same safety filter as every other surface

**Verification:** locks (rollover, overlap ratio, cap, cold start), web E2E
(warm the ledger by playing, crate appears with reasons; cold → hidden),
blind critic on the engine's decisions (picks must be defensible from the
ledger, not random).

## Loop discipline

Builder + separate fresh-context critic per piece. Critic inspects the actual
artifact (PNG / engine decisions), compares against the bar blind, names the
single biggest remaining gap. Exit when the critic picks ours blind.
