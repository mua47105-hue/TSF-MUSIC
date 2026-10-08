# SUPPLEMENTAL CATALOG RFC — "The Second Catalog"
### TSF Music · Full-length supplemental playback, researched from the open-source ecosystem, built as our own module
**Version 1.1 · Every feasibility claim below is live-verified or source-cited**

> **STATUS: SHIPPED — v3.4.0** (hardened through v3.4.5).
> The three-client ladder, the hidden-WebView attestation minter
> and the kill-switch discipline are live in production. This document
> is preserved as the original engineering RFC — the ecosystem research,
> the feasibility gates and the design decisions behind the shipped
> module. Read it as history, not as a TODO list. See
> [CHANGELOG.md](CHANGELOG.md) for what shipped.

---

## 0. Executive summary

**The ask:** a supplemental catalog — songs from a large public music
platform, playable completely ad-free, built by deep-diving the
open-source projects that already solved this and pinning the best
approach as our own integrable module.

**The verified reality (probed live today):**
- The platform's **search works** from a pure client, no auth, no
  attestation token: web search 524 ms, music-catalog search 545 ms with
  *better* metadata than the primary catalog — Song/Video/Album entities,
  full artist lists, play counts, duration.
- **Stream extraction is an arms race** (attestation tokens / bot-wall).
  From this sandbox's datacenter IP every playback client answers
  `LOGIN_REQUIRED — Sign in to confirm you're not a bot`. This is the
  *documented* datacenter-IP behavior; the OSS apps that work run on
  **real devices with residential/mobile IPs**, where the client ladder
  still passes today. Verifying the ladder on a real device is therefore
  **P0 Gate G1** — the go/no-go measurement before any UI is built.
- **The payoff is exactly the last round's wound:** "Tu Chahiye" (Atif
  Aslam) — the song the primary catalog lost — is on the platform's
  official channel upload with **100M+ views**, first result, 524 ms.
  The supplemental source becomes the app's *full-length* rescue provider
  (iTunes rescue only offers 30 s previews).

**The verdict on "use the open-source projects":** we deep-dived the
major families and **pin none of them as a dependency — we pin their
*technique*** and build a minimal, isolated adapter module (~300 LOC,
same culture as our own on-device stream-decryption client). Rationale
in §2.

---

## 1. Evidence

### 1.1 Live probes (today; captures in `research/`)

| Probe | Client | Result |
|---|---|---|
| Search `tu chahiye atif aslam` | web | ✅ 524 ms, 18 results, official upload #1 (100M+ views, 3:51) |
| Music-catalog search, same query | web-music persona | ✅ 545 ms, 31 items — Song("Tu Chahiye · Pritam, Atif Aslam & Amitabh Bhattacharya"), Video, Album("Hits Of Atif Aslam"), mixes, play counts |
| Player `WTLLym2wzIM` | mobile personas (full device context) | ❌ HTTP 400 (shape) — needs the exact internal-API request shape |
| Player | remaining personas | ❌ `LOGIN_REQUIRED — confirm you're not a bot` (datacenter IP) |
| Player | embedded/TV personas | ❌ "no longer supported" / UNPLAYABLE |

### 1.2 Web-verified facts (6 searches, sources on disk)

- **Client-attestation tokens are the enforcement mechanism** — the
  open-source extraction community documents enforcement "rolling out";
  since August 2024 the platform requires attestation tokens for streams
  from web-based clients (403 otherwise); by 2026 tokens are required for
  *most* internal-API clients, mobile included. Tokens are minted by the
  platform's client-integrity systems to attest a genuine client.
- **The reference extractor merged token support** and keeps working
  on-device — proof the device-IP + client-ladder approach survives.
- **Public proxy architectures are dead/dying** (2024–2025: instances
  blocked, IP blacklists, "there's no more working instances") →
  **proxy architectures are disqualified** for a ship-it app.
- **The established OSS clients** prove the product: ad-free third-party
  music clients on Android, F-Droid/GitHub, large userbases.
- **DRM A/B** (Mar 2025): some personas now get DRM-only streams → the
  client ladder must be data-driven and updateable, never hardcoded to
  one persona.
- **RNTP** plays remote progressive URLs + HLS (rntp.dev) — the platform's
  progressive audio itags (AAC / opus) are ranged URLs, i.e. exactly what
  RNTP already does for our primary-catalog CDN files.

---

## 2. The architecture decision — what we "pin" (and why)

| Approach (OSS family) | Verdict | Reason |
|---|---|---|
| **Public proxy APIs** | ❌ Rejected | Public instances broken/blacklisted; self-host contradicts the 100%-on-device no-server architecture |
| **Native extractor library** | ❌ Rejected as dependency | Java library — would need a native-module wrapper; heavy; but its *client ladder + attestation token* technique is the reference we copy |
| **Community internal-API client (npm)** | ⚠️ Not as a runtime dep | Full-featured but large, needs RN fetch/URL shims, and its integrity path assumes Node VM; excellent as the *protocol reference* we mirror |
| **Our own minimal client + hidden-WebView token minter** | ✅ **CHOSEN** | ~300 LOC, fully isolated (supplemental breakage can never touch the primary-catalog core), matches the app's on-device craft (we already hand-roll on-device decryption), lets us keep only the 3 endpoints we need |

**Pinned technique stack (from the OSS ecosystem, cited):**
1. Internal `search` + `player` endpoints with per-client context headers
   (the community-client pattern).
2. **Client ladder** for streams: several client personas, newest-working
   wins; ladder order is data we can reorder without redesign (the
   DRM-rotation lesson).
3. **Attestation-token minting via hidden WebView** running the platform's
   integrity bootstrap (the technique the major OSS extractors use),
   token cached ~hours, attached when a client demands it.
4. **Stream-URL refresh on 403/expiry** — stream URLs are IP-bound +
   time-limited; identical to our existing stale-URL recovery pattern in
   `service.ts`.
5. On-device playback through RNTP (already proven in-app for ranged CDN
   audio).

---

## 3. Product design — the section itself

1. **Search tab source toggle** (top, under the field): segmented
   `Catalog | Supplemental`.
   - *Catalog* = the primary-catalog engine (+iTunes), untouched.
   - *Supplemental* = the platform's music-catalog search: Song rows
     first (artists, duration, plays), then Videos (lyric/official),
     Albums. Filters: duration ≤ 15 min for "song" default view
     (jukeboxes/compilations excluded), explicit-content left as-is with
     the existing "E" badge convention (search is already user-intent,
     not filtered).
2. **Track rows**: thumbnail (hqdefault→mqdefault upgrade), channel/artist
   line, duration chip, **source badge** (mirrors the existing "E" badge
   style). Song entities show "Song · Artist A, Artist B"; videos show
   "Video · channel".
3. **Playback**: tap → resolve stream (client ladder, ≤2.5 s budget) →
   RNTP queue entry with the supplemental source tag. Tracks mix freely
   in the queue with primary-catalog/itunes tracks; MiniPlayer/Player/
   queue sheets work unchanged; artwork from the platform.
4. **Player screen**: supplemental tracks show a small "supplemental ·
   ad-free" source line; like/queue/radio work (radio = the related-items
   endpoint, same API family as search — P3).
5. **Home**: no new rails in P0–P1 (protect the flat home); P3 adds an
   optional "supplemental finds" shelf only if search usage proves the
   section.
6. **Kill switch**: Settings toggle (default ON) + automatic soft-disable
   after 3 consecutive stream failures (banner: "supplemental source
   unavailable right now — catalog still works"), auto-retrying hourly.
   Supplemental breakage can *never* degrade the core app.

---

## 4. Module design

**The supplemental adapter** (new, ~300 LOC, zero deps):
- `search(query, filter)` — music-catalog search → Song/Video/Album
  entities → `Track{source:'supplemental', externalId, ...}` (search =
  the two endpoints verified working today).
- `resolveStream(externalId)` — client ladder (§2) against `player`;
  returns best audio-only itag (bitrate-sorted, prefer AAC → opus),
  caches `(id → {url, expiresAt})` LRU-100.
- `refreshStream(track)` — 403/expiry recovery for the background
  service.
- Parsers — deterministic walkers (unit-tested against fixture JSON
  committed from today's captures).
- Client context constants versioned in ONE place (`CLIENTS`) — updates
  ship as app updates (no server, by design).

**The token minter** (P2, bounded): hidden WebView that loads the
platform's integrity bootstrap and mints attestation tokens on demand →
cache in ledger kv (snapshot-style) → injected when the chosen client
requires a token. Failure = skip token = fall down ladder = honest
soft-disable; never a crash.

**`src/player/PlayerProvider.tsx` + `service.ts`** (surgical edits):
accept supplemental-source tracks; extend the existing stale-URL
recovery branch to call `refreshStream`; queue mixing is already
source-agnostic.

**`src/screens/SearchScreen.tsx`**: the segmented toggle + supplemental
row rendering + source badge (all additive; device-lab testIDs
untouched).

**Downloads: out of scope, deliberately.** Streaming-only for the
supplemental source (both ToS-risk and complexity); the primary
catalog's 320 kbps downloads remain the offline path.

---

## 5. Legal & risk honesty (must be said plainly)

- This is the same legal class as the established open-source clients:
  it *works on-device* but **violates the platform's terms of service**
  (streams outside official clients; no ad/monetization pass-through).
  Fine for a personal/sideloaded APK; a **real risk for Play Store
  distribution** (client apps for this platform get taken down; the
  reference extractors ship via F-Droid for this reason). Decision kept
  honest: ship it as the personal-use feature it is, keep the kill
  switch, never claim official affiliation.
- The arms race is permanent: client shapes/attestation/DRM rotate. The
  design contains this — isolated module, data-driven ladder,
  soft-disable, fixture-based update tests.

---

## 6. Integration with the SIG search plan (last round)

The supplemental source becomes **rescue rung R0 (full-length), above
iTunes R1 (30 s)** in `M4`:
`SIG unmet → supplemental rescue (search title+artist → verify
artist+title → resolve stream) → iTunes → album route`.
Closes the loop on the reference failure: *"tu chaiye of atif aslam"* →
S-RESCUED with the **official full-length upload's audio**, reason line
"Found on the supplemental source · full song", instead of a 30 s
preview.

---

## 7. Gauntlet bars + rollout

**Bars (each named, measurable, test-locked):**
- **SC1 Search latency** — supplemental search p95 ≤ 1.2 s (today's
  live: 0.52–0.55 s — 2× headroom).
- **SC2 Tap-to-audio** — supplemental track play starts ≤ 2.5 s p95 on
  device (ladder + range fetch).
- **SC3 Ad-free truth** — resolved audio stream contains no ad segments
  (assert via stream manifest/itag audit + 3-track soak).
- **SC4 Core isolation** — with the supplemental source force-disabled,
  the entire existing app passes every current test + device-lab check
  unchanged.
- **SC5 SIG rescue e2e** — the locked "tu chaiye of atif aslam" fixture
  resolves to a full-length supplemental track.
- **SC6 Kill-switch cleanliness** — 3-failure soft-disable banner
  appears; zero supplemental calls after disable.
- **SC7 No-core-regression** — all 126 tests stay green; catalog A/B
  shows zero rank drift.

**Rollout:**
- **P0 — Gate G1 + skeleton (1 device session):** run the client-ladder
  probe script on a real device (residential/mobile IP). **G1 = ≥1
  client returns streaming data with a fetchable audio URL.** If G1
  fails → plan halts, report honestly. If G1 passes → commit the search
  + Search tab toggle (metadata-level, "resolve pending" rows).
- **P1 — Playback:** stream-resolution ladder + RNTP integration +
  source badge + stream-refresh in service + SC1–SC4 locks.
- **P2 — Resilience:** hidden-WebView token minter + token cache +
  soft-disable kill switch + SC6 lock.
- **P3 — Deep integration:** SIG rescue R0 + supplemental radio
  (related-items endpoint) + optional Home shelf + SC5 lock.

**Pre-mortem:** device IP also bot-walled (→ G1 is the honest gate;
mitigation ladder + token minter + honest disable, never a fake
feature) · RNTP rejects the platform's stream headers (→ route through
RNTP `headers` option — supported) · parse drift (→ fixture-locked
walkers break loudly in tests, not in production) · battery/bandwidth
from hidden WebView (→ mint only on demand, cache hours, kill after
10 s).

**Sources:** `research/` probe scripts + captures · the open-source
extraction community's documentation (token wiki, client-integrity
notes, PR history, instance-status threads 2024–25) · the established
OSS client repos · rntp.dev docs.
