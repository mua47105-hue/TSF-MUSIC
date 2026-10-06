/**
 * THE BAKED FEATURE TABLE (Phase 2 — the biggest single intelligence jump).
 *
 * A pre-baked knowledge table of Spotify audio features (energy/valence/
 * danceability) for the world's most-played tracks, shipped INSIDE the app
 * bundle (static data — house law ①: the standalone contract allows bundled
 * files; no server is ever contacted).
 *
 * Contract (mission Phase 2):
 *   • loadFeatureTable() is LAZY: called after first frame, NEVER inside
 *     mindbeat.init() (cold-start rule ⑦).
 *   • ONE live copy of the table, ever (potato rule ⑧). The mission's
 *     original sketch was "parse → Map → release the string", written for
 *     a text-read world. In Metro, `require(json)` inlines the parsed
 *     object into the Hermes bundle and retains it in the module registry
 *     FOREVER — building a Map on top would keep TWO live copies, which
 *     is exactly what rule ⑧ forbids. So the parsed module object IS the
 *     table; this module wraps it in the get() contract with zero copies
 *     added. (Key-safety note: normalizeQuery strips underscores on BOTH
 *     the bake and the runtime side, so no key can ever collide with
 *     Object.prototype names like __proto__.)
 *   • lookup order: recordingKey (title|primaryArtist) → bare titleKey →
 *     clusterKey(title) as a titleKey. Miss ⇒ null ⇒ the estimator falls
 *     back to today's behavior BYTE-IDENTICALLY.
 *   • The keys are produced by the bake script's verbatim Python port of
 *     src/search/normalize.ts (normalizeQuery + clusterKey) — the runtime
 *     mirrors them with the SAME functions imported from the source of
 *     truth, so the two can never drift.
 */

import { DATASET } from './constants';
import type { TrackFeatures } from './types';
import { recordingKeyOf, titleKeyOf, clusterTitleKeyOf } from './bakedKeys';

/** The baked row shape: e=energy, v=valence, d=danceability (0..1, 2dp). */
export interface BakedFeatures {
  e: number;
  v: number;
  d: number;
}

interface BakedTableJSON {
  readonly [key: string]: BakedFeatures;
}

export interface FeatureTable {
  /** Version string of the bake run (semver-ish, stamped by the script). */
  version: string;
  /** ISO date of the bake run. */
  bakedAt: string;
  /** Number of keys in the table. */
  size: number;
  get(key: string): BakedFeatures | undefined;
}

let table: FeatureTable | null = null;
let loadPromise: Promise<FeatureTable | null> | null = null;

/**
 * Load the baked table (idempotent, lazy). Returns null when the asset is
 * unavailable (web harness without the bundle, exotic JS engines) — every
 * caller must degrade to the pre-Phase-2 estimator path.
 */
export function loadFeatureTable(): Promise<FeatureTable | null> {
  if (table) return Promise.resolve(table);
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      // The REAL require path (BAR 1.3): metro bundles the JSON into the
      // Hermes bundle; bun resolves it natively in tests. The parsed
      // module object is the single live copy — see the header note.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const raw = require('../../../assets/baked_features.json') as BakedTableJSON;
      let count = 0;
      // one allocation-free counting pass (no transient key array)
      for (const key in raw) {
        const row = raw[key];
        if (row && typeof row.e === 'number' && typeof row.v === 'number') count += 1;
      }
      const meta = (raw as { __meta?: { version?: string; bakedAt?: string } }).__meta;
      table = {
        version: meta?.version ?? 'unknown',
        bakedAt: meta?.bakedAt ?? 'unknown',
        size: count,
        get: (key: string) => {
          const row = raw[key];
          return row && typeof row.e === 'number' && typeof row.v === 'number' ? row : undefined;
        },
      };
      return table;
    } catch {
      // Honest degradation: no table in this environment. The estimator
      // behaves exactly as it did before Phase 2.
      table = null;
      return null;
    }
  })();
  return loadPromise;
}

/** Synchronous accessor for already-loaded tables (null before load). */
export function featureTable(): FeatureTable | null {
  return table;
}

/** Test/laboratory hook: drop the memoized table (never used in the app). */
export function resetFeatureTableForTests(): void {
  table = null;
  loadPromise = null;
}

/** Test-only injection: pin a synthetic table (deterministic rung locks). */
export function setFeatureTableForTests(t: FeatureTable): void {
  table = t;
  loadPromise = Promise.resolve(t);
}

/** Minimal track identity the lookup needs (title + primary artist). */
export interface FeatureLookupInput {
  title?: string;
  artist?: string;
}

/**
 * Three-rung lookup, each rung normalized EXACTLY like the bake script:
 *   1. recordingKey  — "normalized title|normalized primary artist"
 *   2. titleKey      — bare normalized title (only baked for unambiguous
 *                      titles, see the bake script's conflict rule)
 *   3. clusterKey    — decoration-stripped title ("Tum Hi Ho (From …)"
 *                      and "Tum Hi Ho" share one key)
 */
export function lookupBakedFeatures(input: FeatureLookupInput): BakedFeatures | null {
  const t = table;
  if (!t) return null;
  const artist = (input.artist ?? '').trim();
  const title = (input.title ?? '').trim();
  if (!title) return null;
  if (artist) {
    const hit = t.get(recordingKeyOf(title, artist));
    if (hit) return hit;
  }
  const bare = titleKeyOf(title);
  if (bare) {
    const hit = t.get(bare);
    if (hit) return hit;
  }
  const clustered = clusterTitleKeyOf(title);
  if (clustered && clustered !== bare) {
    const hit = t.get(clustered);
    if (hit) return hit;
  }
  return null;
}

/** Baked hit → TrackFeatures at dataset confidence (source 'dataset'). */
export function bakedToTrackFeatures(baked: BakedFeatures): TrackFeatures {
  return {
    energy: baked.e,
    valence: baked.v,
    tempoClass: baked.e < 0.35 ? 'slow' : baked.e < 0.65 ? 'mid' : 'fast',
    confidence: DATASET.confidence,
    source: 'dataset',
  };
}
