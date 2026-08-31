/**
 * YT APPEND CONTROLLER — the single-flighted continuation walk behind
 * YouTube search pagination (R8-P3).
 *
 * Extracted from SearchScreen so the state machine — single-flight,
 * transport-failure retry semantics, stale-generation swallows, honest
 * end-of-catalog — is behaviorally testable (the screen keeps only the
 * React wiring; ports below are all stable refs/setters).
 *
 * Semantics locked here:
 *   • single-flight: concurrent append() calls share ONE fetchMore —
 *     the scroll hook and the eager top-up can never double-walk the
 *     same continuation.
 *   • transport failure (`error: true` on the page result): the
 *     continuation token is KEPT and hasMore stays true — the next
 *     scroll retries; a network blip is not end-of-catalog (gauntlet
 *     round-1 P1-1).
 *   • honest end: no continuation left → hasMore false + end note.
 *   • stale generation: no state publishes at all (a late page for a
 *     query the user already left must not poison the live results).
 *   • a productive append clears any stale error note (round-2 NEW-10).
 */
import type { Track } from '../types';
import { mergeUniqueTracks } from '../api/saavn';

export interface YtAppendPage {
  tracks: Track[];
  continuation?: string;
  error?: boolean;
}

export interface YtAppendPorts {
  /** fetch page 2+ (ytSearchMusicMore wrapper) */
  fetchMore: (cont: string, signal?: AbortSignal) => Promise<YtAppendPage>;
  /** current continuation token (null = catalog exhausted) */
  getCont: () => string | null;
  setCont: (c: string | null) => void;
  /** live rows mirror (the merge base — NOT the state, the ref) */
  getRows: () => Track[];
  /** publish merged rows */
  publishRows: (rows: Track[]) => void;
  /** publish pagination state */
  publishState: (s: { hasMore: boolean; endNote: string | null }) => void;
  /** is this search generation still the current one? */
  isCurrentGen: (gen: number) => boolean;
  /** abort signal of the generation that started this append */
  getSignal: () => AbortSignal | undefined;
  /** footer spinner (silent top-ups pass undefined behavior) */
  setBusy?: (b: boolean) => void;
}

export const YT_END_NOTE = "That's everything YouTube found";
export const YT_RETRY_NOTE = "Couldn't load more — check your connection";

export class YtAppendController {
  /** single-flight slot — KEYED BY GENERATION: a walk for a live query
   *  shares with same-gen callers, but a NEW generation never queues
   * behind a doomed one (the old walk's results are stale-swallowed
   * anyway; the new query's top-up must fire immediately). */
  private inFlight: { gen: number; p: Promise<void> } | null = null;

  constructor(private ports: YtAppendPorts) {}

  /** Walk one continuation page. `gen` is the search generation the
   *  walk belongs to; `silent` suppresses the busy spinner (the eager
   *  top-up paints rows without flashing the footer). */
  append(gen: number, opts?: { silent?: boolean }): Promise<void> {
    if (this.inFlight && this.inFlight.gen === gen) return this.inFlight.p; // same-gen single-flight
    const cont = this.ports.getCont();
    if (!cont) return Promise.resolve();
    if (!opts?.silent && this.ports.setBusy) this.ports.setBusy(true);
    const slot: { gen: number; p: Promise<void> } = { gen, p: Promise.resolve() };
    slot.p = (async () => {
      try {
        const page = await this.ports.fetchMore(cont, this.ports.getSignal());
        if (!this.ports.isCurrentGen(gen)) return; // stale — no writes
        if (page.error) {
          // transport failure — keep the token, stay retryable
          this.ports.publishState({ hasMore: true, endNote: YT_RETRY_NOTE });
          return;
        }
        if (page.tracks.length) {
          const merged = mergeUniqueTracks(this.ports.getRows(), page.tracks);
          this.ports.publishRows(merged);
        }
        this.ports.setCont(page.continuation ?? null);
        this.ports.publishState(
          page.continuation
            ? { hasMore: true, endNote: null } // clears a stale retry note
            : { hasMore: false, endNote: YT_END_NOTE },
        );
      } catch {
        // fetchMore resolves (never rejects) — a throw here is ours and
        // is treated exactly like a transport failure
        if (this.ports.isCurrentGen(gen)) {
          this.ports.publishState({ hasMore: true, endNote: YT_RETRY_NOTE });
        }
      } finally {
        if (this.inFlight === slot) this.inFlight = null; // a newer gen took the slot
        if (!opts?.silent && this.ports.setBusy && this.ports.isCurrentGen(gen)) {
          this.ports.setBusy(false);
        }
      }
    })();
    this.inFlight = slot;
    return slot.p;
  }
}
