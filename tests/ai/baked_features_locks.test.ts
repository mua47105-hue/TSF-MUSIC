/**
 * PHASE 2 + BAR 1.3 + BAR 2.2 LOCKS — the baked feature table.
 *
 *   1. BAR 1.3: the REAL loadFeatureTable() require path parses the real
 *      2.5MB-class asset in < DATASET.loadBudgetMs (timed, literal 2000).
 *   2. key parity: the runtime key builders (bakedKeys) must find real
 *      keys inside the baked table (the bake script's port cannot drift).
 *   3. lookup rungs: recordingKey → bare titleKey → clusterKey.
 *   4. miss ⇒ the estimator behaves exactly as the pre-Phase-2 path
 *      (source/confidence from the prior tier).
 *   5. hit ⇒ dataset confidence 0.8, source 'dataset'.
 *   6. BAR 2.2: calibrate() on dataset/lyric sources is capped at ±0.05.
 */

import { describe, expect, test } from 'bun:test';
import { loadFeatureTable, lookupBakedFeatures, featureTable } from '../../src/ai/core/featureTable';
import { recordingKeyOf, titleKeyOf, clusterTitleKeyOf } from '../../src/ai/core/bakedKeys';
import { estimateFeatures, calibrate, priorEstimate } from '../../src/ai/core/features';
import { DATASET } from '../../src/ai/core/constants';
import type { TrackFeatures } from '../../src/ai/core/types';

// ── a well-known row we can verify lives in the real baked table ──
// (popularity-sorted dataset: a globally famous track)
const FAMOUS = { title: 'Shape of You', artist: 'Ed Sheeran' };

describe('BAR 1.3 — the timed real-asset parse', () => {
  test('loadFeatureTable() (real require) parses in < 2000ms', async () => {
    const t0 = performance.now();
    const table = await loadFeatureTable();
    const elapsed = performance.now() - t0;
    expect(table).not.toBeNull();
    expect(table!.size).toBeGreaterThan(50_000); // the real table, not a stub
    // THE BAR — a hardcoded literal on purpose: a constant-referencing
    // assertion could silently widen with the constant.
    expect(elapsed).toBeLessThan(2000);
  });

  test('repeat loads are memoized (parse once, potato rule ⑧)', async () => {
    const t0 = performance.now();
    await loadFeatureTable();
    expect(performance.now() - t0).toBeLessThan(5);
  });
});

describe('phase 2 — key parity with the bake script', () => {
  test('the runtime key builders hit real keys in the baked table', async () => {
    const table = (await loadFeatureTable())!;
    const recKey = recordingKeyOf(FAMOUS.title, FAMOUS.artist);
    const hit = table.get(recKey);
    expect(hit).toBeDefined();
    expect(hit!.e).toBeGreaterThanOrEqual(0);
    expect(hit!.e).toBeLessThanOrEqual(1);
    expect(hit!.v).toBeGreaterThanOrEqual(0);
    expect(hit!.v).toBeLessThanOrEqual(1);
  });

  test('normalized variants collapse to the same key (diacritics, case, punctuation)', () => {
    // normalizeQuery strips case/punctuation/folds diacritics — but does
    // NOT strip release decorations (that is the clusterKey rung's job).
    expect(recordingKeyOf('Tum Hi Ho!', 'Arijit Singh')).toBe(recordingKeyOf('tum hi ho', 'arijit singh'));
    expect(recordingKeyOf('Tum Hī Hō', 'ARIJIT  SINGH')).toBe(recordingKeyOf('tum hi ho', 'arijit singh'));
    expect(titleKeyOf('Ça plane pour moi')).toBe('ca plane pour moi');
    // decorations fall to the cluster rung instead
    expect(clusterTitleKeyOf('Tum Hi Ho (From "Aashiqui 2")')).toBe('tum hi ho');
  });
});

describe('phase 2 — the lookup rungs', () => {
  test('rung 1 recordingKey: exact title+artist wins', async () => {
    await loadFeatureTable();
    const hit = lookupBakedFeatures(FAMOUS);
    expect(hit).not.toBeNull();
  });

  test('rung 3 clusterKey: a decorated title finds the cluster-keyed row (deterministic)', async () => {
    // Synthetic table — no dataset luck involved: recordingKey hit, bare
    // miss, cluster hit. If the cluster rung dies, this lookup is null.
    const { setFeatureTableForTests, resetFeatureTableForTests } = await import('../../src/ai/core/featureTable');
    const decorated = 'Tum Hi Ho (From "Aashiqui 2")';
    const rec = recordingKeyOf(decorated, 'Some Guy');
    const cluster = clusterTitleKeyOf(decorated);
    expect(cluster).toBe('tum hi ho');
    const backing = new Map<string, { e: number; v: number; d: number }>([
      [rec, { e: 0.3, v: 0.2, d: 0.4 }],
      ['tum hi ho', { e: 0.31, v: 0.21, d: 0.41 }],
    ]);
    setFeatureTableForTests({
      version: 'test', bakedAt: 'test', size: backing.size,
      get: (k: string) => backing.get(k),
    });
    try {
      // a DIFFERENT artist on the decorated title: rung 1 misses, bare
      // ('tum hi ho from aashiqui 2') misses, rung 3 must hit 'tum hi ho'
      const hit = lookupBakedFeatures({ title: decorated, artist: 'Cover Artist' });
      expect(hit).not.toBeNull();
      expect(hit!.v).toBe(0.21);
    } finally {
      resetFeatureTableForTests();
    }
  });

  test('a total miss returns null — and the estimator falls back BYTE-IDENTICALLY', async () => {
    await loadFeatureTable();
    const ghost = { title: 'zzx no such song qv7', artist: 'nobody real 42' };
    expect(lookupBakedFeatures(ghost)).toBeNull();

    // The fallback must equal the pure prior tier (title rules may add
    // metadata nudges; the INPUT here carries no rule-triggering words).
    const est = estimateFeatures(ghost);
    const prior = priorEstimate(ghost.artist, undefined);
    expect(est.energy).toBe(prior.energy);
    expect(est.valence).toBe(prior.valence);
    expect(est.source).toBe(prior.source);
    expect(est.confidence).toBe(prior.confidence);
  });

  test('a hit carries dataset confidence 0.8 + source dataset', async () => {
    await loadFeatureTable();
    const est = estimateFeatures(FAMOUS);
    expect(est.source).toBe('dataset');
    expect(est.confidence).toBe(DATASET.confidence);
    expect(est.energy).toBe(lookupBakedFeatures(FAMOUS)!.e);
    expect(est.valence).toBe(lookupBakedFeatures(FAMOUS)!.v);
  });
});

describe('BAR 2.2 — the ground-truth calibration cap (±0.05)', () => {
  const heavyObs = [
    { energy: 0.95, completion: 1 },
    { energy: 0.95, completion: 1 },
    { energy: 0.95, completion: 1 },
    { energy: 0.95, completion: 1 },
    { energy: 0.95, completion: 1 },
    { energy: 0.95, completion: 1 },
    { energy: 0.95, completion: 1 },
    { energy: 0.95, completion: 1 },
  ];

  test('a dataset estimate can only drift ±0.05 no matter how strong the evidence', () => {
    const base: TrackFeatures = { energy: 0.2, valence: 0.2, tempoClass: 'slow', confidence: 0.8, source: 'dataset' };
    const out = calibrate(base, heavyObs);
    expect(out.energy).toBeLessThanOrEqual(base.energy + 0.0500001);
    expect(out.energy).toBeGreaterThanOrEqual(base.energy - 0.0500001);
    expect(out.valence).toBeLessThanOrEqual(base.valence + 0.0500001);
    expect(out.valence).toBeGreaterThanOrEqual(base.valence - 0.0500001);
    // the source stays dataset (the ground-truth carrier)
    expect(out.source).toBe('dataset');
  });

  test('a prior estimate calibrates FULLY (the pre-bar behavior is unchanged)', () => {
    const base: TrackFeatures = { energy: 0.2, valence: 0.2, tempoClass: 'slow', confidence: 0.7, source: 'prior' };
    const out = calibrate(base, heavyObs);
    expect(out.energy).toBeGreaterThan(base.energy); // full pull, no cap
    expect(out.source).toBe('calibrated');
  });

  test('a lyric-source estimate is capped the same way (BAR 2.2 covers both)', () => {
    const base: TrackFeatures = { energy: 0.1, valence: 0.9, tempoClass: 'slow', confidence: 0.6, source: 'lyric' };
    const out = calibrate(base, heavyObs);
    expect(out.energy).toBeLessThanOrEqual(0.1500001);
    expect(out.valence).toBeGreaterThanOrEqual(0.8499999);
  });
});
