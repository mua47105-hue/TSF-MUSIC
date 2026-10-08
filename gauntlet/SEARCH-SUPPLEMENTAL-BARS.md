# GAUNTLET BARS — SIG Search Fix + Supplemental Source
### Locked autonomously, verified in CI-grade runs (bun test), evidence-captured

**Baseline:** v3.3.0 (commit 18e23aa) · **Lab:** this repo · **Suite:** 159 tests (126 inherited + 33 new), all green · `bun run typecheck` clean

---

## The bars (each named, measurable, test-locked)

| Bar | Statement | Lock |
|---|---|---|
| **SI1** | "tu chaiye of atif aslam" (the real user failure) ends S-RESCUED with a verified "Tu Chahiye" top row — supplemental full-length when streamable, iTunes 30s otherwise | `tests/ai/search_sig_e2e.test.ts` |
| **SI2** | In the captured junk pool, the title-matching row outranks O'Meri Laila and Kon Mayate; no artist-only row carries "Best match for your search" | `tests/ai/search_rescue.test.ts` |
| **SI3** | "atif aslam" boundary-matches "Atif Aslam" and "Muhammad Atif Aslam", NEVER "Atif Aslam BD" (prefix-only rule) | `search_rescue.test.ts` |
| **SI4** | queryMatch counts title tokens only — O'Meri Laila scores 0 for the user's query | `search_rescue.test.ts` |
| **SI5** | Probes are connector-free ("tu chaiye", not "tu chaiye of") and unique (no wasted duplicate slot) | `search_rescue.test.ts` |
| **SI6** | "tu chaiye" expands to "tu chahiye" (≤2, deterministic, symmetric); known titles expand to nothing | `search_rescue.test.ts` |
| **SIG** | sigUnmet() contract: junk pool = unmet; pool with both-axes row = met; verifyRescueRow accepts only dual-verified rows | `search_rescue.test.ts` |
| **SC-A** | Supplemental search parses the LIVE response shape (both shelf variants); songs before videos; dups dropped; duration/artist/artwork mapped | the supplemental suite |
| **SC-B** | Client ladder picks audio-only (prefers AAC itag 140 over higher-bitrate opus), skips bot-walled clients, caches URLs (repeat = zero player calls), refresh invalidates | the supplemental suite |
| **SC-C** | Kill switch: 3 consecutive stream failures soft-disable the supplemental source for 1h, auto-retry, success clears the streak — supplemental breakage can never degrade the core | the supplemental suite |
| **CORE** | All 126 inherited v3.3.0 tests stay green — zero core regression | full suite |

## Live verification (this sandbox, real networks)

- Organic pool for the user's query: probes `["tu chaiye","tu chaiye atif aslam","tu chahiye","tu chaahiye"]`, 38 rows, title-matching rows on top, no wrong-artist promotion.
- sigUnmet detected → rescue ladder: supplemental (bot-walled from THIS datacenter IP — expected, see guide) → **iTunes rescued in ~0.8–1.0 s** → final #1 = "Tu Chahiye | Pritam & Atif Aslam".
- Live supplemental search: 8 tracks + 2 albums parsed from the current (morphed) response shape.
- Honest degradation verified end-to-end with real APIs.

## Bar for the device session (Gate G1 — cannot be proven here)

From a real phone on residential/mobile data:
1. ≥1 client persona in the supplemental adapter returns streaming data with a fetchable audio URL (stream resolve → ok:true).
2. The rescued top result for "tu chaiye of atif aslam" arrives via the supplemental rung (full length, ad-free).
If G1 fails, the app must still behave exactly as this sandbox does: iTunes rescue + honest labels, the supplemental source soft-disabled.

---

## R3 LOCKS (main-repo port round — the supplemental lock suite)

The port of lab.1–lab.4 into the main repo went through its own gauntlet
round: a fresh-context adversarial critic found 2 P0 + 4 P1 + 7 P2, every
one machine-proven. All P0/P1 (and the cheap P2s) are fixed with locks:

| Lock | Statement | Finding it locks |
|---|---|---|
| L-P0-1 | a successful rescue is never discarded by the S4 recovery ladder (no relaxed junk over the verified answer, no fabricated `rescued` state) | critic P0-1 |
| L-P0-2 | a rescued row dropped by cluster-dedupe is re-injected at rank 1 | critic P0-2 |
| L-P1-1 | the signatureCipher decipher assembles + runs (was dead code: SyntaxError on every invocation) | critic P1-1 |
| L-P1-2 | a systemic bot-wall skips the unstreamable title-only fallback → iTunes preview rung answers | critic P1-2 |
| L-P1-3 | kill-switch discipline: search gated, per-video UNPLAYABLE never disables, all-cooldown walls count, honest `network`/`bot-walled` reasons | critic P1-3 |
| L-ORDER | ladder order supplemental → itunes → variant → album, proven by call order | critic P1-4 (unlocked bar) |
| L-FLOOR | AUTHORITY_FLOOR per-source rules on the variant rung (known-small rejected, ≥250k accepted) | critic P1-4 (unlocked bar) |
| L-E2E | the headline "tu chaiye" title-only rescue end-to-end + song-kind rows beat 6.2M-view lyric videos | port refinement |

Suite: **173 tests / 759 expects / 15 files** (159 lab + 14 R3 locks).
Live engine probe (datacenter, real APIs): both "tu chaiye" and "tu chaiye
of atif aslam" end `sigState='rescued'` with the canonical "Tu Chahiye —
Pritam & Atif Aslam" on top (iTunes rung from a DC IP — the documented
bot-wall class; the supplemental rung resolves on residential/device IPs).
Web device lab: **48/48 checkpoints × 2 devices, zero console errors**
(36 v3.3.0 + 12 new v3.4.0: rescued label, canonical top row, source
toggle, supplemental mode rows + song badge, rescued row plays end-to-end).
