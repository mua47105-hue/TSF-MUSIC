# LAB TESTING GUIDE — SIG Search Fix + Supplemental Source

> **Historical context**: this guide was written for the staging repo
> (TSF-MUSIC-LAB) while the v3.4.0 line was device-verified there. The
> work has since been ported into this repo and hardened (v3.4.0 — see
> CHANGELOG). Kept for the lab-repo workflow it documents: lab releases
> are signed with a DIFFERENT key (`tsflocal`) than this repo's releases
> (`mua47105-hue`) — Android refuses silent upgrades across identities,
> so uninstall a lab build before installing a main release (and vice
> versa). The lab repo: https://github.com/tsftraders3-ops/TSF-MUSIC-LAB

**What this repo was:** the staging repo. Everything here was verified by 159 automated tests + live network E2E before porting to the main repo.

---

## 1. What changed (vs your main v3.3.0)

**Search (the "tu chaiye of atif aslam" failure):**
- Connectors ("of/by/from/ka/ki/ke…") no longer pollute the title probe.
- Probes are unique + bounded; spelling variants ("chaiye"→"chahiye") ride the fan-out.
- queryMatch counts TITLE tokens only — an Atif song with a wrong title can no longer score 40% "match".
- Artist matching is word-boundary with a prefix-only rule ("Muhammad Atif Aslam" matches; "Atif Aslam BD" never).
- Disambiguation override v2: promotion requires BOTH artist AND title match.
- Honest gate tightened: junk can no longer defeat it via artistMatch alone.
- NEW SIG rescue ladder when a song+artist query finds no both-axes row:
  **Supplemental source (full length) → iTunes (30s preview) → variant spellings → album route** (bounded 3s).
- UI declares its state: "Found on the supplemental source · full song" / "Found via Apple Music · 30s preview" / "Songs matching …" + artist chips + honest "isn't available in the primary catalog" note.

**Supplemental source (new):**
- A minimal isolated adapter — own internal-API client (search + client-ladder stream resolve + refresh + kill switch). No new dependencies.
- Search tab now has a **Catalog | Supplemental** toggle. Supplemental rows carry artist/duration/views and play through RNTP like any track; queue mixing works.
- Downloads are intentionally disabled for supplemental tracks (streaming-only).
- Kill switch: 3 stream failures → the supplemental source soft-disables for 1h; the catalog keeps working untouched.

## 2. Run it

```bash
bun install
bun run typecheck   # must be clean
bun test            # 159 tests, all green
bun run android     # build to your device (Expo 52 bare)
```

## 3. Device test script (~10 minutes)

1. **The original failure:** Search tab → Catalog → type `tu chaiye of atif aslam`
   - EXPECT: top result "Tu Chahiye" with the "Found on the supplemental source · full song" line (device IP should pass where the datacenter sandbox was bot-walled). If your ISP is also challenged, you'll see the iTunes preview version with an honest label — that is Gate G1's honest fallback, not a bug.
   - Tap play → full song (or 30s preview), no ads.
2. **Supplemental section:** toggle **Supplemental** → type `tu chahiye atif aslam` → songs list renders → tap play → audio plays with zero ads.
3. **Disambiguation:** Catalog → `kesariya arijit singh` → Arijit's Kesariya is top (not the wrong-artist same-name rows).
4. **Typo class:** Catalog → `tu chahiye` spelled `tu chaiye` alone → variant probe still finds title-matching rows; did-you-mean appears where applicable.
5. **No regression:** search `arijit singh` (artist search still resolves), `tum hi ho` (top result correct), lyric fragment `hum tere bin ab reh nahi sakte` (Tum Hi Ho with lyric chip).
6. **Kill switch (optional):** airplane-mode mid-playback 3× → "supplemental source unavailable" state, catalog search still works; it auto-retries after 1h.
7. **Queue mixing:** from Catalog results play a song → from Supplemental results "play next" a supplemental track → both play in one queue.

## 4. Known limits (honest)

- Datacenter IPs are bot-walled by the platform for stream extraction (proven in sandbox). Real devices on home/mobile data are the documented-working environment (the established open-source clients live on this). Gate G1 in `gauntlet/SEARCH-SUPPLEMENTAL-BARS.md` is the decisive check.
- Supplemental track metadata: some video rows show movie-star names inside the artist line (subtitle parsing quirk). Cosmetic; search verification is unaffected.
- Supplemental playback of age-restricted/premium videos falls back down the ladder like any other failure.
- Client-attestation hardening (hidden-WebView minter) is planned as the NEXT phase if your device session shows ISP-level bot-walling.

## 5. Evidence index

- Bars + locks: `gauntlet/SEARCH-SUPPLEMENTAL-BARS.md`
- SIG design: `SEARCH-INTENT-RESCUE-PLAN.md` (repo root)
- Supplemental source design: `docs/SUPPLEMENTAL-CATALOG-RFC.md`
- Test suites: `tests/ai/search_rescue.test.ts`, the supplemental-source suite, `tests/ai/search_sig_e2e.test.ts`

## 6. Signing identity of lab APKs (run #2 onward)

- The lab repo now signs release APKs with a **lab-specific keystore** (alias `tsflocal`,
  secrets configured 2026-08-30 after run #1 failed on missing secrets).
- If you previously installed the **v3.3.0 APK from the main repo** (different signing
  identity), Android will REFUSE to upgrade in place — uninstall the old app once, then
  install the lab APK. Staging-only concern; the main repo keeps its original identity.
- CI now has a **fail-fast preflight** step: broken/missing signing secrets fail in
  seconds with a `::error::` naming the exact secret — instead of dying inside
  `:app:packageRelease` after a ~17-minute build (run #1's failure mode).
