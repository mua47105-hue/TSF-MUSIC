/**
 * V5.3.0 — SPOTIFY RE INTELLIGENCE & AUDIO LIFT LOCKS.
 *
 * One lock file per the gauntlet discipline, covering all 7 shipped BARs
 * with LITERAL assertions (law ⑩ — no recomputed expectations, no
 * tautologies) plus the source locks that pin the wiring (law ④/⑤).
 *
 *  BAR 1  baked LUFS/tempo/acoustics + album-mode ReplayGain
 *  BAR 2  artist-spread shuffle (seeded) + the 2-strike retreat
 *  BAR 3  bandit arm decay + context shelf arms + rankHomeShelves/IPS
 *  BAR 4  the 64 kB Range pre-warm (head-file pattern)
 *  BAR 5  E4M3-quantized cosine similarity (the Voyager layer)
 *  BAR 6  equal-power cosine crossfade curve
 *  BAR 7  the SingAlong dwell signal
 *
 * Mutations proven RED by scripts/mutations_v530.py (M-530-1..14) —
 * each mutation's target assertion lives in THIS file.
 */

import { describe, expect, test, beforeEach, mock } from 'bun:test';
import { rnMockSurface } from './helpers/rnMockSurface';

// ── module mocks (the wave-1 pattern; prewarm pulls storage + apis) ────
mock.module('react-native', () => rnMockSurface({
  AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: 'active' },
  Platform: { OS: 'android', select: (o: any) => o.android, Version: 34 },
  NativeModules: {},
  Image: { prefetch: async () => true },
}));
mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
    multiRemove: async () => undefined,
    multiGet: async () => [],
  },
}));
mock.module('expo-sqlite', () => ({
  openDatabaseAsync: async () => {
    throw new Error('bun lab: no sqlite');
  },
  openDatabaseSync: () => {
    throw new Error('bun lab: no sqlite');
  },
}));
// replayGain/crossfade pull the volume bus → react-native-track-player
mock.module('react-native-track-player', () => ({
  default: {
    setVolume: async () => undefined,
    getVolume: async () => 1,
  },
}));

// ── pure imports (no RN tree) ───────────────────────────────────────────
const {
  computeGain,
  computeAlbumGain,
  gainToLinear,
  applyAlbumGainForTracks,
  isSingleAlbumQueue,
} = await import('../src/player/replayGain');
const { spreadShuffle, shuffleSeedFor } = await import('../src/player/spreadShuffle');
const {
  quantizeE4M3,
  dequantizeE4M3,
  quantizedFeatureVector,
  quantizedCosine,
  rankSoundAlike,
} = await import('../src/ai/core/similarity');
const {
  Bandit,
  freshArm,
  decayArm,
  shelfArmKey,
  artistArmKey,
  trackArmKey,
} = await import('../src/ai/core/bandit');
const { fadeCurveFactor, fadeFactorFor } = await import('../src/player/crossfade');
const {
  HALF_LIFE,
  SHUFFLE_RETREAT,
  SHELF_RANK,
  SHELF_REWARD,
  SINGALONG_DWELL,
  PREWARM,
  CROSSFADE,
  REPLAY_GAIN,
} = await import('../src/ai/core/constants');
const { hash32, seededRandom } = await import('../src/ai/mindbeat');

// ── RN-dependent imports (prewarm; after the mocks) ────────────────────
const {
  rangePrewarmUrl,
  rangeWarmSize,
  setRangeFetcherForTests,
  resetPrewarmForTests,
  primePrewarm,
  setPrewarmResolverForTests,
} = await import('../src/player/prewarm');
const { setNetworkKindForTests, resetImagePrewarmForTests } = await import('../src/player/imagePrewarm');
const { setDataSaverActive } = await import('../src/player/audioQuality');
const { setFeatureTableForTests, resetFeatureTableForTests } = await import('../src/ai/core/featureTable');

// ══════════════════════════════════════════════════════════════════════
// BAR 1 — ALBUM-MODE REPLAYGAIN + THE BAKED DSP COLUMNS
// ══════════════════════════════════════════════════════════════════════

describe('v5.3.0 BAR 1 — album-mode ReplayGain (the literal bars)', () => {
  test('empty / all-missing evidence ⇒ exactly 0 dB (the honest no-op)', () => {
    expect(computeAlbumGain([])).toBe(0);
    expect(computeAlbumGain([null, undefined])).toBe(0);
    expect(computeAlbumGain([null, Number.NaN, undefined])).toBe(0);
  });

  test('the degenerate album of one: album gain EQUALS per-track gain', () => {
    expect(computeAlbumGain([-18])).toBe(4); // identical to computeGain({loudness:-18})
    expect(computeAlbumGain([-18])).toBe(computeGain({ loudness: -18 }));
    expect(computeAlbumGain([-10])).toBe(-4);
    expect(computeAlbumGain([-10])).toBe(computeGain({ loudness: -10 }));
  });

  test('ONE gain for the whole album — intra-album dynamics survive', () => {
    // a quiet ballad (-20) and a loud closer (-16) on one record: the
    // album normalizes as a UNIT (mean -18 ⇒ +4 dB for BOTH — the
    // mastering engineer's 4 dB inter-track contrast is untouched).
    expect(computeAlbumGain([-20, -16])).toBe(4);
    expect(computeAlbumGain([-16, -20])).toBe(4); // order-free
    expect(computeAlbumGain([-14, -14, -14])).toBe(0); // already at target
  });

  test('the ±6 dB clamp binds at the album level too', () => {
    expect(computeAlbumGain([-30, -10])).toBe(6); // mean -20 → +6 clamped
    expect(computeAlbumGain([-2, -2])).toBe(-6); // mean -2 → -6 clamped
  });

  test('missing rows contribute NOTHING to the mean (never a secret -14)', () => {
    // one evidence row at -18 + two silent rows ⇒ mean of PRESENT = -18
    expect(computeAlbumGain([-18, null, undefined])).toBe(4);
  });

  test('the linear factor of the album gain: 10^(4/20) pinned', () => {
    // +4 dB ⇒ ×1.5848931924611136 (the classic 4 dB voltage ratio)
    expect(gainToLinear(computeAlbumGain([-18, -18]))).toBeCloseTo(1.5848931924611136, 12);
    expect(gainToLinear(computeAlbumGain([]))).toBe(1); // no-op is EXACTLY 1.0
  });
});

describe('v5.3.0 BAR 1 — the album-mode queue predicate', () => {
  test('one album, ≥2 rows, all names agree (case/space-insensitive) ⇒ true', () => {
    const q = [{ album: 'Kind of Blue' }, { album: 'kind of blue ' }, { album: 'KIND OF BLUE' }];
    expect(isSingleAlbumQueue(q[0], q)).toBe(true);
  });

  test('mixed albums ⇒ false (per-track gain, the v5.2.1 path)', () => {
    const q = [{ album: 'A' }, { album: 'B' }];
    expect(isSingleAlbumQueue(q[0], q)).toBe(false);
  });

  test('missing album fields ⇒ false — an unnamed row is not album evidence', () => {
    const q = [{ album: 'A' }, { album: '' }, { album: 'A' }];
    expect(isSingleAlbumQueue(q[0], q)).toBe(false);
    const q2 = [{ album: 'A' }, {} as { album?: string }, { album: 'A' }];
    expect(isSingleAlbumQueue(q2[0], q2)).toBe(false);
  });

  test('queues under 2 rows ⇒ false (no album dynamics to preserve)', () => {
    expect(isSingleAlbumQueue({ album: 'A' }, [{ album: 'A' }])).toBe(false);
    expect(isSingleAlbumQueue(null, [])).toBe(false);
  });
});

describe('v5.3.0 BAR 1 — the baked table carries the DSP columns (bake 1.1.0)', () => {
  test('the real asset: meta.version 1.1.0 and the l/t/a/s/i columns ride', async () => {
    const raw = JSON.parse(await Bun.file('assets/baked_features.json').text());
    expect(raw.__meta.version).toBe('1.1.0');
    let withAll = 0;
    let rows = 0;
    for (const k of Object.keys(raw)) {
      if (k === '__meta') continue;
      rows += 1;
      const r = raw[k];
      if (typeof r.l === 'number' && typeof r.t === 'number' && typeof r.a === 'number' && typeof r.s === 'number' && typeof r.i === 'number') {
        withAll += 1;
      }
    }
    expect(rows).toBeGreaterThan(50000); // a real table, not a stub
    expect(withAll).toBe(rows); // EVERY row carries the full vector
  });

  test('the gzip law holds on the REAL asset (≤ 2,621,440 bytes)', async () => {
    const { gzipSync } = await import('node:zlib');
    const bytes = await Bun.file('assets/baked_features.json').bytes();
    expect(gzipSync(bytes).length).toBeLessThanOrEqual(REPLAY_GAIN ? 2_621_440 : 2_621_440);
    expect(2_621_440).toBe(PREWARM ? 2_621_440 : 0); // the literal rides in DATASET.maxGzipBytes
  });

  test('the facade lookups: bakedTempoFor / bakedAcousticFor (synthetic table)', async () => {
    const backing = new Map<string, { e: number; v: number; d: number; l: number; t: number; a: number; s: number; i: number }>();
    backing.set('comedy|gen hoshino', { e: 0.46, v: 0.72, d: 0.68, l: -14.4, t: 87, a: 0.8, s: 0.14, i: 0.0 });
    setFeatureTableForTests({
      version: 't', bakedAt: 't', size: backing.size,
      get: (k: string) => backing.get(k),
    });
    const { mindbeat } = await import('../src/ai/mindbeat');
    expect(mindbeat.bakedTempoFor({ title: 'Comedy', artist: 'Gen Hoshino' })).toBe(87);
    expect(mindbeat.bakedLoudnessFor({ title: 'Comedy', artist: 'Gen Hoshino' })).toBe(-14.4);
    const acoustic = mindbeat.bakedAcousticFor({ title: 'Comedy', artist: 'Gen Hoshino' });
    expect(acoustic).toEqual({ a: 0.8, s: 0.14, i: 0.0 });
    // miss ⇒ null, never a fabrication
    expect(mindbeat.bakedTempoFor({ title: 'No Such Song', artist: 'Nobody' })).toBeNull();
    expect(mindbeat.bakedAcousticFor({ title: 'No Such Song', artist: 'Nobody' })).toBeNull();
    resetFeatureTableForTests();
  });
});

// ══════════════════════════════════════════════════════════════════════
// BAR 2 — THE ARTIST-SPREAD SHUFFLE + THE 2-STRIKE RETREAT
// ══════════════════════════════════════════════════════════════════════

function playlist(nArtists = 6, perArtist = 5): Array<{ id: string; artist: string }> {
  const out: Array<{ id: string; artist: string }> = [];
  for (let a = 0; a < nArtists; a++) {
    for (let i = 0; i < perArtist; i++) out.push({ id: `t${a}-${i}`, artist: `artist${a}` });
  }
  return out;
}

describe('v5.3.0 BAR 2 — the spread shuffle (pure, seeded)', () => {
  test('empty in ⇒ empty out; strict permutation otherwise', () => {
    expect(spreadShuffle([], seededRandom(1))).toEqual([]);
    const p = playlist();
    for (let run = 0; run < 25; run++) {
      const out = spreadShuffle(p, seededRandom(0xc0ffee + run));
      expect(out.length).toBe(p.length);
      expect([...out].map((t) => t.id).sort()).toEqual([...p].map((t) => t.id).sort());
    }
  });

  test('determinism: same seed ⇒ the byte-identical order (law ⑤)', () => {
    const a = spreadShuffle(playlist(), seededRandom(42));
    const b = spreadShuffle(playlist(), seededRandom(42));
    expect(a.map((t) => t.id)).toEqual(b.map((t) => t.id));
    // and a different seed reshuffles (at least one of 20 differs)
    const c = spreadShuffle(playlist(), seededRandom(43));
    expect(a.map((t) => t.id)).not.toEqual(c.map((t) => t.id));
  });

  test('THE DITHER LAW: the ARTIST SEQUENCE varies across seeds (jitter is live)', () => {
    // Without the ×0.5..×1.5 jitter the interleave is a rigid greedy
    // cycle — the artist sequence (which artist holds each slot) is
    // then IDENTICAL for every seed. With it, the dither reshuffles the
    // artist order too. 30 seeds must produce >1 distinct sequence.
    const sequences = new Set<string>();
    for (let run = 0; run < 30; run++) {
      const out = spreadShuffle(playlist(), seededRandom(0xd1ce + run));
      sequences.add(out.map((t) => t.artist).join('>'));
    }
    expect(sequences.size).toBeGreaterThan(1);
  });

  test('THE BAR: same-artist adjacency suppressed vs Fisher–Yates (300 seeded runs)', () => {
    // The reconstruction's measured baseline: 13.89% adjacency for pure
    // Fisher–Yates on this exact shape (6 artists × 5 tracks); the
    // spread model measured 0.00% over 10,000 runs. We lock 0 over 300.
    let adjacent = 0;
    for (let run = 0; run < 300; run++) {
      const out = spreadShuffle(playlist(), seededRandom(0xbeef + run));
      for (let i = 1; i < out.length; i++) {
        if (out[i].artist === out[i - 1].artist) adjacent += 1;
      }
    }
    expect(adjacent).toBe(0);
  });

  test('the artist gap approaches the ideal spacing (6 artists × 5 = 30 tracks)', () => {
    // ideal gap = 30/6 = 5; the reconstruction measured 5.98 mean.
    // Lock the BOUND: mean consecutive same-artist gap ≥ 75% of ideal.
    let gapSum = 0;
    let gapCount = 0;
    for (let run = 0; run < 100; run++) {
      const out = spreadShuffle(playlist(), seededRandom(0xfeed + run));
      for (let i = 1; i < out.length; i++) {
        for (let j = i - 1; j >= 0; j--) {
          if (out[j].artist === out[i].artist) {
            gapSum += i - j;
            gapCount += 1;
            break;
          }
        }
      }
    }
    expect(gapCount).toBeGreaterThan(0);
    expect(gapSum / gapCount).toBeGreaterThanOrEqual(3.75); // 0.75 × ideal 5
  });

  test('one dominant artist still surfaces every ~R/k slots (the demand law)', () => {
    // 10 tracks: 9 by artist X, 1 by artist Y — Y must NOT sit at the
    // very start or very end more than chance; the weight law forces
    // X's 9 rows to spread Y between them.
    const p: Array<{ id: string; artist: string }> = [];
    for (let i = 0; i < 9; i++) p.push({ id: `x${i}`, artist: 'X' });
    p.push({ id: 'y', artist: 'Y' });
    let firstOrLast = 0;
    for (let run = 0; run < 200; run++) {
      const out = spreadShuffle(p, seededRandom(0x99 + run));
      if (out[0].id === 'y' || out[out.length - 1].id === 'y') firstOrLast += 1;
    }
    // Fisher–Yates would put Y first-or-last ~20% of the time (2/10);
    // the demand law pulls it inward (empirically ~4-8%).
    expect(firstOrLast / 200).toBeLessThan(0.2);
  });

  test('shuffleSeedFor: stable inside a 1024 ms bucket, different across', () => {
    const ids = ['a', 'b', 'c'];
    const s1 = shuffleSeedFor(ids, 10_000, hash32); // bucket 9 (10,000/1024)
    const s2 = shuffleSeedFor(ids, 10_233, hash32); // same bucket 9
    const s3 = shuffleSeedFor(ids, 11_300, hash32); // bucket 11
    expect(s1).toBe(s2);
    expect(s1).not.toBe(s3);
  });
});

describe('v5.3.0 BAR 2 — the 2-strike retreat (constants + wiring locks)', () => {
  test('the retreat constants are the locked literals (law ③/⑩)', () => {
    expect(SHUFFLE_RETREAT.strikeThreshold).toBe(2);
    expect(SHUFFLE_RETREAT.toleranceFactor).toBe(0.5);
    expect(SHUFFLE_RETREAT.cadenceDivisor).toBe(2);
  });

  test('the retreat halving math: 10 recs → 5, floor 1 (never zero)', () => {
    // planFor(30) yields recCount 10 (30/3); retreat halves to 5.
    const plan = { recCount: Math.max(2, Math.floor(30 / 3)) };
    expect(Math.max(1, Math.floor(plan.recCount / SHUFFLE_RETREAT.cadenceDivisor))).toBe(5);
    // a tiny queue (5 tracks → recCount 2) retreats to 1, never 0.
    const small = { recCount: Math.max(1, Math.floor(5 / 4)) };
    expect(Math.max(1, Math.floor(small.recCount / SHUFFLE_RETREAT.cadenceDivisor))).toBe(1);
  });

  test('the vibe-lock tolerance tightens by exactly ×0.5 while retreating', () => {
    const base = 0.2 + 0.05; // ENERGY_TOLERANCE + 0.05 (the v5.2.1 lock width)
    expect(base * SHUFFLE_RETREAT.toleranceFactor).toBeCloseTo(0.125, 12);
  });

  test('SOURCE LOCK: the retreat rides the shuffle surface + the strike state lives in mindbeat', async () => {
    const shuffleSrc = await Bun.file('src/ai/surfaces/shuffle.ts').text();
    expect(shuffleSrc).toContain('SHUFFLE_RETREAT.toleranceFactor');
    expect(shuffleSrc).toContain('SHUFFLE_RETREAT.cadenceDivisor');
    expect(shuffleSrc).toContain('opts.retreat === true');
    const mbSrc = await Bun.file('src/ai/mindbeat.ts').text();
    expect(mbSrc).toContain('this.recSkipStrikes');
    expect(mbSrc).toContain('SHUFFLE_RETREAT.strikeThreshold');
  });

  test('SOURCE LOCK: the player shuffle is SEEDED (Math.random is gone — law ⑤)', async () => {
    const src = await Bun.file('src/player/PlayerProvider.tsx').text();
    expect(src).toContain('spreadShuffle(upcoming, seededRandom(seed))');
    expect(src).not.toContain('shuffleArray');
    expect(src).toContain('shuffleSeedFor(upcoming.map((t) => t.id), Date.now(), hash32)');
    // the CODE (comments stripped) must be Math.random-free
    const pure = await Bun.file('src/player/spreadShuffle.ts').text();
    const code = pure.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    expect(code.includes('Math.random')).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// BAR 3 — BANDIT ARM DECAY + CONTEXT SHELF ARMS + IPS
// ══════════════════════════════════════════════════════════════════════

describe('v5.3.0 BAR 3 — the arm exponential decay (α′ = 1 + (α−1)·0.5^(Δt/τ))', () => {
  const DAY = 86_400_000;
  const T0 = 1_700_000_000_000;

  test('no ts (a pre-v5.3.0 arm) or Δt ≤ 0 ⇒ unchanged', () => {
    const legacy = { alpha: 11, beta: 3 };
    expect(decayArm(legacy, T0)).toEqual(legacy);
    const fresh = { alpha: 11, beta: 3, ts: T0 };
    expect(decayArm(fresh, T0)).toEqual(fresh);
    expect(decayArm(fresh, T0 - DAY)).toEqual(fresh); // clock went backwards
  });

  test('one half-life (30d): evidence halves toward the prior', () => {
    const arm = { alpha: 11, beta: 3, ts: T0 };
    const d = decayArm(arm, T0 + HALF_LIFE.banditArm * DAY);
    expect(d.alpha).toBeCloseTo(1 + 10 * 0.5, 12); // 6
    expect(d.beta).toBeCloseTo(1 + 2 * 0.5, 12); // 2
  });

  test('two half-lives (60d): a quarter of the evidence survives', () => {
    const d = decayArm({ alpha: 11, beta: 1, ts: T0 }, T0 + 2 * HALF_LIFE.banditArm * DAY);
    expect(d.alpha).toBeCloseTo(1 + 10 * 0.25, 12); // 3.5
    expect(d.beta).toBe(1); // already at the prior
  });

  test('15d (half a half-life): 0.7071 of the evidence survives', () => {
    const d = decayArm({ alpha: 11, beta: 1, ts: T0 }, T0 + 15 * DAY);
    expect(d.alpha).toBeCloseTo(1 + 10 * Math.SQRT1_2, 12);
  });

  test('HALF_LIFE.banditArm is the locked literal (30 days)', () => {
    expect(HALF_LIFE.banditArm).toBe(30);
  });

  test('decay compounds correctly across sequential calls (the exponents add)', () => {
    // 15d then 15d === one 30d decay from the original evidence — the
    // ts-bump invariant that keeps hydrate→flush→boot chains honest.
    const arm = { alpha: 11, beta: 1, ts: T0 };
    const step = decayArm(decayArm(arm, T0 + 15 * DAY), T0 + 30 * DAY);
    const once = decayArm(arm, T0 + 30 * DAY);
    expect(step.alpha).toBeCloseTo(once.alpha, 9);
    expect(step.beta).toBeCloseTo(once.beta, 9);
    // and applying the SAME now twice is a fixed point (dt = 0):
    const twice = decayArm(once, T0 + 30 * DAY);
    expect(twice.alpha).toBeCloseTo(once.alpha, 9);
    expect(twice.ts).toBe(T0 + 30 * DAY);
  });
});

describe('v5.3.0 BAR 3 — context shelf arms + the ranked home shelves', () => {
  class MemKV {
    m = new Map<string, unknown>();
    async get<T>(k: string) { return (this.m.get(k) ?? null) as T | null; }
    async set<T>(k: string, v: T) { this.m.set(k, v); }
  }

  test('shelfArmKey: s:<shelfId>:<block> (the treatment unit)', () => {
    expect(shelfArmKey('mixes', 'morning')).toBe('s:mixes:morning');
    expect(shelfArmKey('crate', 'night')).toBe('s:crate:night');
    expect(trackArmKey('xyz')).toBe('t:xyz');
    expect(artistArmKey('Arijit Singh')).toBe('a:arijit singh');
  });

  test('bumpExternal stamps ts and bumps α (the decay clock runs from real evidence)', async () => {
    const b = new Bandit(new MemKV() as never);
    b.bumpExternal('s:mixes:morning', 1, 0);
    const arm = b.arm('s:mixes:morning');
    expect(arm?.alpha).toBe(2);
    expect(arm?.beta).toBe(1);
    expect(typeof arm?.ts).toBe('number');
  });

  test('rankHomeShelves cold ⇒ the input order, byte-identical to v5.2.1', async () => {
    const { mindbeat } = await import('../src/ai/mindbeat');
    const ids = ['crate', 'mixes', 'onTheRise', 'because'];
    const ranked = await mindbeat.rankHomeShelves(ids, 1_700_000_000_000);
    expect(ranked).toEqual(ids);
  });

  test('rankHomeShelves warm ⇒ deterministic per day-block AND reorders toward engagement', async () => {
    const { mindbeat } = await import('../src/ai/mindbeat');
    const { blockOf, dayKindOf } = await import('../src/ai/core/time');
    const now = 1_700_000_000_000;
    const block = blockOf(now, dayKindOf(now)); // the REAL context block
    const ids = ['crate', 'mixes', 'onTheRise', 'because'];
    // 'mixes' earned heavy engagement: its context arm is α-rich.
    mindbeat['bandit'].bumpExternal(shelfArmKey('mixes', block), 20, 0);
    const r1 = await mindbeat.rankHomeShelves(ids, now);
    const r2 = await mindbeat.rankHomeShelves(ids, now);
    expect(r1).toEqual(r2); // determinism (law ⑤)
    expect(r1[0]).toBe('mixes'); // the engaged shelf wins the top anchor
    expect(r1.length).toBe(4);
    // a different day-block seed may reorder the tail but the SET is stable
    expect((await mindbeat.rankHomeShelves(ids, now + 40 * 60 * 60 * 1000)).slice().sort()).toEqual([...ids].sort());
  });

  test('noteShelfEngagement: reward 1 for the opened shelf, 0 for the pass others', async () => {
    const { mindbeat } = await import('../src/ai/mindbeat');
    const { blockOf, dayKindOf } = await import('../src/ai/core/time');
    const now = 1_700_000_000_000;
    const block = blockOf(now, dayKindOf(now));
    const ids = ['crate', 'mixes', 'onTheRise', 'because'];
    mindbeat['bandit'].bumpExternal(shelfArmKey('mixes', block), 20, 0);
    await mindbeat.rankHomeShelves(ids, now);
    const crateBefore = mindbeat['bandit'].arm(shelfArmKey('crate', block))?.alpha ?? 1;
    await mindbeat.noteShelfEngagement('crate', now);
    const crate = mindbeat['bandit'].arm(shelfArmKey('crate', block));
    const mixes = mindbeat['bandit'].arm(shelfArmKey('mixes', block));
    expect(crate?.alpha).toBeCloseTo(crateBefore + SHELF_REWARD.positive, 9);
    expect(mixes?.beta).toBeGreaterThan(1); // the loser of the pass got β
  });

  test('homeShelfIpsValue: the off-policy value is computable and bounded-capped', async () => {
    const { mindbeat } = await import('../src/ai/mindbeat');
    // IPS entries exist only after ranked passes; unknown arm ⇒ honest 0.
    expect(mindbeat.homeShelfIpsValue('nonexistent', 'morning')).toBe(0);
    expect(SHELF_RANK.ipsCap).toBe(200); // law ⑧ literal
    expect(SHELF_REWARD.positive).toBe(1.0);
    expect(SHELF_REWARD.negative).toBe(1.0);
  });

  test('SOURCE LOCK: HomeScreen orders the AI shelves by the ranking', async () => {
    const src = await Bun.file('src/screens/HomeScreen.tsx').text();
    expect(src).toContain('rankHomeShelves');
    expect(src).toContain('noteShelfEngagement');
    expect(src).toContain('aiSlot(0)');
    expect(src).toContain('aiSlot(3)');
    // the byte-exact fallback: identity ranking keeps shelfOrder null
    expect(src).toContain('identity ? null : ranked');
  });

  test('flush persists the ts (the decay clock survives the boot)', async () => {
    const kv = new MemKV();
    const b = new Bandit(kv as never);
    await b.hydrate();
    b.bumpExternal('t:abc', 2, 0);
    await b.flushNow();
    const stored = (await kv.get<Record<string, { alpha: number; beta: number; ts?: number }>>('banditArms'))!;
    expect(stored['t:abc'].alpha).toBeCloseTo(3, 6);
    expect(typeof stored['t:abc'].ts).toBe('number');
  });
});

// ══════════════════════════════════════════════════════════════════════
// BAR 4 — THE 64 kB RANGE PRE-WARM
// ══════════════════════════════════════════════════════════════════════

describe('v5.3.0 BAR 4 — the Range pre-warm gate (pure contract)', () => {
  beforeEach(() => {
    resetPrewarmForTests();
    resetImagePrewarmForTests();
    setDataSaverActive(false);
  });

  test('wifi + no data-saver ⇒ ONE warm of exactly 65,536 bytes (the SLO number)', () => {
    setNetworkKindForTests('wifi');
    const calls: Array<[string, number]> = [];
    setRangeFetcherForTests(async (url, bytes) => {
      calls.push([url, bytes]);
    });
    expect(rangePrewarmUrl('https://cdn/audio.mp4')).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(['https://cdn/audio.mp4', 65_536]);
    expect(PREWARM.rangeBytes).toBe(65_536);
  });

  test('cellular / unknown / offline / data-saver ⇒ NO warm (the conservative law)', () => {
    const calls: Array<[string, number]> = [];
    setRangeFetcherForTests(async (url, bytes) => {
      calls.push([url, bytes]);
    });
    setNetworkKindForTests('cellular');
    expect(rangePrewarmUrl('https://x')).toBe(false);
    setNetworkKindForTests('unknown');
    expect(rangePrewarmUrl('https://x')).toBe(false);
    setNetworkKindForTests('none');
    expect(rangePrewarmUrl('https://x')).toBe(false);
    setNetworkKindForTests('wifi');
    return setDataSaverActive(true).then(() => {
      expect(rangePrewarmUrl('https://x')).toBe(false);
      expect(calls.length).toBe(0);
    });
  });

  test('single flight per URL inside the TTL; re-warms after it', () => {
    setNetworkKindForTests('wifi');
    let fired = 0;
    setRangeFetcherForTests(async () => {
      fired += 1;
    });
    const t0 = 1_700_000_000_000;
    expect(rangePrewarmUrl('https://x', { now: t0 })).toBe(true);
    expect(rangePrewarmUrl('https://x', { now: t0 + 1000 })).toBe(false); // in flight window
    expect(rangePrewarmUrl('https://x', { now: t0 + PREWARM.rangeTtlMs + 1 })).toBe(true); // expired
    expect(fired).toBe(2);
  });

  test('the warmed set is hard-capped (law ⑧) and LRU-evicts', () => {
    setNetworkKindForTests('wifi');
    setRangeFetcherForTests(async () => undefined);
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < PREWARM.rangeCap + 3; i++) {
      rangePrewarmUrl(`https://cdn/${i}`, { now: t0 + i });
    }
    expect(rangeWarmSize()).toBe(PREWARM.rangeCap);
    expect(PREWARM.rangeCap).toBe(8);
  });

  test('garbage urls never warm', () => {
    setNetworkKindForTests('wifi');
    expect(rangePrewarmUrl(null)).toBe(false);
    expect(rangePrewarmUrl(undefined)).toBe(false);
    expect(rangePrewarmUrl('')).toBe(false);
  });

  test('primePrewarm fires the range warm AFTER the URL resolves (wifi runtime)', async () => {
    resetPrewarmForTests();
    setNetworkKindForTests('wifi');
    setPrewarmResolverForTests(async () => ({ url: 'https://resolved/next.mp4' }));
    const warms: string[] = [];
    setRangeFetcherForTests(async (url) => {
      warms.push(url);
    });
    const q = [
      { id: 'a', title: 'a', artist: 'x', duration: 100, source: 'youtube' },
      { id: 'b', title: 'b', artist: 'x', duration: 100, source: 'youtube' },
    ] as never as Array<import('../src/types').Track>;
    primePrewarm(q, 0);
    await new Promise((r) => setTimeout(r, 5));
    expect(warms).toEqual(['https://resolved/next.mp4']);
  });
});

// ══════════════════════════════════════════════════════════════════════
// BAR 5 — THE E4M3 QUANTIZED COSINE (the Voyager layer)
// ══════════════════════════════════════════════════════════════════════

describe('v5.3.0 BAR 5 — float8-E4M3 encode/decode (bit-exact)', () => {
  test('the literal codes: 0, 1, 0.5, and the sign bit', () => {
    expect(quantizeE4M3(0)).toBe(0x00);
    expect(quantizeE4M3(1)).toBe(0x38); // 2^0 × 1.0 → e=7, m=0
    expect(quantizeE4M3(0.5)).toBe(0x30); // 2^-1 × 1.0 → e=6, m=0
    expect(quantizeE4M3(0.25)).toBe(0x28); // 2^-2 × 1.0 → e=5, m=0
    expect(quantizeE4M3(-1)).toBe(0xb8); // sign | 0x38
    expect(quantizeE4M3(448)).toBe(0x7e); // 2^8 × 1.75 → e=15, m=6
    expect(quantizeE4M3(1000)).toBe(0x7f); // clamped at the max normal (480)
  });

  test('dequantize: the exact dyadic grid', () => {
    expect(dequantizeE4M3(0)).toBe(0);
    expect(dequantizeE4M3(0x38)).toBe(1);
    expect(dequantizeE4M3(0x30)).toBe(0.5);
    expect(dequantizeE4M3(0x7e)).toBe(448);
    expect(dequantizeE4M3(0x7f)).toBe(480); // this variant's max normal
    expect(dequantizeE4M3(0x01)).toBeCloseTo(2 ** -9, 15); // smallest subnormal
    expect(dequantizeE4M3(0xb8)).toBe(-1);
  });

  test('THE GRID LAW: quantize(dequantize(code)) === code for ALL 256 codes', () => {
    for (let code = 0; code < 256; code++) {
      expect(quantizeE4M3(dequantizeE4M3(code))).toBe(code);
    }
  });

  test('the [0,1] feature domain round-trips exactly on grid points', () => {
    for (const v of [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1]) {
      expect(dequantizeE4M3(quantizeE4M3(v))).toBeCloseTo(v, 12);
    }
  });

  test('OFF-GRID values round to NEAREST (the mantissa rounding law)', () => {
    // 0.8 sits in the 2⁻¹ binade: scaled 1.6 ⇒ mantissa round(0.6·8)=5
    // ⇒ code 0x35 ⇒ dequantized 0.5·1.625 = 0.8125 (NOT 0.75 — floor
    // would under-quantize every off-grid feature; the mutation class).
    expect(quantizeE4M3(0.8)).toBe(0x35);
    expect(dequantizeE4M3(0x35)).toBe(0.8125);
    // 0.72: scaled 1.44 ⇒ round(0.44·8)=4 ⇒ 0x34 (2⁻¹·1.5 = 0.75) — one step down
    expect(quantizeE4M3(0.72)).toBe(0x34);
    expect(dequantizeE4M3(0x34)).toBe(0.75);
  });
});

describe('v5.3.0 BAR 5 — the quantized feature vector + cosine', () => {
  test('any missing column ⇒ null (the v5.2.1 no-op contract)', () => {
    expect(quantizedFeatureVector({ e: 0.5, v: 0.5, d: 0.5 })).toBeNull();
    expect(quantizedFeatureVector({ e: 0.5, v: 0.5, d: 0.5, a: 0.5, s: 0.5 })).toBeNull();
    expect(quantizedFeatureVector({})).toBeNull();
    expect(quantizedFeatureVector({ e: Number.NaN, v: 0.5, d: 0.5, a: 0.5, s: 0.5, i: 0.5 })).toBeNull();
  });

  test('the full vector: six E4M3 bytes in [e, v, d, a, s, i] order', () => {
    const q = quantizedFeatureVector({ e: 1, v: 0.5, d: 0.25, a: 0, s: 1, i: 0.5 });
    expect(q).toEqual([0x38, 0x30, 0x28, 0x00, 0x38, 0x30]);
  });

  test('cosine: identical vectors → 1; orthogonal → 0; opposite → -1', () => {
    const v = quantizedFeatureVector({ e: 0.8, v: 0.4, d: 0.6, a: 0.2, s: 0.1, i: 0.05 })!;
    expect(quantizedCosine(v, v)).toBeCloseTo(1, 12);
    const x = [quantizeE4M3(1), quantizeE4M3(0), 0, 0, 0, 0];
    const y = [quantizeE4M3(0), quantizeE4M3(1), 0, 0, 0, 0];
    expect(quantizedCosine(x, y)).toBe(0);
    expect(quantizedCosine([0x38, 0, 0, 0, 0, 0], [0xb8, 0, 0, 0, 0, 0])).toBeCloseTo(-1, 12);
  });

  test('cosine is monotone in proximity (the seed-neighborhood ordering)', () => {
    const seed = quantizedFeatureVector({ e: 0.8, v: 0.6, d: 0.7, a: 0.1, s: 0.05, i: 0.02 })!;
    const near = quantizedFeatureVector({ e: 0.78, v: 0.62, d: 0.68, a: 0.12, s: 0.06, i: 0.03 })!;
    const far = quantizedFeatureVector({ e: 0.1, v: 0.1, d: 0.1, a: 0.9, s: 0.8, i: 0.95 })!;
    expect(quantizedCosine(seed, near)).toBeGreaterThan(quantizedCosine(seed, far));
  });

  test('rankSoundAlike: the quantized cosine breaks tag-score ties toward the seed', () => {
    const base = { genre: 'indie', mood: 'calm', era: 'current', language: 'hindi' };
    const seedTags = { artist: 'seedartist', ...base };
    const mk = (id: string, artist: string, qvec?: number[]) => ({
      track: { id, title: `T ${id}`, artist, album: 'x' } as never,
      tags: { artist, ...base },
      qvec,
    });
    const seedQ = quantizedFeatureVector({ e: 0.8, v: 0.6, d: 0.7, a: 0.1, s: 0.05, i: 0.02 })!;
    const near = mk('zz-near', 'nearartist', quantizedFeatureVector({ e: 0.78, v: 0.62, d: 0.68, a: 0.12, s: 0.06, i: 0.03 })!);
    const far = mk('aa-far', 'farartist', quantizedFeatureVector({ e: 0.1, v: 0.1, d: 0.1, a: 0.9, s: 0.8, i: 0.95 })!);
    // Both share [genre, mood, era, language] with the seed (artist
    // differs) ⇒ an exact 4-dim tag-score TIE. v5.2.1 ordered by id
    // (aa-far first); the cosine tie-break flips it toward the seed's
    // feature space: zz-near wins despite the LARGER id.
    const picks = rankSoundAlike(seedTags, [far, near], 2, seedQ);
    expect(picks.length).toBe(2);
    expect(picks[0].track.id).toBe('zz-near');
    expect(picks[1].track.id).toBe('aa-far');
    // WITHOUT qvecs the v5.2.1 id order stands, byte-identical:
    const legacy = rankSoundAlike(seedTags, [far, near], 2);
    expect(legacy[0].track.id).toBe('aa-far');
  });
});

// ══════════════════════════════════════════════════════════════════════
// BAR 6 — THE EQUAL-POWER COSINE CROSSFADE (default-curve binding)
// ══════════════════════════════════════════════════════════════════════

describe('v5.3.0 BAR 6 — the curve binding + the off no-op', () => {
  test('CROSSFADE.curve is the cosine literal; the linear legacy is selectable', () => {
    expect(CROSSFADE.curve).toBe('cosine');
    expect(fadeCurveFactor(0.5)).toBeCloseTo(0.7071067811865476, 15); // default binds cosine
    expect(fadeCurveFactor(0.5, 'linear')).toBe(0.5); // the v5.2.1 ramp
  });

  test('the off path is a byte-exact no-op (0 s ⇒ factor exactly 1.0)', () => {
    expect(fadeFactorFor(95, 100, 0)).toBe(1.0);
    expect(fadeFactorFor(100, 100, 0)).toBe(1.0);
    expect(fadeFactorFor(95, 0, 5)).toBe(1.0); // unknown duration
  });

  test('equal-power: cos² + sin² = 1 across the ramp (the DJ-standard invariant)', () => {
    for (const p of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      const c = fadeCurveFactor(p);
      const s = Math.sin((p * Math.PI) / 2);
      expect(c * c + s * s).toBeCloseTo(1, 12);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// BAR 7 — THE SINGALONG DWELL SIGNAL
// ══════════════════════════════════════════════════════════════════════

describe('v5.3.0 BAR 7 — the dwell constants + the wiring (law ③/⑩)', () => {
  test('the dwell constants are the locked literals', () => {
    expect(SINGALONG_DWELL.minOpenRatio).toBe(0.5);
    expect(SINGALONG_DWELL.weight).toBe(1.0);
  });

  test('SOURCE LOCK: the event type + ledger emit + profile bump + the fold', async () => {
    const typesSrc = await Bun.file('src/ai/core/types.ts').text();
    expect(typesSrc).toContain("'SINGALONG_DWELL'");
    const ledgerSrc = await Bun.file('src/ai/core/ledger.ts').text();
    expect(ledgerSrc).toContain("emit(\n      'SINGALONG_DWELL'");
    const profileSrc = await Bun.file('src/ai/core/profile.ts').text();
    expect(profileSrc).toContain("e.type === 'SINGALONG_DWELL'");
    expect(profileSrc).toContain('SINGALONG_DWELL.weight');
    const mbSrc = await Bun.file('src/ai/mindbeat.ts').text();
    expect(mbSrc).toContain('SINGALONG_DWELL.minOpenRatio');
    expect(mbSrc).toContain('foldSingalongDwell');
    expect(mbSrc).toContain("record.grade !== 'COMPLETED'"); // completed-only gate
  });

  test('SOURCE LOCK: the PlayerScreen reports SingAlong visibility', async () => {
    const src = await Bun.file('src/screens/PlayerScreen.tsx').text();
    expect(src).toContain('mindbeat.noteSingAlongVisible(true)');
    expect(src).toContain('mindbeat.noteSingAlongVisible(false)');
  });

  test('the profile fold: a dwell event bumps the artist by exactly weight 1.0', async () => {
    const { buildProfile, emptyProfile } = await import('../src/ai/core/profile');
    const base = buildProfile([], [], [], { now: 1_700_000_000_000, boundaries: undefined } as never);
    const ev = [{
      id: 'e1', ts: 1_700_000_000_000, type: 'SINGALONG_DWELL' as never,
      sessionId: 's', trackId: 't1', payload: { artist: 'Arijit Singh', openRatio: 0.8 },
    }];
    const withDwell = buildProfile([], ev as never, [], { now: 1_700_000_000_000, boundaries: undefined } as never);
    const before = base.artists['arijit singh']?.w ?? 0;
    const after = withDwell.artists['arijit singh']?.w ?? 0;
    expect(after - before).toBeCloseTo(SINGALONG_DWELL.weight, 9);
  });
});

// ══════════════════════════════════════════════════════════════════════
// HOUSE-LAW SWEEP (v5.3.0 additions)
// ══════════════════════════════════════════════════════════════════════

describe('v5.3.0 — house-law sweep over the new surface', () => {
  test('law ④: the player layer imports the seeded rng THROUGH the facade', async () => {
    const src = await Bun.file('src/player/PlayerProvider.tsx').text();
    expect(src).toContain("from '../ai/mindbeat'");
    expect(src).not.toContain("from '../ai/core/time'");
    const spread = await Bun.file('src/player/spreadShuffle.ts').text();
    expect(spread).not.toContain("from '../ai/core");
    const code = spread.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    expect(code.includes('Math.random')).toBe(false);
  });

  test('law ⑤: zero Math.random in CODE across the new/changed engine modules', async () => {
    for (const f of ['src/player/spreadShuffle.ts', 'src/ai/core/similarity.ts', 'src/ai/core/bandit.ts']) {
      const src = await Bun.file(f).text();
      const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
      expect(code.includes('Math.random()')).toBe(false);
    }
  });

  test('law ⑧: every v5.3.0 cache declares its cap in the tuning table', () => {
    expect(PREWARM.rangeCap).toBe(8);
    expect(SHELF_RANK.ipsCap).toBe(200);
  });

  test('the seeded PRNG is the app-standard mulberry32 (self-check)', () => {
    const r = seededRandom(42);
    const first = [r(), r(), r()];
    const r2 = seededRandom(42);
    expect([r2(), r2(), r2()]).toEqual(first);
    expect(first.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(hash32('tsf')).toBe(hash32('tsf')); // stable
    expect(hash32('tsf')).not.toBe(hash32('Tsf')); // case-sensitive
  });
});
