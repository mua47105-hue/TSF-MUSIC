# TSF Music v3.4 — MINDBEAT + YouTube

**A standalone, cross-platform (Android + iOS) music app with a Spotify-grade
interface and a learning, on-device intelligence engine.**
No server. No setup. No account. Install the APK and it works.

Music streams at **320 kbps** straight from the device via direct JioSaavn
API calls (DES-decrypted on-device), with a **full YouTube source**
(search + ad-free full-song playback) and an iTunes preview fallback —
React Native talks to the APIs directly, so there are no CORS proxies, no
backends, nothing to host. Every AI feature runs **100% on the device**:
no LLM APIs, no analytics, no telemetry — your listening history never
leaves the phone.

> **Install**: grab `app-release.apk` from the latest release
> (https://github.com/mua47105-hue/TSF-MUSIC/releases) and sideload it.
> Builds are signed with the same keystore, so updates install in place.

---

## What's inside

### YouTube source — a second catalog (v3.4)
- **A Catalog | YouTube toggle** in search: YouTube's music catalog
  answers directly — official Song rows first, videos (≤ 15 min, junk
  filtered) after
- **Ad-free full-song playback**: a three-client InnerTube ladder
  (VISIONOS tokenless → WEB_REMIX attested via a hidden-WebView
  BotGuard PO-token minter → ANDROID_VR last resort) resolves direct
  audio URLs — the same technique NewPipe/yt-dlp ship
- **Kill-switch discipline**: YouTube breakage can never degrade the
  JioSaavn core — every entry point degrades to honest empty states,
  toasts, and per-rung diagnostics

### Search that rescues the song you meant (v3.4)
When the catalog only has same-name covers of the song you typed
("tu chaiye" → 31 covers, none canonical), the engine escalates a
**rescue ladder** — YouTube (full song, ad-free) → iTunes (30 s preview,
truthfully labelled) → variant spellings (chaiye ↔ chahiye) → the album
route — and paints the verified canonical recording at rank 1 with an
honest label: *Found on YouTube · full song, ad-free*. Covers never
displace a verified rescue; a fabricated result state is a test-locked
bug class.

### Search V2 — a real search engine (v3.3)
Search is a full pipeline, not a text field: **S0** query understanding
(normalize + Hinglish variance folds + SymSpell typo correction —
"arjit sing" → "arijit singh", "kun fya kun" → "kun faya kun") ·
**S1** parallel probe fan-out with per-keystroke cancellation and a
10-minute result cache · **S2** verification (id-dedupe, version
clustering — 26 duplicate "Tum Hi Ho" releases collapse to one row —
and lyric verification) · **S3** deterministic ranking with the FULL
artist list, disambiguation override (wrong-artist versions can never
outrank the artist you typed), engagement and personalization ·
**S4** a relaxation ladder with honest zero-states ("Did you mean …",
never unrelated rows) · **S5** learning (correlated query→click
evidence, fragment→track memory, sourceTrust feeding).

- **Typeahead rail**: suggestions while you type — your recents at 0 ms,
  provider songs/artists and a "Best guess" row at ~250 ms
- **Lyric search**: type a remembered line — matches carry a green
  **Lyric match** chip with the matched line (verified against
  LRCLIB, a free public lyrics catalog)
- **Truthful reason lines**: "Best match for your search" · "Matches
  the lyric you typed" · "You chose this for this search before" · …
  from a closed set — never invented
- Latency budgets are test-enforced: on-device stages cost <35 ms
  combined; cache-hit repeat searches answer in <15 ms

### The player
- **320 kbps playback** with background audio, notification and lock-screen
  controls (react-native-track-player)
- **Stale-URL auto-recovery**: expired CDN links are silently refetched and
  re-decrypted mid-session
- Real queue control: play next, add to queue, remove from queue, shuffle,
  repeat
- **Downloads for offline** — resolved streams are saved into the app's
  private document directory and play back forever
- Share sheet, per-track long-press menu, toast feedback for every action

### MINDBEAT — the on-device intelligence (v3.0+)
Every play, skip, like and download becomes **graded evidence** in a local
event ledger, and the app learns from it:

| Surface | What it does |
|---|---|
| **Smart Shuffle v2** | AI picks interleaved into your queue, vibe-locked to the current session; skipping a rec re-seeds the next one away from what you rejected ("it's listening back") |
| **Autoplay Radio v2** | When the queue runs dry, a multi-seed station keeps playing — even with the UI killed — drifting between mood cells inside your artist clusters |
| **Daily Mixes v2** | Cluster-cross mixes (artist cluster × mood cell) with a 60/25/15 core/bridge/fresh split, re-ranked nightly and after every third session |
| **Now Sound (daylist)** | A time-aware playlist: your 11pm and your 11am get different names and different tracks ("Midnight Riyaz", "Gym-time Bhangra") |
| **On the Rise** | Seed-of-seed discovery: neighbors of your co-play neighbors, filtered to never-played tracks, each with an honest "via artist" chain |
| **AI Playlist Generator** | Type a vibe ("Punjabi gym bangers", "90s heartbreak Bollywood", Hinglish works) → five-stage pipeline (Understand → Hunt → Curate → Polish → Narrate) → 25-track playlist with a name and description |
| **Vibe Search** | The search bar's NLP mode: "songs like kun faya kun", typo-tolerant ("sahd songs"), intent chips on the results |
| **Your Sound v2** | Wrapped-grade stats with the industry 30-second rule, listening clock, streaks and skip profile |
| **Taste DNA** | The transparency screen: see the entire model — affinity weights, the daypart matrix, exploration budget — and act on it (Boost / Mute / Not-for-me / export JSON / kill switch) |

Every recommendation carries a **truthful reason line** from a closed code
set — the app never invents an explanation. See
[docs/MINDBEAT.md](docs/MINDBEAT.md) for the full six-layer architecture.

### First-run onboarding (v3.2)
Spotify-faithful three-step flow:
1. **"What's your name?"** — powers the "Made for {name}" shelf
2. **"Choose 3 or more artists you like."** — **real artist photos**
   (48 verified A-lister seeds + unbounded "More" batches across 8 live
   categories + artist search), circular avatars with white-ring selection
3. **"What kind of music do you like?"** — colorful genre tiles

Completion is **permanent**: the flag is dual-written (SQLite + AsyncStorage)
before the flow closes, and a mid-flow kill resumes instead of restarting.
Your picks seed the taste profile immediately.

### The interface
- Authentic Spotify Android design language, pixel-verified against
  genuine reference screenshots (green-active filter chips, 8-tile shortcut
  grid, #282828 mini-player card, plain-white play glyph, 4-tab bar with
  Premium)
- **The app repaints itself per song**: artwork colors are extracted in
  pure JS (jpeg-js quantizer, no native module) and drive the player
  gradient, collection headers and accent surfaces
- **Deep Home feed**: shortcuts → Made for {name} → Now Sound → Jump back
  in → Popular artists (real-photo rail) → Trending → On the Rise →
  Because you listened → New releases → Featured playlists → charts
  — JioSaavn's editorial feed keeps the screen populated from the very
  first session
- **Endless scrolling (v3.4.1)**: Home keeps loading forever after the
  fixed shelves (alternating paged song lists and album shelves,
  deduped, safety-filtered), and search results append JioSaavn pages
  as you scroll — with honest "end of results" markers, never a dead
  spinner
- **Tablet-correct windows (v3.4.1)**: fully resizeable, no aspect-ratio
  caps — the bottom bar sits at the real bottom of ANY window (phones,
  tablets, split-screen, pop-up), and the layout re-measures live
- Search: Spotify's Top-result hero card over a Songs list, 18-category
  Browse grid, recent searches, Keyword|Vibe toggle
- Library: playlists / artists / albums / downloaded filters, list⇄grid
  view toggle, Liked Songs gradient hero
- "What's new" dialog on every update + an on-screen version badge, so
  releases are visibly verifiable on the device

### Content safety
Explicit/abusive content never appears on Home or any algorithmic surface:
provider explicit flags plus a word-boundary profanity blocklist
(English + Hindi/Punjabi romanized). Search results honor user intent and
show an "E" badge instead. The filter is tested against a dodge corpus.

### Privacy
- The ledger stores **no URLs, device ids or identifiers** (verifier-tested)
- Everything lives in app-private storage; nothing is uploaded anywhere
- Lyric searches send the typed fragment to LRCLIB (a public lyrics
  catalog) to resolve the song — the same class of call as the catalog
  search itself, and the only extra party; candidate lookups send
  title + artist only. Listening history, ledger and profile NEVER
  leave the device
- Kill switch: disable all recommendations (persists across restarts);
  export or reset the model from Taste DNA

---

## Project map

```
App.tsx                    App shell — tabs, stack, providers
src/
  screens/                 Home, Search, Library, Premium, Player,
                           Collection, Playlist, AI, Stats (Your Sound),
                           Taste (Taste DNA)
  components/              Onboarding, WhatsNewDialog, MiniPlayer,
                           TrackRow/TrackMenu, Shelf, Artwork, Toast, …
  search/                  SEARCH V2: plan (S0 classify) · lexicon
                           (SymSpell) · retrieve (S1 fan-out) · verify
                           (S2 clusters + lyrics) · rank (S3) · recover
                           (S4 ladder) · learn (S5) · normalize
  ai/
    mindbeat.ts            The single intelligence entry point (facade)
    core/                  L1 ledger · L2 profile · L3 session brain ·
                           L4 decision engine · proxy features · priors ·
                           SQLite/memory stores · the tuning table
    surfaces/              Smart Shuffle, Radio, Daily Mixes, Now Sound,
                           On the Rise, AI Playlist v2, Vibe Search
    engine.ts, generator   v2.1 legacy surfaces (kept as fallback layer)
  api/                     saavn.ts (DES stream decrypt + autocomplete) ·
                           artists.ts (real artist photos) · music.ts
                           (Search V2 orchestrator) · lrclib.ts (lyrics) ·
                           itunes.ts
  player/                  PlayerProvider + background service
  storage/                 AsyncStorage store + download manager
  theme/                   Dynamic palette engine + provider
  safety.ts                Content-safety filter
  webmocks/                Web-only fixture layer for the device lab
tests/ai/                  126 replay tests: MINDBEAT + search plan /
                           lexicon / rank locks / perf budgets +
                           gauntlet regression locks
scripts/                   Device lab (Playwright), search A/B, APK
                           verifiers, icon generators, screenshot packager
ci/                        Gradle signing patch for CI
docs/                      Architecture, MINDBEAT, development, changelog
```

Full details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Build & run

```bash
bun install
bun run typecheck        # tsc --noEmit (strict)
bun test                 # 126 replay tests incl. latency budgets
bunx expo start          # dev server
bunx expo run:android    # native debug build
```

### Release (CI)

GitHub Actions (`.github/workflows/native-android.yml`) on every push to
`main`: stamps a monotonic `versionCode`, runs `expo prebuild`, builds a
**signed release APK** from the secret keystore and attaches it as an
artifact. Pushing a `v*` tag publishes a GitHub Release.

```bash
git tag v3.4.0 && git push origin v3.4.0   # → release APK in ~15 min
```

APKs are deep-verified after each release (manifest version probe, Hermes
bundle markers, webmock-leak check — `scripts/verify_v32_apk.py` is the
latest example).

### Visual QA — the device lab

```bash
bash scripts/lab.sh
```

Boots Expo web with react-native-web, redirects the data/player layers to
fixtures (`src/webmocks/` + `metro.config.js` — **Android builds are
unaffected**), then runs a Playwright walkthrough on hardware-faithful
Pixel 7 and iPhone 13 viewports: onboarding → reload-persistence
regression → deep home scroll → search → player → queue. Screenshots land
in `screenshots/`; `scripts/package_ui_shots.py` builds the browsable
gallery committed at `download/tsf-ui-screenshots/`.

## Documentation

| Doc | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module map, data flow, playback pipeline, theming, persistence, web harness |
| [docs/MINDBEAT.md](docs/MINDBEAT.md) | The six-layer intelligence stack, surfaces, reason codes, tuning, privacy |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Workflow, device lab, gauntlet loop, testing, release process, conventions |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | Release history v2.0 → v3.2.0 |

## Stack

React Native 0.76 · Expo SDK 52 (prebuild, bare workflow) ·
react-native-track-player 4.1.1 · expo-sqlite (event ledger) ·
@react-native-async-storage/async-storage · expo-linear-gradient /
haptics / font / file-system · crypto-js (DES stream decryption) ·
jpeg-js (artwork color extraction) · Figtree typography ·
TypeScript strict · Bun.
