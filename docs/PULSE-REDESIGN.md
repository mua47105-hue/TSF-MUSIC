# PULSE — the TSF Music redesign spec (v4.0)

The design contract for the v4.0 UI overhaul. The bar is
`prototype-2-pulse.html` (Prototype 02 / Pulse): every screen is judged
side-by-side against it at 390×844, 834×1120 and 1440×900. The prototype
wins every tie.

## Identity

**PULSE — editorial brutalism.** The app becomes a broadsheet: paper,
ink, acid, orange. Type is the interface. Zero radius anywhere in the
app chrome. Hard offset shadows instead of blurs. Everything uppercase
that is a label; everything huge that is a title.

| Token | Value | Role |
|---|---|---|
| `paper` | `#F4F1EA` | base canvas |
| `paper2` | `#ECEADF` | dimmed surfaces, wells |
| `ink` | `#161513` | text, borders, ink panels |
| `ink60` | `rgba(22,21,19,.62)` | secondary text |
| `ink40` | `rgba(22,21,19,.60)` | tertiary text, icons at rest |
| `acid` | `#D9FF3D` | active, play, fill, "on" states |
| `orange` | `#FF4D00` | accents, shadows on ink, liked, active dot |
| `orangeDeep` | `#C23A00` | kickers |
| `rule` | `#161513` | hard rules (2px) |
| `ruleSoft` | `rgba(22,21,19,.16)` | row separators (1px) |
| `shadow` | `rgba(22,21,19,.78)` | offset shadow fill |

Legacy Spotify tokens in `theme.ts` are re-pointed (bg→paper, card→paper2,
accent→orange, accentBright→acid, text→ink, textDim→ink60…) so any
surface not yet migrated still lands on-brand.

**Typography** (replaces Figtree as UI face; Figtree files stay for the
ONB/legacy fallbacks):

- Archivo 400/500/600/700 — body, rows, titles
- Archivo Black — display (mastheads, heroes, player title)
- Space Mono 400/700 — kickers, meta, index numbers, buttons, tab labels

Mono style: uppercase, letterSpacing 0.08–0.22em, sizes 8.5–11px.
Display: uppercase, lineHeight .95–.98, letterSpacing −0.015em.

**Geometry**: radius 0 everywhere (sheets may use 0 — no rounding at
all). Borders 1.5px (cards/art) and 2px (structural). Shadows: hard,
no blur — `2–6px 2–6px 0 shadow` (orange shadow when sitting on ink).

## Motion rules

- Micro press: translate(2,2) + shadow collapse, 110–150ms, native
  driver (replaces scale — brutalism presses *into* the paper).
- Cards hover/press: lift −2,−2 with orange shadow (web) / press-in
  (native).
- Sheets (player, queue): slide 400–500ms `cubic-bezier(.3,.9,.3,1)`
  → RN `Easing.out(Easing.cubic)` approximated as `Easing.bezier(.3,.9,.3,1)`.
- Result reveal: riseIn 450ms (opacity + translateY 14→0).
- Ticker: continuous marquee, 26s loop, native driver, pauses never.
- EQ bars: 3-bar loop 900ms, staggered 200ms, runs only while playing.
- MINDBEAT pipeline: 5 stages × 540ms, acid highlight per stage.
- No BlurViews. No new native deps. Built-in Animated only.

## Screens (prototype = spec)

| App screen | Prototype section | Notes |
|---|---|---|
| HomeScreen | Front Page | masthead (edition + Vol + greeting w/ outline em + avatar), chips, Now Sound daypart hero, ticker, numbered tiles, shelves (Daily Mixes w/ AI card, Trending numbered chart, On the Rise grayscale stamps, Because You Listened, New Releases), endless feed below — **FlatList + FeedSongRow/FeedAlbumShelf/HomeHeader memo contracts preserved** |
| SearchScreen | The Index | huge masthead, bordered search field (orange shadow on focus), recents chips, Browse-the-stacks grid (numbered gcards), results w/ `N verified` tag, rows w/ index + reason chip + source badge, dashed zero state — **pagination wiring preserved** |
| LibraryScreen | The Crates | chips, Liked Songs orange hero, list rows, Premium banner — tabs renamed |
| MindbeatWireScreen | Mindbeat Wire | NEW 4th tab: ai-hero, input+send, idea chips, pipeline, result card, Your Sound audit box (links Stats) |
| PlayerScreen | Full player | broadsheet: grayscale artwork wash bg, chevron top row + kicker, stamped artwork, huge title, striped progress, square controls (66px ink play w/ orange shadow), lyrics card, CAST/SHARE/SAVE foot, queue sheet w/ pills |
| CollectionScreen | — (extend) | tinted wash → paper2 hero w/ ink border, acid FAB |
| PlaylistScreen | — (extend) | same language |
| StatsScreen | Your Sound box (expanded) | PULSE stat cards |
| TasteScreen | — (extend) | data table language |
| PremiumScreen | premium banner (expanded) | paper2 box language |
| Onboarding | — (extend) | paper + ink + acid stamps |
| MiniPlayer | mini | ink bar, orange shadow, progress line, EQ swap |
| Toast | toast | ink bar, orange shadow, mono, acid bold |

## Tab bar

`Front · Index · Crates · Wire` — paper bg, 2px ink top border,
Space Mono 9.5px uppercase labels, ink-40 → ink when active, 5px orange
`navdot` under the active label. Premium leaves the tab bar (banner in
Library); MINDBEAT Wire is promoted.

## Preserved contracts (non-negotiable)

- Source locks: HomeScreen `<FlatList windowSize maxToRenderPerBatch
  onEndReached>` + `FeedSongRow/FeedAlbumShelf/HomeHeader = React.memo`;
  SearchScreen `ytSearchMusicMore / ytContRef / appendYtPage /
  ytr.tracks.length < 20 / ytAppendRef.current`; `React.memo` on
  TrackRow/Shelf/Artwork.
- All testIDs survive (`track-row`, `mini-player`, `player-queue-btn`,
  `shelf-card`, `tab-*`, device-lab set).
- Player/search/AI/safety logic untouched. ytPoToken WebView untouched.
- app.json window policy untouched.

## Dynamic palette (amplified, subordinated)

The artwork-palette engine stays. PULSE identity is constant; the
palette appears only as a quiet per-song tint: the player background
wash may carry the artwork hue at ≤8% over the grayscale wash, and the
queue "now" row keeps the acid/orange rule. The blind bar is the
prototype — palette must never break fidelity.
