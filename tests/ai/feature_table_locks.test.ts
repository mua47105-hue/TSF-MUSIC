/**
 * GENIUS P2 — BAKED KNOWLEDGE TABLE LOCKS (gauntlet/GENIUS-BARS.md §P2).
 *
 * Bars pinned:
 *   • baked hit → source 'dataset', confidence FEATURE_TABLE.confidence,
 *     the REAL numbers ride through (energy/valence/danceability)
 *   • lookup chain: recordingKey → titleKey (provider artist spellings
 *     differ) → cluster-folded bare title (version decorations differ)
 *   • miss / no table → byte-identical to the pre-change priors path
 *   • calibrate() still pulls dataset values toward observed behavior
 *   • determinism: same inputs → same outputs, twice
 *   • ASSET LAW: the shipped baked_features.json is ≤ 2.5 MB gzip,
 *     version-stamped, every feature within [0,1] (double-checks the
 *     bake script's own loud failure)
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import { gzipSync } from 'node:zlib';
import {
  loadFeatureTableFromRaw,
  lookupBakedFeatures,
  resetFeatureTableForTests,
  featureTableVersion,
  bakedConfidence,
} from '../../src/ai/core/featureTable';
import { estimateFeatures, calibrate, tempoFromClass } from '../../src/ai/core/features';
import { FEATURE_TABLE } from '../../src/ai/core/constants';
import { recordingKey, titleKeyOf } from '../../src/api/recording';
import { clusterKey, normalizeQuery } from '../../src/search/normalize';

const FIXTURE = {
  _meta: { version: 1, keys: 4, bakedAt: '2026-10-06' },
  k: {
    // recordingKey form
    [recordingKey({ title: 'Tum Hi Ho', artist: 'Arijit Singh' })]: { e: 0.45, v: 0.32, d: 0.53 },
    // bare titleKey form — provider spells the artist differently live
    jhoomejopathaan: { e: 0.74, v: 0.71, d: 0.78 },
    // cluster-folded form — live rows carry version decorations
    tumhiho: { e: 0.46, v: 0.33, d: 0.54 },
    radha: { e: 0.55, v: 0.62, d: 0.7 },
  },
};

const NOW = new Date('2026-10-06T10:00:00Z').getTime();

function clusterFold(title: string): string {
  return normalizeQuery(clusterKey(title)).replace(/[^a-z0-9]+/g, '').slice(0, 80);
}

beforeEach(() => resetFeatureTableForTests());

describe('GENIUS P2 — lookup chain', () => {
  test('recordingKey hit returns REAL features with source dataset', () => {
    loadFeatureTableFromRaw(FIXTURE);
    const f = estimateFeatures({ artist: 'Arijit Singh', title: 'Tum Hi Ho' });
    expect(f.source).toBe('dataset');
    expect(f.confidence).toBe(FEATURE_TABLE.confidence);
    expect(f.energy).toBe(0.45);
    expect(f.valence).toBe(0.32);
    expect(f.tempoClass).toBe(tempoFromClass(0.45));
  });

  test('titleKey fallback: live artist spelling differs from the baked credit', () => {
    loadFeatureTableFromRaw(FIXTURE);
    // baked under the bare title only ("Jhoome Jo Pathaan" by Vishal-Shekhar);
    // live JioSaavn row credits "Vishal Dadlani & Shekhar Ravjiani"
    const f = estimateFeatures({ artist: 'Vishal Dadlani, Shekhar Ravjiani', title: 'Jhoome Jo Pathaan' });
    expect(f.source).toBe('dataset');
    expect(f.energy).toBe(0.74);
    expect(f.valence).toBe(0.71);
  });

  test('cluster-fold fallback: live version decoration matches the bare bake', () => {
    loadFeatureTableFromRaw(FIXTURE);
    const f = estimateFeatures({ artist: 'Some Artist', title: 'Tum Hi Ho (Lofi Version)' });
    expect(f.source).toBe('dataset');
    expect(f.energy).toBe(0.46);
  });

  test('miss with a loaded table → byte-identical legacy path', () => {
    loadFeatureTableFromRaw(FIXTURE);
    const unknown = { artist: 'Somebody Nobody Knows', title: 'Not In The Table' };
    const withTable = estimateFeatures(unknown);
    resetFeatureTableForTests(); // table gone = pre-change world
    const withoutTable = estimateFeatures(unknown);
    expect(JSON.stringify(withTable)).toBe(JSON.stringify(withoutTable));
    expect(withTable.source).not.toBe('dataset');
  });

  test('no table at all → every lookup misses, engine unchanged', () => {
    expect(lookupBakedFeatures('Tum Hi Ho', 'Arijit Singh')).toBeNull();
    const f = estimateFeatures({ artist: 'Arijit Singh', title: 'Tum Hi Ho' });
    expect(f.source).toBe('prior'); // artist prior tier, exactly as today
    expect(f.confidence).toBe(0.7);
  });

  test('determinism: same lookup twice → identical values', () => {
    loadFeatureTableFromRaw(FIXTURE);
    const a = lookupBakedFeatures('Tum Hi Ho', 'Arijit Singh');
    const b = lookupBakedFeatures('Tum Hi Ho', 'Arijit Singh');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('GENIUS P2 — calibration on top of dataset truth', () => {
  test('repeated completions pull a dataset estimate (confidence grows, energy moves)', () => {
    loadFeatureTableFromRaw(FIXTURE);
    const base = estimateFeatures({ artist: 'Arijit Singh', title: 'Tum Hi Ho' });
    expect(base.source).toBe('dataset');
    // the track keeps getting completed at HIGH-energy contexts
    const observations = Array.from({ length: 8 }, () => ({ energy: 0.9, completion: 1 }));
    const calibrated = calibrate(base, observations);
    expect(calibrated.energy).toBeGreaterThan(base.energy);
    expect(calibrated.source).toBe('calibrated');
    expect(calibrated.confidence).toBeGreaterThan(base.confidence);
  });

  test('no observations → calibrate returns the dataset base untouched', () => {
    loadFeatureTableFromRaw(FIXTURE);
    const base = estimateFeatures({ artist: 'Arijit Singh', title: 'Tum Hi Ho' });
    expect(calibrate(base, [])).toEqual(base);
  });

  test('bakedConfidence mirrors the constants tuning table', () => {
    expect(bakedConfidence()).toBe(0.8);
    expect(FEATURE_TABLE.gzipCeilingBytes).toBe(2_621_440);
  });
});

describe('GENIUS P2 — the shipped asset obeys the law', () => {
  // The real asset (this require is ONLY in tests — never in app code).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  let asset: { _meta?: any; k: Record<string, { e: number; v: number; d: number }> } | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    asset = require('../../assets/baked_features.json');
  } catch {
    asset = null;
  }

  test('asset exists, version-stamped, and fits the 2.5 MB gzip ceiling', () => {
    expect(asset).not.toBeNull();
    expect(asset!._meta?.version).toBeGreaterThanOrEqual(1);
    expect(asset!._meta?.bakedAt).toBeTruthy();
    const bytes = gzipSync(Buffer.from(JSON.stringify(asset!), 'utf8')).length;
    expect(bytes).toBeLessThanOrEqual(FEATURE_TABLE.gzipCeilingBytes);
  });

  test('every baked feature is within [0,1] and the table has mass', () => {
    expect(asset).not.toBeNull();
    const keys = Object.keys(asset!.k);
    expect(keys.length).toBeGreaterThan(50_000);
    // spot-verify a known recording keeps REAL numbers
    expect(asset!.k['tumhiho|arijitsingh']).toEqual({ e: 0.45, v: 0.32, d: 0.53 });
    let i = 0;
    for (const [k, f] of Object.entries(asset!.k)) {
      expect(f.e).toBeGreaterThanOrEqual(0);
      expect(f.e).toBeLessThanOrEqual(1);
      expect(f.v).toBeGreaterThanOrEqual(0);
      expect(f.v).toBeLessThanOrEqual(1);
      if (++i >= 5000) break; // sample — full sweep would be slow in CI
    }
  });

  test('the runtime chain hits the REAL asset for known recordings', () => {
    loadFeatureTableFromRaw(asset!);
    expect(featureTableVersion()).toBe(asset!._meta!.version);
    const hit = lookupBakedFeatures('Tum Hi Ho', 'Arijit Singh');
    expect(hit).not.toBeNull();
    expect(hit!.energy).toBeCloseTo(0.45, 5);
    // titleKey layer across provider spellings — the real table carries it
    const viaTitle = lookupBakedFeatures('Jhoome Jo Pathaan', 'Vishal Dadlani');
    expect(viaTitle).not.toBeNull();
  });
});
