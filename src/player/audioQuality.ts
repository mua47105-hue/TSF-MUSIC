/**
 * AUDIO QUALITY / DATA SAVER (Task 28 · godmode) — the sync bridge between
 * the persisted preference and the stream resolver.
 *
 * WHY A MODULE-LEVEL FLAG: resolveStreamUrl() is synchronous and sits on the
 * play hot path — awaiting AsyncStorage there would add a read to EVERY track
 * start (and an await would ripple through every caller, the exact class of
 * core disturbance the v4.0.4 rollback taught us to avoid). Instead the flag
 * loads once at player boot and toggles live when the user flips the switch;
 * until it loads the app behaves exactly as before (320 upgrade ON), so the
 * default path is bit-identical to v4.0.5.
 */

import { getDataSaver, setDataSaver } from '../storage/store';

let active = false; // default: full quality (v4.0.5 behavior)
type Listener = (on: boolean) => void;
const listeners = new Set<Listener>();

/** One-shot boot read; fire-and-forget safe. */
export function initDataSaver(): void {
  void getDataSaver()
    .then((v) => {
      active = v;
      listeners.forEach((fn) => fn(active));
    })
    .catch(() => undefined);
}

/** Synchronous hot-path check used by the stream resolvers. */
export function dataSaverActive(): boolean {
  return active;
}

/** Flip the preference: persists, updates the flag, notifies the UI. */
export async function setDataSaverActive(on: boolean): Promise<void> {
  active = on;
  listeners.forEach((fn) => fn(active));
  await setDataSaver(on).catch(() => undefined);
}

export function subscribeDataSaver(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
