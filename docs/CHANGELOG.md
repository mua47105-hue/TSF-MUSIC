# Changelog

All notable releases of TSF Music. Dates are UTC.
Detailed build history: `worklog.md` (the session log).

## v3.4.5 — 2026-08-31 — The field-fix round: real songs, deep results, zero repeats

Four field reports, each closed at three levels — live-probed root cause,
behavioral lock (288 tests at ship), and binary verification in the shipped
APK (19/19 + red-on-old-APK sanity):

- **Home deep-scroll lag** (R8-1): the home feed was rebuilt on FlatList
  virtualization — memo'd `FeedSongRow`/`FeedAlbumShelf` rows render off a
  data snapshot, so deep scrolling no longer re-renders the shelves above.
- **Lo-fi-first YouTube results** (R8-2): YouTube search now runs the
  **songs filter as the primary query** (`SONGS_FILTER_PARAMS` — official
  Song rows first), with the raw query as fallback. Live-probed: official
  song rank #1 for tu chaiye / tum hi ho / kesariya / apna bana le.
- **6–8 result shallow search** (R8-3): continuation-based deep pagination
  — search appends YouTube pages on scroll, with retryable transport
  failures (`ytSearchMusicMore` rejects with `error:true` — a network blip
  never paints "That's everything" nor burns the continuation token) and
  a single-flight `YtAppendController` (extracted to `src/search/ytAppend.ts`,
  6 behavioral locks) so a new query never queues behind a doomed walk.
  Eager top-up paints ~2 catalog pages before any scrolling starts.
- **Top Songs repeats** (R8-4, the Zalima ×5–6 report): same recording
  re-listed with re-ordered/truncated credit lists survived key-dedup.
  Fixed by recording reconciliation (`src/api/recording.ts`:
  `creditSetOf`/`sameCredits`/`reconcileRecordings`) wired into every
  merge point — including `getTrending`, which was never deduped at all —
  plus play-count-twin collapsing (global counters within 1,000 =
  re-list). Live probe: 'top songs' clusters 5 → 0.
- Gauntlet loop: 3 rounds (R1 FIX-FIRST → R2 FIX-FIRST — caught the
  builder's own regressions, e.g. the singleton credit guard un-collapsed
  the live "Humnava Mere" pair — → R3 SHIP). Every verdict machine-proven.
- WhatsNew 3.4.5: "real songs, deep results, zero repeats" — every
  3.4.4 upgrader sees the four fixes once.

## v3.4.4 — 2026-08-31 — The half-screen bug, closed at the root

The four-release mystery (half-height app window on every Android device,
both orientations) is root-caused and shut out:

- **Root cause**: an invisible `react-native-webview` v14 `flex:1` wrapper
  (mount of the PO-token BotGuard bridge) — not any OS window policy —
  was eating the bottom half of every screen.
- **Two-level fix**: the WebView mount is re-homed inside a fixed
  `StatusBar`-height slot (belt 1, with a minification-safe
  `testID="yt-po-token-webview"` marker), and the bridge fragment is
  additionally detached from the layout tree (belt 2).
- **9 regression locks** proven red on the v3.4.3 code before shipping,
  plus the R7 marker contract locked in source.
- Binary-verified on the shipped APK (13/13, incl. belts + window-policy
  retention + WhatsNew key); all R7 markers correctly FAIL on v3.4.3.
- User-confirmed fixed in the field: "the UI problem is now completely
  fixed."

## v3.4.3 — 2026-08-31 — The real tablet fix, part 2: aspect-clamp immunity

v3.4.2's orientation freedom worked (rotation unlocked, field-verified)
but the half-screen window survived on both tablets. R6 forensics
finally decoded the window SHAPE: 600×450 — the largest **4:3-ratio**
rectangle that fits the screen width (600 ÷ 4/3 = 450; every field
screenshot matches once the 13px matte band is subtracted). A 4:3
window is an **aspect-ratio compatibility clamp** applied by the OS
override layer, not by anything the manifest declared:

- Android 14+/One UI 6 ships a user "app aspect ratio" menu whose
  options include literal **3:4**; Samsung's legacy layer also
  auto-applies phone-aspect (4:3) clamps to apps that never declare
  max aspect — exactly our v3.4.1/v3.4.2 state.
- v3.4.0 (resizeableActivity=false) hit the non-resizable letterbox;
  every later clean manifest still fell into the undeclared-max-aspect
  bucket. The user's "Full screen" toggle never helped because One UI
  re-evaluates window policy only on cold start and kept re-applying
  the stored override.

The fix (withWindowPolicy v3) declares the app full-bleed to BOTH
layers: `maxAspectRatio=2.6` + legacy `android.max_aspect` meta
(ignored by stock Android while resizeable=true — decisive for
Samsung's legacy clamp; 2.6 clears every real display incl. 22:9
folds), plus the four official **PROPERTY_COMPAT_*** opt-outs on
`<application>` (user aspect ratio, OEM min-aspect, orientation,
resizability overrides) so the Android 14+/One UI 6 compat framework
can never clamp the app again — the app even disappears from the
device aspect-ratio menu.

- `plugins/withWindowPolicy.js` v3 (19 W1 locks, incl. idempotent
  upserts, hostile-value rewrites, and an expo XML serialization
  round-trip lock).
- CI now gates every build on the full test suite + typecheck (a red
  lock can never reach an APK).
- WhatsNew 3.4.3 hedges on certainty: it asks the user to fully close
  the app once after updating (One UI applies window policy on cold
  start) and carries the manual Settings fallback if any clamp
  survives.
- APK deep-verifier gates this release: property tags + max-aspect
  declarations binary-proven in the shipped manifest (see
  `scripts/verify_v343_apk.py`). Same-keystore in-place upgrade.

## v3.4.2 — 2026-08-31 — The real tablet fix: orientation freedom

v3.4.1 was not enough: two Samsung tablets still rendered the app in a
half-height window (tab bar mid-screen, dark void below) even with
`resizeableActivity="true"` and no aspect caps, and the One UI per-app
"Full screen" aspect setting changed nothing. Fresh forensics on the
v3.4.1 field screenshot (app UI = EXACTLY 50.0% of the window; void =
the app's own #0A0A0B windowBackground; taskbar + 3-button nav below)
plus a decoded-AXML diff of every shipped manifest (v3.3.0 / v3.4.0 /
v3.4.1 are otherwise identical) isolated the one restriction present in
every version since v1: `android:screenOrientation="portrait"` on the
activity. Google's device-compatibility-mode documentation states it
plainly: "App restricted to portrait orientation is letterboxed on
landscape tablet and foldable" — mattes fill the unused area, "on large
screens, to one side or the other", painted with the app's own
background. Phones are compact-window devices (never letterboxed →
every phone was fine); sw600dp+ tablets always letterbox
orientation-locked apps (→ every tablet was broken). Samsung's aspect
setting controls the aspect-ratio letterbox path only, which is why it
had no effect.

### Window / orientation (the root fix)
- **Orientation lock removed** — `app.json` `"orientation": "default"`
  and the window-policy plugin now strips `android:screenOrientation`
  from every activity. The app can never again be classified as a
  portrait-only "phone app" that large screens must compat-host. This
  also future-proofs against Android 16+/API 37, which ignore
  orientation locks on sw600dp+ displays anyway. iOS keeps its
  portrait lock via Info.plist (behavior unchanged; iPad unsupported).
- **Explicit `<supports-screens>`** declaration (largeScreens /
  xlargeScreens / anyDensity = true) added by the plugin — the
  large-screen support declaration Google's checklists ask for.
- v3.4.1 policy retained: `resizeableActivity="true"`, no
  maxAspectRatio / android.max_aspect (stale attrs stripped).
- Locked by the rewritten W1 suite (12 locks) + post-build APK audit
  (compiled-AXML parse asserts NO screenOrientation, resizable=true).

### Adaptive layout (making orientation freedom safe)
- New pure helpers `src/ui/windowing.ts` with lock tests:
  `browseColumnsFor` (Search "Browse all" grid: 4 columns at ≥720dp
  windows — landscape phones, tablets, DeX/desktop windows; 2 below) and
  `playerArtSize` (artwork capped at 62% of window height so wide
  landscape windows can't oversize it; floored at 200dp).
- SearchScreen: FlatList remounts per column count
  (`key={`browse-${cols}`}`) — the only safe way to change numColumns
  (the v3.4.1 "Changing numColumns on the fly" lesson, now also
  rotation-proof). PlayerScreen: artwork uses the capped size and
  centers automatically.
- Device lab grew to 5 viewports: Pixel 7, iPhone 13, portrait tablet,
  LANDSCAPE tablet (960×600), and a 1280×800 desktop-style window —
  each running the full walkthrough with tab-bar-pinned-to-window-
  bottom and no-horizontal-overflow assertions.

## v3.4.1 — 2026-08-30 — Tablet window fix + endless feeds

Field-reported on two tablets: the bottom tab bar rendered mid-screen
(~46% height) with a giant dark void below — the app was hosted in an
OS compatibility window. Pixel forensics on the uploaded screenshot
(600x960, content ends 46.6%, uniform RGB(10,10,10) ≈ the app's own
#0A0A0B windowBackground letterbox fill) proved the trigger:
`resizeableActivity="false"` (shipped in v3.4.0's window-policy plugin)
is the textbook cause of Android 12L+/One UI compatibility letterboxing
on tablets with a taskbar. This round inverts the policy and adds the
Spotify-style endless scrolling the user asked for.

### Window / layout
- **`resizeableActivity="true"` explicitly, ALL aspect-ratio caps
  removed** (no `maxAspectRatio`, no legacy `android.max_aspect`) — the
  system never has an excuse to compat-host the app again. The plugin
  also strips any stale v3.4.0 attributes. Locked by
  tests/ai/window_policy_locks.test.ts (7 locks) + APK deep-verify.
- **Window-reactive layout**: HomeScreen's quick-tile grid and
  PlayerScreen's artwork re-measure via `useWindowDimensions` (were
  frozen module-scope `Dimensions.get` constants — stale on resize,
  split-screen, foldables).
- **Fixed a latent crash**: clearing the search field after results
  threw RN's "Changing numColumns on the fly" invariant (browse grid is
  2-column, results list is 1-column, same tree position). Both
  FlatLists now carry distinct keys.

### Endless feeds
- **Home scrolls forever** (src/api/feed.ts `EndlessFeedPager`): after
  the fixed shelves, alternating paged song batches (rotating 16-query
  ladder, per-query deep paging — verified live: JioSaavn serves 30
  rows/page, 93%+ fresh) and paged album-card shelves, deduped across
  batches and against the shelves, safety-filtered. Honest retry row on
  network failure (never burns the ladder budget), honest end marker.
  Tapping a feed song plays the full loaded feed as the queue.
- **Search results paginate**: scrolling near the end appends JioSaavn
  page 2, 3, … (dedupe + muted-artist parity with the engine), stopping
  honestly on empty/<25%-fresh pages. The Search V2 engine's page-1
  ranking is untouched (progressive paint, rescue ladder, lyric
  verification all unchanged).

### Gauntlet R4 discipline
- Live pagination probes before building (30 rows/page, 24-30 fresh
  per page; no paged playlist endpoint exists — songs+albums feed).
- Fresh-context adversarial critic: 2 P1 (stale page-fetch rejection
  killing the next query's pagination; first append clobbering LRCLIB
  lyric verification via a stale results closure) + 3 P2 (feed epoch
  race on pull-to-refresh; network errors burning the exhaustion
  budget; webmock export-parity gap breaking the rescue album rung on
  web) — all fixed with locks (tests/ai/r4_critic_locks.test.ts).
- Device lab rebuilt for real scrolling: RN-web ScrollViews ignore
  mouse.wheel in headless Chromium — the lab now drives scrollTop
  directly on the scroller under the viewport center (elementFromPoint).
  Full sweep: **93/93 checkpoints × 3 devices** (Pixel 7, iPhone 13,
  and the tablet's exact 600x960 viewport) with ZERO console errors —
  including tab-bar-pins-to-window-bottom, endless-feed-loads, feed
  rows play, search pagination appends/honest-end/resets.
- Suite: 174 → **206 tests** (+32 locks), tsc clean.

## v3.4.0 — 2026-08-30 — YouTube source + the title-truth rescue

Ported from the lab line (v3.4.0-lab.1…lab.4, device-verified there) and
hardened with a full gauntlet round: a fresh-context adversarial critic
found 2 P0 + 4 P1 + 7 P2 in the ported code — every P0/P1 fixed with
test locks (tests/ai/search_yt_locks.test.ts, 15 locks; suite 159→173).

### YouTube source
- **Catalog | YouTube search toggle**: YT Music's catalog answers
  directly (WEB_REMIX client) — Song rows first, videos only when
  0 < duration ≤ 15 min (junk/podcast filter), duplicates dropped.
- **Ad-free full-song playback** via a three-client InnerTube ladder:
  VISIONOS 1.04 (tokenless, pre-signed URLs — the NewPipe/yt-dlp
  production class) → WEB_REMIX (BotGuard-attested with PO tokens minted
  in a hidden 1×1 WebView on the youtube.com origin + signatureCipher
  decipher fallback) → ANDROID_VR (dying, last resort). Per-client
  10-min health cooldowns, per-rung diagnostics trail
  (`ytLastDiagnostics()`), IP-bound URL cache with refresh.
- **Kill-switch discipline**: 3 consecutive systemic failures soft-disable
  YouTube for 1 h; per-video UNPLAYABLE never disables the source;
  search is gated; JioSaavn playback can never be blocked (every YT
  entry point resolves null within timeouts).
- **Never-blank player**: a failed YT stream = honest toast → 1.2 s
  warm-up retry through the PO-token bridge → final honest toast. Never
  a silent nothing, never a different song than the one tapped.

### Search — the title-truth contract
- **Rescue ladder** (youtube → itunes → variant → album): when a
  specific-intent query has no dual-axis match, or a title-only query's
  organic rows are all sub-250k-plays covers, the engine escalates and
  paints the verified canonical recording at rank 1 with an honest label
  ("Found on YouTube · full song, ad-free" / "Found via Apple Music ·
  30s preview" / "Found under a different spelling" / "Found via its
  album · full song").
- **Port-hardening (critic round)**: a successful rescue can never be
  discarded by the S4 recovery ladder or by cluster-dedupe (both were
  reachable and fabricated `sigState='rescued'`); the title-only
  unstreamable fallback is gated on non-systemic walls so iTunes
  previews answer instead; song-kind rows outrank 6.2M-view lyric
  videos; honest reasons (`bot-walled`/`network`/`no-audio`) and
  class-aware kill-switch accounting; search-time connector stripping
  ("tu chaiye OF atif aslam"); orthographic variant expansion
  (chaiye ↔ chahiye, byte-identical legacy math when empty — pinned).
- **parseHumanCount**: "6.2M views" → 6,200,000 (the old parse read 6).

### App shell
- **Fullscreen window determinism** (config plugin
  `plugins/withWindowPolicy.js`): `resizeableActivity=false` +
  `maxAspectRatio=2.4` injected at prebuild — the Samsung split-window
  half-screen wedge class is impossible now.
- **Insets-aware tab bar**: height/padding include `insets.bottom`
  (gesture-nav safe); the mini-player offset mirrors it.
- What's-New 3.4.0 dialog (new seen-key) doubles as on-device proof of
  the update.

### Tests & process
- Suites: search_rescue / search_sig_e2e / youtube (lab) +
  search_yt_locks (port locks) — 173 tests, 759 expects, all green;
  `tsc --noEmit` clean.
- Web screenshot harness: YouTube webmock (InnerTube has no CORS), YT
  fixtures with ortho folds, SIG-cover fixture for the rescue scenario;
  device lab 48/48 × 2 devices, zero console errors (12 new v3.4.0
  checkpoints: rescued label, canonical top row, source toggle,
  YouTube-mode rows + badges, rescued row plays end-to-end).
- CI: fail-fast signing-secret preflight (seconds, not 17 minutes).

## v3.3.0 — 2026-08-30 — Search V2

The search engine rebuild (from the SEARCH-ENGINE-REFACTOR plan; every
API fact re-verified live before build):

- **S0 query understanding**: deterministic normalizer (NFC, diacritic
  fold, bounded Hinglish variance maps), SymSpell typo correction
  (deletes-only index, ≤2 edits, language-independent — "arjit" →
  "arijit", "fya" → "faya"), first-class intent classifier
  (title / artist / artist+title / lyric fragment / vibe / browse) with
  idf-distinctive lyric window selection.
- **S1 retrieval**: ≤4 parallel probes per query + autocomplete riding
  along; LRU-200 result cache (10 min) + in-flight dedupe; real
  AbortController cancellation per keystroke generation.
- **S2 verification**: id-dedupe across pools; version clustering
  (title-key + artist-overlap union — 26 duplicate "Tum Hi Ho"
  releases collapse to one row; "Tum Hi Ho Bandhu" never merges; covers
  stay separate); lyric verification V1 (snippet echo, free) + V2
  (LRCLIB full-lyrics containment, bounded, silent-fail) + LRCLIB
  fragment resolution for the S1 flow.
- **S3 ranking**: deterministic scorer (provider rank, title coverage
  × precision, FULL-artist-list matching, personalization via the real
  decision-engine affinity reader, engagement, quality) with the
  disambiguation override (artist-mismatched rows can never outrank the
  artist you typed) and truthful reason lines from a closed set.
- **S4 recovery**: relaxation ladder (≤2 rungs, 1.5 s budget) with
  honest zero-states — no row is ever rendered as a match unless it
  matches (the old "English lyric → Telugu songs" failure is gone).
- **S5 learning**: correlated SEARCH_QUERY/SEARCH_CLICK ledger events
  (joinable), fragment→track memory (repeat lyric searches are instant
  + ranked first with a truthful reason), engagement re-ranking
  (2 clicks flip provider order; 21-day half-life prevents ruts),
  sourceTrust.search feeding; the kill switch pauses all of it.
- **UI**: typeahead rail (recents 0 ms + provider suggestions +
  "Best guess" topquery row), progressive paint, lyric-match chips with
  the matched line, "+N versions" cluster metadata, "Showing results
  for …" recovery labels, memoized did-you-mean chips.
- **Full-artist display fix**: rows show the entire primary-artist
  list ("Apna Bana Le" now shows Arijit Singh, not just its lyricist).
- **Fixed a latent ledger bug found by the gauntlet**: event ids used
  unpadded base-36 counters — past 35 same-millisecond events the
  string sort reordered events and broke crash recovery. Ids are now
  zero-padded and monotonic under string comparison (R-LOCK-1).
- Gauntlet: fresh-context adversarial review (4 P0 + 8 P1 found and
  fixed with regression locks), live blind A/B vs the provider
  (`scripts/ab_search_blind.txt` — no regressions, hard wins on
  dedup + honest zero, S1/S2 drift documented with live evidence),
  device lab 36/36 with zero console errors, Android bundle verified
  marker-present and webmock-clean.
- Tests: 74 → 126 (47 new: plan/lexicon/rank/perf + gauntlet locks).

## v3.2.0 — 2026-08-29

The user-feedback round: every reported issue fixed end-to-end.

- **Real artist photos** in onboarding and the new "Popular artists"
  home rail — 48 verified A-lister portraits ship in-app (instant first
  screen), plus live category batches ("More Bollywood / Punjabi /
  Hip-Hop / …"), artist search with photo enrichment, and an honest
  gate that rejects album-art-masquerading-as-artist-photo (initials
  fallback — never a wrong image).
- **Onboarding persistence fixed** (the re-ask bug): the completion
  flag is dual-written (SQLite + AsyncStorage) before the flow closes,
  the gate awaits store readiness, and a mid-flow kill resumes instead
  of restarting. Verified by an automated reload regression in the
  device lab.
- **Deep Home feed**: New releases + Featured playlists shelves from
  JioSaavn's editorial feed (6 h cached for instant cold starts),
  Popular artists rail — the home screen now scrolls Spotify-deep from
  the very first session.
- **Search upgraded**: Spotify's Top-result hero card over the Songs
  list, 18-category Browse grid, clear-recents button.
- **New app icon + splash** (10-round gauntlet vs genuine references):
  green music-note-from-waveform-bars mark on a dark premium tile;
  adaptive icon with safe zone; splash with Figtree wordmark.
- Device lab rebuilt and committed (28-step Playwright walkthrough,
  both device profiles, zero console errors).

## v3.1.0 — 2026-08-29

- **Spotify-faithful 3-step first-run onboarding**: "What's your
  name?" → "Choose 3 or more artists you like." (circular avatars,
  search, More batches) → "What kind of music do you like?" (12 genre
  tiles). Picks seed the taste profile immediately.
- "Made for {name}" shelf on Home; onboarding gates behind the
  What's-new dialog (no modal stacking).
- Gauntlet-verified end-to-end against genuine Spotify references
  (contrast ≥ 5.9:1 on every genre tile, pixel-verified selection
  treatment, iOS safe areas).

## v3.0.0 — MINDBEAT — 2026-08-28

The complete intelligence overhaul: every play/skip/like becomes graded
evidence.

- **L1 Event Ledger** — 20 event types, graded listen outcomes, crash
  -safe heartbeats, 90-day/20k bounded SQLite storage.
- **L2 Taste Profile** — decaying affinities (heart 180 d … era 120 d),
  the 5×2 daypart matrix, proxy feature space with behavioral
  calibration, co-play graphs, taste clusters, corrections
  (Boost / Mute / Not-for-me).
- **L3 Session Brain** — 12-track window, six-state vibe machine,
  skip-storm healing protocol.
- **L4 Decision Engine** — 5-pool scoring, ε-greedy exploration,
  8 truthful reason codes, deterministic ordering.
- **L5 Surfaces** — Smart Shuffle v2 (vibe-lock + queue healing),
  Radio v2 (multi-seed, drift, dedup, background), Daily Mixes v2
  (cluster crosses, 60/25/15), Now Sound daylist, On the Rise, AI
  Playlist v2 (five stages, Hinglish, negations), Vibe Search.
- **L6 Trust** — Taste DNA transparency screen, kill switch, JSON
  export, no-identifier privacy (verifier-tested).
- Your Sound v2 stats (30-second rule, listening clock, streaks);
  74/74 replay tests incl. latency budgets (decide() p95 ~4 ms vs
  150 ms budget); blind A/B preferred over the v2.1 generator 17/20.

## v2.5.0 — 2026-08-27

- Green-active filter chips with black text (pixel-verified against
  genuine Spotify), avatar-left home header with All / Music / AI.
- 8-tile shortcut grid (2×4) on Home.
- 4th bottom tab: **Premium** (Spotify-style landing page).
- Library: ghost-outline inactive chips + list⇄grid view toggle.
- Mini player: "Title • Artist" bold single line.
- **What's-new dialog** (one-time per release) + on-screen version
  badge — updates became visibly verifiable on the device.

## v2.4.1 — 2026-08-26

The forensic "why doesn't it look like Spotify" fix:

- Home canvas stays **flat #121212** (the artwork wash was misapplied
  there and read as mud); artwork tinting lives only on
  playlist/album/player pages via a new vivid `wash` palette token.
- Quick tiles carry album art again; semibold card titles; 8px radii.
- Player: plain white 62px play glyph (no circle — current Spotify),
  white progress thumb.
- White-active All/Music chips (per the reference of the time).

## v2.4.0 — 2026-08-26

- Repo-faithful rebuild against the studied reference client:
  gradient washes, white-active pills, translucent tiles, gradient
  mini player, plain-white play glyph, contextId tracking (green
  play-FAB overlays). Later rolled back and superseded by v2.4.1's
  corrected design direction.

## v2.3.1 — 2026-08-26

- Rollback release: byte-identical v2.3 UI restored by user preference,
  shipped as an upgradable APK (monotonic versionCode).

## v2.3.0 — 2026-08-25

- **A-to-Z authentic Spotify Android UI**: rebuilt every core surface
  against pixel-sampled genuine references — #121212 canvas, black
  3-tab bar, #282828 mini-player card, quick-tile grid, Spotify
  shelves, full now-playing rewrite, #242424 search pill + Browse-all
  grid, library layout, collection hero pages.
- Web screenshot harness born (the ancestor of today's device lab):
  in-memory player + fixture APIs + VLM-verified screenshots.

## v2.2.0 / v2.2.1 — 2026-08-24

- **Dynamic per-song theming**: artwork color extraction in pure JS
  (jpeg-js quantizer) → the app repaints with every track.
- Glassmorphism pass, rotating vinyl player with waveform scrubber
  (later replaced by the authentic Spotify player in v2.3).
- Ambient backdrop, palette-tinted cards; zero native modules added.

## v2.1.0 — 2026-08-23

- Spotify-grade UI overhaul: design system (palette, type scale,
  Figtree), Home shelves, Search browse grid, Library, full Player with
  queue sheet, press-scale haptics, toasts.
- **First AI generation (fully on-device)**: AI Playlist Generator with
  intent parsing + staged thinking animation, Smart Shuffle, Daily
  Mixes, Autoplay Radio, Because-you-listened, Your Sound stats.
- Content safety layer: provider flags + EN/Hindi/Punjabi blocklist on
  every algorithmic surface; E-badged search.
- GitHub Actions CI producing signed release APKs; tags publish
  GitHub Releases.

## v2.0.x — 2026-08-22

- Standalone React Native (Expo 52) baseline: direct JioSaavn API with
  on-device DES decryption (320 kbps), iTunes fallback,
  react-native-track-player with background audio and notification
  controls, downloads for offline, playlists/likes/history.
- Signed-APK CI pipeline (versionCode jumped past the v1.x Capacitor
  builds so Android accepts in-place upgrades).

## v1.x

- Capacitor hybrid prototype (superseded by the React Native rewrite).
