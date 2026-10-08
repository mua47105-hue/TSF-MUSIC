/**
 * SESSION MEMORY (MAGNUM OPUS · F15) — "resume Gym".
 *
 * The last few listening sessions, snapshotted with their vibe + seed
 * tracks so the wrist can pick a session back up tomorrow. Pure core
 * over an INJECTED store (the appTables `session_snapshots` table —
 * its schema shipped with Wave 2's appTables); the web harness runs
 * the same service on Maps.
 *
 * LAWS:
 *  - Snapshot ONLY on app background AND only when the session has
 *    ≥ SESSION_MEMORY.minTracks tracks (a 2-song drive is not a
 *    session worth remembering).
 *  - Max SESSION_MEMORY.maxSnapshots (3), FIFO by endedAt — the oldest
 *    memory makes room, never the newest.
 *  - resumeSession mixes ≥70% of the session's QUEUED spine with ≤30%
 *    fresh catalog rows matching the vibe (mixResumeSession) — a resume
 *    that replaces your session with strangers is not a resume.
 *  - Factual user data: the kill switch does not gate the snapshots
 *    (same posture as stories/bookmarks).
 */

import { SESSION_MEMORY } from './core/constants';

export interface SessionSnapshot {
  /** epoch ms of the snapshot (unique per snapshot — the row id) */
  id: string;
  /** the session brain's vibe label (WARMUP / FLOW / …) */
  vibeLabel: string;
  /** the queue's track ids, in order (the session's spine) */
  seedTrackIds: string[];
  startedAt: number;
  endedAt: number;
}

/** The minimal persistence contract the SQLite adapter fulfills. */
export interface SessionSnapshotsStore {
  put(snapshot: SessionSnapshot): Promise<void>;
  all(): Promise<SessionSnapshot[]>;
  del(id: string): Promise<void>;
}

/** A session qualifies when it carried at least minTracks tracks. */
export function shouldSnapshot(trackCount: number): boolean {
  return trackCount >= SESSION_MEMORY.minTracks;
}

/** FIFO eviction: the ids to delete so at most `max` snapshots remain. */
export function evictFIFO(all: SessionSnapshot[], max: number = SESSION_MEMORY.maxSnapshots): string[] {
  const ordered = [...all].sort((a, b) => a.endedAt - b.endedAt);
  return ordered.slice(0, Math.max(0, ordered.length - max)).map((s) => s.id);
}

export interface SessionSnapshotsService {
  /** Save one snapshot (id = endedAt); evicts FIFO beyond the cap. */
  save(snapshot: Omit<SessionSnapshot, 'id'> & { id?: string }): Promise<SessionSnapshot>;
  list(): Promise<SessionSnapshot[]>; // newest-ended first
  get(id: string): Promise<SessionSnapshot | null>;
  remove(id: string): Promise<boolean>;
  count(): Promise<number>;
}

export function createSessionSnapshots(store: SessionSnapshotsStore): SessionSnapshotsService {
  return {
    async save(partial) {
      const snapshot: SessionSnapshot = {
        id: partial.id ?? String(partial.endedAt),
        vibeLabel: partial.vibeLabel,
        seedTrackIds: partial.seedTrackIds.slice(0, SESSION_MEMORY.maxSeedTracks),
        startedAt: partial.startedAt,
        endedAt: partial.endedAt,
      };
      await store.put(snapshot);
      for (const id of evictFIFO(await store.all())) {
        await store.del(id);
      }
      return snapshot;
    },
    async list() {
      const all = await store.all();
      return all.sort((a, b) => b.endedAt - a.endedAt);
    },
    async get(id) {
      const all = await store.all();
      return all.find((s) => s.id === id) ?? null;
    },
    async remove(id) {
      const all = await store.all();
      const had = all.some((s) => s.id === id);
      await store.del(id);
      return had;
    },
    async count() {
      return (await store.all()).length;
    },
  };
}

/**
 * mixResumeSession (PURE): the seeds are the session's spine (the
 * queue that was playing — v5.0.1 FIX-A2 relabel: they are the
 * session's QUEUED tracks, not proof of listening, so the honest claim
 * is "your session's spine", never "heard"); fresh catalog rows
 * matching the vibe may fill at most SESSION_MEMORY.freshShare (≤30%)
 * of the final list.
 * The fresh cap is a share of the ACTUAL mix, not an absolute — a short
 * spine drags the fresh cap down with it (floor(seeds × 3/7)), so
 * "≤30% freshly added" holds for EVERY session size, not just full
 * spines (the blind critic's P1: an absolute cap made a 4-seed resume
 * 43% strangers). Output = seeds first (order preserved), fresh after —
 * a resume that LEADS with what you were doing.
 */
export function mixResumeSession<T extends { id: string }>(
  seeds: T[],
  freshCandidates: T[],
  targetCount: number = SESSION_MEMORY.resumeCount,
): { mix: T[]; freshUsed: number } {
  const seen = new Set<string>();
  const uniqueSeeds = seeds.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
  // three-way cap: the target's fresh share, the room left after the
  // spine, and the spine's own share bound (seeds × freshShare/(1−freshShare))
  const maxFresh = Math.min(
    Math.floor(Math.max(0, targetCount) * SESSION_MEMORY.freshShare),
    Math.max(0, targetCount - uniqueSeeds.length),
    Math.floor(uniqueSeeds.length * (SESSION_MEMORY.freshShare / (1 - SESSION_MEMORY.freshShare))),
  );
  const fresh: T[] = [];
  for (const t of freshCandidates) {
    if (fresh.length >= maxFresh) break;
    if (seen.has(t.id)) continue; // a catalog row that IS a seed is not fresh
    seen.add(t.id);
    fresh.push(t);
  }
  return { mix: [...uniqueSeeds, ...fresh].slice(0, targetCount), freshUsed: fresh.length };
}
