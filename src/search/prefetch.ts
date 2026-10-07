/**
 * SEARCH PREFETCH (MAGNUM OPUS F2) — at 3+ characters, the typeahead
 * pipeline fires in parallel with the existing 700ms debounce. By the
 * time the user presses Enter (or the debounce itself fires), the
 * retrieve LRU-200 cache already holds the ranked list and the real
 * search answers from cache (<50ms — locked).
 *
 * WRITE DISCIPLINE (house rule ③ — single-owner instrumentation): the
 * prefetch runs the REAL orchestrator with deps.disabled() === true.
 * The orchestrator gates ALL learning (S5 reads AND writes) on that
 * flag, so the prefetch is a pure read-through cache warmer: zero
 * ledger writes, zero lexicon persistence, zero mindbeat evidence.
 * The user-visible search remains the only writer.
 *
 * ABORT DISCIPLINE (lrclib P0-3 pattern): one AbortController per
 * prefetch generation; a NEWER prefetch aborts the older one; the
 * cancel happens on empty/clear and on unmount. The prefetch is NEVER
 * aborted by the real search — the real search rides the same
 * in-flight retrieve job (dedupe), and aborting it would kill the
 * shared work the user is waiting on.
 *
 * NO DOUBLE-FIRE: an identical query already in flight is never
 * re-issued (and even if it were, retrieve()'s in-flight dedupe would
 * share the network work — the guard just saves the CPU re-walk).
 */

import { useEffect } from 'react';
import { searchMusicV2, type EngineDeps, type SearchV2Result } from '../api/music';
import { SEARCH_PREFETCH } from '../ai/core/constants';

export type SearchEngine = typeof searchMusicV2;

// ── PURE CONTRACT ───────────────────────────────────────────────────────

/** The prefetch gate: trimmed query length ≥ SEARCH_PREFETCH.minLength. */
export function shouldPrefetch(query: string): boolean {
  return query.trim().length >= SEARCH_PREFETCH.minLength;
}

/** The prefetch's deps: learning hard-disabled, kv plumbing REAL.
 *  CRITICAL (found by tracing initSearchEngine): the engine's lazy init
 *  calls deps.kvGet() non-optionally to restore the SymSpell snapshot —
 *  a bare {disabled} stub would poison the memoized lexiconInitPromise
 *  and break EVERY later search. So the kv pair passes through (the
 *  restore is a read; the write side only fires via persistLexicon,
 *  which disabled() gates). With no real deps at all, crash-proof
 *  fallbacks keep the prefetch a no-op rather than a landmine. */
export function prefetchDeps(real?: EngineDeps): EngineDeps {
  return {
    ...(real ?? {}),
    kvGet: real?.kvGet ?? (async () => null),
    kvSet: real?.kvSet ?? (() => undefined),
    disabled: () => true,
  } as EngineDeps;
}

// ── RUNTIME ─────────────────────────────────────────────────────────────

let ctrl: AbortController | null = null;
let lastQuery = '';
let injectedEngine: SearchEngine | null = null; // tests only

/** Fire the prefetch for a query (no-op below the length gate). */
export function prefetchSearch(query: string, realDeps?: EngineDeps): void {
  const q = query.trim();
  if (!shouldPrefetch(q)) return;
  if (q === lastQuery && ctrl) return; // same query already flying
  cancelPrefetch();
  lastQuery = q;
  const myCtrl = new AbortController();
  ctrl = myCtrl;
  const engine = injectedEngine ?? searchMusicV2;
  const deps = prefetchDeps(realDeps);
  void engine(q, { signal: myCtrl.signal, deps })
    .catch(() => undefined)
    .finally(() => {
      if (ctrl === myCtrl) ctrl = null; // settled — the slot is free
    });
}

/** Cancel on empty/clear/unmount — the generation dies, nothing lands. */
export function cancelPrefetch(): void {
  if (ctrl) ctrl.abort();
  ctrl = null;
  lastQuery = '';
}

/** Test hooks. */
export function setSearchEngineForTests(fn: SearchEngine | null): void {
  injectedEngine = fn;
}
export function prefetchInFlight(): boolean {
  return ctrl != null;
}

// ── THE HOOK ────────────────────────────────────────────────────────────

/**
 * Wire into SearchScreen: fire at 3+ chars, cancel on empty/clear and
 * on unmount. `enabled` lets the caller gate it to the catalog path
 * (vibe mode and the YouTube source use different pipelines — a catalog
 * prefetch would warm a cache those paths never read). `getDeps` hands
 * the prefetch the host's real engine deps (kv plumbing for the lexicon
 * init; learning itself stays disabled — see prefetchDeps).
 */
export function usePrefetch(
  query: string,
  enabled: boolean,
  getDeps?: () => EngineDeps | undefined,
): void {
  useEffect(() => {
    const q = query.trim();
    if (!enabled || q.length < SEARCH_PREFETCH.minLength) {
      cancelPrefetch();
      return;
    }
    prefetchSearch(q, getDeps?.());
    // getDeps is intentionally not a dependency: it is only CALLED here
    // (fresh each fire), never compared — per-render identity must not
    // churn the prefetch generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, enabled]);
  useEffect(() => () => cancelPrefetch(), []); // unmount discipline
}

export type { SearchV2Result };
