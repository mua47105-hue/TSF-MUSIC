# YOUTUBE INTEGRATION PLAN — "The YouTube Section"
### TSF Music · Add-free YouTube playback, researched from the open-source ecosystem, built as our own module
**Version 1.0 · Every feasibility claim below is live-verified or source-cited**

---

## 0. Executive summary

**The ask:** a YouTube section — songs from YouTube, playable completely ad-free, built by deep-diving the open-source projects that already solved this and pinning the best approach as our own integrable module.

**The verified reality (probed live today):**
- YouTube **search works** from a pure client, no auth, no PO token: WEB search 524 ms, YT Music (WEB_REMIX) search 545 ms with *better* metadata than JioSaavn — Song/Video/Album entities, full artist lists, play counts, duration.
- YouTube **stream extraction is an arms race** ("PO tokens" / bot-wall). From this sandbox's datacenter IP every playback client answers `LOGIN_REQUIRED — Sign in to confirm you're not a bot`. This is the *documented* datacenter-IP behavior; the OSS apps that work (NewPipe, InnerTune, Metrolist, ViMusic) run on **real devices with residential/mobile IPs**, where the client ladder still passes today. Verifying the ladder on a real device is therefore **P0 Gate G1** — the go/no-go measurement before any UI is built.
- **The payoff is exactly the last round's wound:** "Tu Chahiye" (Atif Aslam) — the song JioSaavn lost — is on YouTube's official T-Series channel with **104M views**, first result, 524 ms. YouTube becomes the app's *full-length* rescue provider (iTunes rescue only offers 30 s previews).

**The verdict on "use the open-source projects":** we deep-dived all four families and **pin none of them as a dependency — we pin their *technique*** and build a minimal, isolated `src/api/youtube.ts` (~300 LOC, same culture as our own JioSaavn DES-decryption client). Rationale in §2.

---

## 1. Evidence

### 1.1 Live probes (today; captures in `research/youtube/`)

| Probe | Client | Result |
|---|---|---|
| Search `tu chahiye atif aslam` | WEB | ✅ 524 ms, 18 results, T-Series official #1 (104,417,448 views, 3:51) |
| YT Music search same query | WEB_REMIX | ✅ 545 ms, 31 items — Song("Tu Chahiye · Pritam, Atif Aslam & Amitabh Bhattacharya"), Video, Album("Hits Of Atif Aslam"), Lofi mixes, play counts |
| Player `WTLLym2wzIM` | IOS / ANDROID (full device context) | ❌ HTTP 400 (shape) — needs exact youtubei.js request shape |
| Player | ANDROID_VR, MWEB, WEB_REMIX, TVHTML5 | ❌ `LOGIN_REQUIRED — confirm you're not a bot` (datacenter IP) |
| Player | TVHTML5_SIMPLY_EMBEDDED | ❌ "no longer supported" · ANDROID_TESTSUITE → UNPLAYABLE |

### 1.2 Web-verified facts (6 searches, sources on disk)

- **PO tokens are the enforcement mechanism** — yt-dlp wiki: enforcement "rolling out"; rustypipe docs: "Since August 2024 YouTube requires PO tokens to access streams from web-based clients (403 otherwise)"; Jan 2026 issue: PO tokens now required for *most* Innertube clients incl. iOS/Android. Tokens are minted by **BotGuard (web) / DroidGuard (Android)** to attest a genuine client (pytubefix docs).
- **NewPipe merged PO-token support** (PR #11955) and keeps working on-device — proof the device-IP + client-ladder approach survives.
- **Piped/Invidious public proxies are dead/dying** (2024–2025: instances blocked, IP blacklists, "there's no more working instances") → **proxy architectures are disqualified** for a ship-it app.
- **InnerTune / Metrolist / ViMusic** prove the product: ad-free YT Music clients on Android, F-Droid/GitHub, large userbases (AndroidPolice: "I replaced YouTube Music with a third-party client").
- **TVHTML5 DRM A/B** (Mar 2025): some clients now get DRM-only streams → the client ladder must be data-driven and updateable, never hardcoded to one client.
- **RNTP** plays remote progressive URLs + HLS (rntp.dev) — googlevideo audio itags (itag 140 m4a / WEBM_OPUS) are progressive ranged URLs, i.e. exactly what RNTP already does for our JioSaavn CDN files.

---

## 2. The architecture decision — what we "pin" (and why)

| Approach (OSS family) | Verdict | Reason |
|---|---|---|
| **Piped / Invidious proxy APIs** | ❌ Rejected | Public instances broken/blacklisted; self-host contradicts the 100%-on-device no-server architecture |
| **NewPipeExtractor** (Java) | ❌ Rejected as dependency | Java library — would need a native-module wrapper; heavy; but its *client ladder + poToken* technique is the reference we copy |
| **youtubei.js** (npm) | ⚠️ Not as a runtime dep | Full-featured but large, needs RN fetch/URL shims, and its BotGuard path assumes Node VM; excellent as the *protocol reference* we mirror |
| **Our own minimal InnerTube client + WebView PO minter** | ✅ **CHOSEN** | ~300 LOC, fully isolated (YouTube breakage can never touch the JioSaavn core), matches the app's on-device craft (we already hand-roll DES-ECB), lets us keep only the 3 endpoints we need |

**Pinned technique stack (from the OSS ecosystem, cited):**
1. InnerTube `search` + `player` endpoints with per-client context headers (youtubei.js / NewPipeExtractor pattern).
2. **Client ladder** for streams: `IOS → ANDROID → WEB(+poToken) → WEB_REMIX` — newest-working client wins; ladder order is data we can reorder without redesign (TVHTML5-DRM lesson).
3. **PO-token minting via hidden WebView** running YouTube's BotGuard bootstrap (the web-PO technique yt-dlp/FreeTube use), token cached ~hours, attached when a client demands it.
4. **Stream-URL refresh on 403/expiry** — googlevideo URLs are IP-bound + time-limited; identical to our existing saavn stale-URL recovery pattern in `service.ts`.
5. On-device playback through RNTP (already proven in-app for ranged CDN audio).

---

## 3. Product design — the section itself

1. **Search tab source toggle** (top, under the field): segmented `Catalog | YouTube`.
   - *Catalog* = today's JioSaavn(+iTunes) engine, untouched.
   - *YouTube* = YT Music catalog search: Song rows first (artists, duration, plays), then Videos (lyric/official), Albums. Filters: duration ≤ 15 min for "song" default view (jukeboxes/compilations excluded), explicit-content left as-is with the existing "E" badge convention (search is already user-intent, not filtered).
2. **Track rows**: YT thumbnail (hqdefault→mqdefault upgrade), channel/artist line, duration chip, **`YT` badge** (mirrors existing "E" badge style). Song entities show "Song · Artist A, Artist B"; videos show "Video · channel".
3. **Playback**: tap → resolve stream (client ladder, ≤2.5 s budget) → RNTP queue entry with `source: 'youtube'`. YT tracks mix freely in the queue with saavn/itunes tracks; MiniPlayer/Player/queue sheets work unchanged; artwork from YT.
4. **Player screen**: YT tracks show a small "YouTube · ad-free" source line; like/queue/radio work (YT radio = related-videos endpoint `next`, same family as search — P3).
5. **Home**: no new rails in P0–P1 (protect the flat Spotify home); P3 adds an optional "YouTube finds" shelf only if search usage proves the section.
6. **Kill switch**: Settings toggle "YouTube source" (default ON) + automatic soft-disable after 3 consecutive stream failures (banner: "YouTube unavailable right now — catalog still works"), auto-retrying hourly. YouTube breakage can *never* degrade the core app.

---

## 4. Module design

**`src/api/youtube.ts`** (new, ~300 LOC, zero deps):
- `ytSearch(query, filter)` — WEB_REMIX search → Song/Video/Album entities → `Track{source:'youtube', youtubeId, ...}` (search = the two endpoints verified working today).
- `resolveStream(youtubeId)` — client ladder (§2.2) against `player`; returns best audio-only itag (bitrate-sorted, prefer 140/AAC → opus), caches `(videoId → {url, expiresAt})` LRU-100.
- `refreshStream(track)` — 403/expiry recovery for the background service.
- `parseYtmSearch` / `parseWebSearch` — deterministic walkers (unit-tested against fixture JSON committed from today's captures).
- Client context constants versioned in ONE place (`YT_CLIENTS`) — updates ship as app updates (no server, by design).

**`src/webview/PoMinter.tsx`** (P2, bounded): hidden WebView that loads the BotGuard bootstrap and mints web-PO tokens on demand → cache in ledger kv (`searchLexicon`-style snapshot) → injected when the chosen client requires a poToken. Failure = skip token = fall down ladder = honest soft-disable; never a crash.

**`src/player/PlayerProvider.tsx` + `service.ts`** (surgical edits): accept `source:'youtube'` tracks; extend the existing stale-URL recovery branch to call `refreshStream` for YT; queue mixing is already source-agnostic.

**`src/screens/SearchScreen.tsx`**: the segmented toggle + YT row rendering + YT badge (all additive; device-lab testIDs untouched).

**Downloads: out of scope, deliberately.** Streaming-only for YT (both ToS-risk and complexity); our JioSaavn 320k downloads remain the offline path.

---

## 5. Legal & risk honesty (must be said plainly)

- This is the same legal class as NewPipe/InnerTune/ViMusic: it *works on-device* but **violates YouTube's ToS** (streams outside official clients; no ad/monetization pass-through). Fine for a personal/sideloaded APK; a **real risk for Play Store distribution** (YouTube-client apps get taken down; NewPipe ships via F-Droid for this reason). Decision kept honest: ship it as the personal-use feature it is, keep the kill switch, never claim official YouTube affiliation.
- The arms race is permanent: client shapes/PO tokens/DRM rotate. The design contains this — isolated module, data-driven ladder, soft-disable, fixture-based update tests.

---

## 6. Integration with the SIG search plan (last round)

YouTube becomes **rescue rung R0 (full-length), above iTunes R1 (30 s)** in `M4`:
`SIG unmet → YT rescue (search title+artist → verify artist+title → resolve stream) → iTunes → album route`.
Closes the loop on the reference failure: *"tu chaiye of atif aslam"* → S-RESCUED with the **official T-Series full-length video's audio**, reason line "Found on YouTube · full song", instead of a 30 s preview.

---

## 7. Gauntlet bars + rollout

**Bars (each named, measurable, test-locked):**
- **YT1 Search latency** — YT source search p95 ≤ 1.2 s (today's live: 0.52–0.55 s — 2× headroom).
- **YT2 Tap-to-audio** — YT track play starts ≤ 2.5 s p95 on device (ladder + range fetch).
- **YT3 Ad-free truth** — resolved audio stream contains no ad segments (assert via stream manifest/itag audit + 3-track soak).
- **YT4 Core isolation** — with YouTube force-disabled, the entire existing app passes every current test + device-lab check unchanged.
- **YT5 SIG rescue e2e** — the locked "tu chaiye of atif aslam" fixture resolves to a full-length YT track.
- **YT6 Kill-switch cleanliness** — 3-failure soft-disable banner appears; zero YT calls after disable.
- **YT7 No-core-regression** — all 126 tests stay green; catalog A/B shows zero rank drift.

**Rollout:**
- **P0 — Gate G1 + skeleton (1 device session):** run the client-ladder probe script on a real device (residential/mobile IP). **G1 = ≥1 client returns streamingData with a fetchable audio URL.** If G1 fails → plan halts, report honestly. If G1 passes → commit `youtube.ts` search + Search tab toggle (metadata-level, "resolve pending" rows).
- **P1 — Playback:** `resolveStream` ladder + RNTP integration + YT badge + stream-refresh in service + YT1–YT4 locks.
- **P2 — Resilience:** hidden-WebView PO minter + token cache + soft-disable kill switch + YT6 lock.
- **P3 — Deep integration:** SIG rescue R0 + YT radio (`next` endpoint) + optional Home shelf + YT5 lock.

**Pre-mortem:** device IP also bot-walled (→ G1 is the honest gate; mitigation ladder + PO minter + honest disable, never a fake feature) · RNTP rejects googlevideo headers (→ route through RNTP `headers` option — supported) · YTM parse drift (→ fixture-locked walkers break loudly in tests, not in production) · battery/bandwidth from hidden WebView (→ mint only on demand, cache hours, kill after 10 s).

**Sources:** `research/youtube/{yt_probe*.mjs, s1–s6.json}` · yt-dlp PO-token wiki · rustypipe docs · NewPipe PR #11955 · pytubefix PoToken docs · Invidious/Piped instance-status threads (2024–25) · InnerTune/Metrolist/ViMusic repos · rntp.dev docs.
