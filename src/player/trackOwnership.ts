/**
 * TRACK OWNERSHIP (v5.2.1 FIX-B1) — the pure single-owner law behind the
 * provider's transition instrumentation.
 *
 * THE BUG CLASS (forensic audit M5 survived): PlayerProvider gates its
 * ledger writes on `AppState === 'active'` and the background service
 * gates its own on the inverse — but no lock protected the CONTRACT. A
 * phantom double-instrumentation (both owners firing on one transition)
 * manufactures a fake 0ms INSTANT_REJECT — fabricated evidence, the one
 * thing this app must never produce.
 *
 * THE LAW: for any one track transition, EXACTLY ONE owner writes:
 *   - the provider, only while the app is FOREGROUNDED ('active');
 *   - the service, only otherwise.
 * The same-transition guard (no id, unchanged id) belongs to the caller's
 * effect bookkeeping and is encoded here too, so both rules live in one
 * testable place. Pure — no React, no RN — locked in
 * tests/fix_v521_waveB_locks (dual-owner simulation + source laws pinning
 * BOTH call sites: PlayerProvider.tsx and service.ts).
 */

export function providerOwnsTransition(
  appState: string | undefined,
  activeId: string | undefined,
  prevTrackId: string | undefined,
): boolean {
  if (!activeId) return false; // nothing playing — nothing to own
  if (activeId === prevTrackId) return false; // same track re-emitted
  return appState === 'active'; // background transitions belong to the service
}

/** The service's mirror rule: it owns exactly the transitions the
 *  provider cannot see (and never steals a foreground one). */
export function serviceOwnsTransition(appState: string | undefined): boolean {
  return appState !== 'active';
}
