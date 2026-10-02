/**
 * perf — the tiny lab instrument.
 *
 * The Android E2E lab (.github/workflows/android-e2e.yml) greps logcat for
 * [TSF-PERF] lines and pairs them into latency metrics:
 *
 *   js-boot         bundle evaluation started (module scope of App.tsx)
 *   fonts-ready     app is about to render the first frame
 *   home-first-data Front Page received its first real data
 *   search-run <q>  a search request left the client
 *   search-results <n>  results painted (n rows)
 *   play-request <id>   a play tap entered playQueue
 *   queue-started <id>  RNTP queue built + play() called
 *   skip-request    the user pressed next
 *   track-active <id>   RNTP made a track the active one
 *   audio-playing <id>  playback state actually reached "playing"
 *
 * Metrics computed by scripts/e2e/parse_perf.py:
 *   time-to-audio  = play-request → next audio-playing
 *   skip latency   = skip-request → next audio-playing   (the Spotify-grade bar)
 *   search latency = search-run → first search-results
 *
 * Cost: one string concat + one console.log per user action. Negligible.
 * RN release builds keep console.log (visible under the ReactNativeJS
 * logcat tag) — no dev gate on purpose, the lab runs release builds.
 */

export const PERF_T0 = Date.now();

export function perfMark(event: string, detail: string | number = ''): void {
  const suffix = detail !== '' ? ` detail=${detail}` : '';
  console.log(`[TSF-PERF] t=${Date.now() - PERF_T0} event=${event}${suffix}`);
}
