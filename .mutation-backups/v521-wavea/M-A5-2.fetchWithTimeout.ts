/**
 * PROVIDER FETCH DISCIPLINE (v5.2.1 FIX-A4 + FIX-A5) — the bounded-fetch
 * seam for every network call in the provider layer.
 *
 * THE BUG CLASS (forensic audit): saavn.ts:35, youtube.ts:143/252/781 and
 * itunes.ts:34 awaited bare `fetch` with no timeout — a hung CDN socket
 * stalled a track start indefinitely. And itunes.ts accepted `_signal`
 * and silently ignored it: a typed lie (the signature promised abort
 * behavior it never delivered).
 *
 * THE FIX, in one place:
 *  - Every provider fetch is bounded by PROVIDER_FETCH_TIMEOUT_MS (10s,
 *    the tuning number lives in src/ai/core/constants.ts — house law 4).
 *    The bound is a SETTLE-ONCE guarantee: the caller's promise resolves
 *    or rejects within the budget even when the inner fetch misbehaves
 *    and never honors its abort signal (the abandoned promise is dropped,
 *    never leaks an unhandled rejection).
 *  - A caller-supplied signal is HONORED end-to-end: it aborts the real
 *    request (via the combined controller) AND settles the caller's
 *    promise immediately. No more `_signal` (FIX-A5).
 *  - `fetchImpl` is injectable: youtube.ts hands its `setYtFetch` seam
 *    through, so the existing stub discipline keeps working; bun tests
 *    inject never-resolving fetches to prove both guarantees.
 *
 * Web parity (house rule 15 precedent, src/api/recording.ts): there is
 * deliberately NO src/webmocks/fetchWithTimeout.ts mirror — nothing here
 * is environment-specific to fake. The web harness has a real `fetch`,
 * and bounding it is exactly as correct there as on device.
 */

import { PROVIDER_FETCH_TIMEOUT_MS } from '../ai/core/constants';

export interface FetchWithTimeoutOptions {
  /** Override the 10s budget (tests use ~40ms to prove the abort fires). */
  timeoutMs?: number;
  /** The inner fetch — youtube.ts threads its setYtFetch seam here. */
  fetchImpl?: typeof fetch;
}

/**
 * fetch(), bounded and cancellable: the caller's promise settles at
 * `timeoutMs` even against a hung socket, and a caller-supplied
 * `init.signal` cancels the request the moment it fires. The caller's
 * existing catch ladder turns the abort into the honest per-surface
 * error (empty page, error:true, rescue path) — this layer adds no new
 * failure modes, only a ceiling.
 */
export function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  options: FetchWithTimeoutOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? PROVIDER_FETCH_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;
  const outer = init.signal;

  // An already-aborted outer signal must never open a request at all.
  if (outer?.aborted) {
    return Promise.reject(new Error('aborted before start'));
  }

  // The combined controller: the request ITSELF stops on the outer
  // signal's fire or the timeout — whichever comes first.
  const ctrl = new AbortController();
  const abortRequest = () => ctrl.abort(new Error('aborted'));

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      outer?.removeEventListener('abort', onOuterAbort);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    function onOuterAbort() {
      abortRequest(); // the real request stops here (native fetch honors it)
      settle(() => reject(new Error('aborted')));
    }

    timer = setTimeout(
      () =>
        settle(() =>
          reject(new Error(`provider fetch timeout after ${timeoutMs}ms`)),
        ),
      timeoutMs,
    );

    if (outer) outer.addEventListener('abort', onOuterAbort, { once: true });

    doFetch(url, { ...init, signal: ctrl.signal }).then(
      (res) => settle(() => resolve(res)),
      (err) => settle(() => reject(err)),
    );
  });
}
