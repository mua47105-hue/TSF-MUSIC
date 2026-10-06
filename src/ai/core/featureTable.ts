/**
 * GENIUS P2 — THE BAKED KNOWLEDGE TABLE.
 *
 * Real Spotify audio features (energy / valence / danceability) for ~83k
 * popular recordings, baked ONCE by scripts/bake_features.py into
 * assets/baked_features.json (≤ 2.5 MB gzip, version-stamped) and shipped
 * inside the app. Zero runtime model, zero network: dictionary lookup.
 *
 * Potato-phone contract (house rules 7 + 8):
 *   • loadFeatureTable() is LAZY — never at import time, never inside
 *     mindbeat.init(). The caller schedules it AFTER first paint
 *     (mindbeat uses InteractionManager.runAfterInteractions).
 *   • The JSON module is required INSIDE the async load (Metro
 *     materializes the object literal only then), its entries are MOVED
 *     key-by-key into a flat Map (delete-as-you-go), so no second full
 *     copy of the table ever exists in memory.
 *   • lookup is 3 precomputed keys × O(1) probes — microseconds, no
 *     allocation on the scoring path.
 *
 * Key chain — EXACTLY the app's own recording identity (no invented
 * normalization), mirrored by the bake script:
 *   1. recordingKey(title, artist)   "tumhiho|arijitsingh"  (src/api/recording.ts)
 *   2. titleKeyOf(title)             "tumhiho"              (provider artist
 *      spellings differ: "Vishal-Shekhar" vs "Vishal Dadlani")
 *   3. normTitle(clusterKey(title))  version-folded bare title
 *      ("Tum Hi Ho (Lofi Version)" → "tumhiho")
 * A miss returns null → the caller falls back to today's priors path with
 * byte-identical behavior (the table is pure bonus evidence).
 */

import { FEATURE_TABLE } from './constants';
import { clusterKey } from '../../search/normalize';
import { recordingKey, titleKeyOf } from '../../api/recording';

export interface BakedFeatures {
  energy: number;
  valence: number;
  danceability: number;
}

interface BakedFile {
  _meta?: { version?: number; keys?: number; bakedAt?: string };
  k?: Record<string, { e: number; v: number; d: number }>;
}

let table: Map<string, BakedFeatures> | null = null;
let loadPromise: Promise<boolean> | null = null;
let tableVersion = 0;

/** Post-paint loader. Idempotent; resolves true when a table is live. */
export function loadFeatureTable(): Promise<boolean> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    if (table) return true;
    try {
      // Deferred require: the 8+ MB literal is only materialized here,
      // off the cold-start path (house rule 7).
      const raw = require('../../../assets/baked_features.json') as BakedFile;
      if (!raw || !raw.k || typeof raw.k !== 'object') return false;
      if (typeof raw._meta?.version === 'number') tableVersion = raw._meta.version;
      const map = new Map<string, BakedFeatures>();
      // Move entries (no second copy alive at any point, house rule 8).
      for (const key of Object.keys(raw.k)) {
        const f = raw.k[key];
        if (
          f && typeof f.e === 'number' && typeof f.v === 'number' && typeof f.d === 'number' &&
          f.e >= 0 && f.e <= 1 && f.v >= 0 && f.v <= 1 && f.d >= 0 && f.d <= 1
        ) {
          map.set(key, { energy: f.e, valence: f.v, danceability: f.d });
        }
        delete raw.k[key];
      }
      table = map;
      return true;
    } catch {
      // Asset missing/corrupt → every lookup misses → priors path.
      table = null;
      return false;
    }
  })();
  return loadPromise;
}

/** True when the baked table is loaded and live. */
export function featureTableReady(): boolean {
  return table != null;
}

/** Bake stamp (diagnostics/testing; 0 = no table). */
export function featureTableVersion(): number {
  return tableVersion;
}

/** Feature evidence confidence for a dataset hit (constants-tuned). */
export function bakedConfidence(): number {
  return FEATURE_TABLE.confidence;
}

/**
 * The runtime lookup chain. Missing/empty title → null (identity-less rows
 * can never match — the bake skips them for exactly this reason).
 */
export function lookupBakedFeatures(
  title?: string,
  artist?: string,
): BakedFeatures | null {
  const t = title ?? '';
  if (!table || !t) return null;
  const hit =
    table.get(recordingKey({ title: t, artist: artist ?? '' })) ??
    table.get(titleKeyOf({ title: t })) ??
    table.get(clusterFoldKey(t));
  return hit ?? null;
}

/** Third chain key — EXACTLY the bake script's key-3 pipeline:
 *  normTitle(clusterKey(title)) via titleKeyOf, so bake and runtime share
 *  ONE Unicode path (NFKD + attribution-noise strip — critic fix 2; the
 *  previous NFC-based fold diverged on compatibility glyphs like Ⅱ→ii). */
function clusterFoldKey(title: string): string {
  return titleKeyOf({ title: clusterKey(title) });
}

// ── test seam ───────────────────────────────────────────────────────────

/** Load a fixture table (replay tests) — same shape as the baked file. */
export function loadFeatureTableFromRaw(raw: BakedFile): void {
  const map = new Map<string, BakedFeatures>();
  for (const [key, f] of Object.entries(raw.k ?? {})) {
    if (f && typeof f.e === 'number' && typeof f.v === 'number' && typeof f.d === 'number') {
      map.set(key, { energy: f.e, valence: f.v, danceability: f.d });
    }
  }
  table = map;
  tableVersion = raw._meta?.version ?? 0;
}

/** Reset all module state (replay-test isolation). */
export function resetFeatureTableForTests(): void {
  table = null;
  loadPromise = null;
  tableVersion = 0;
}
