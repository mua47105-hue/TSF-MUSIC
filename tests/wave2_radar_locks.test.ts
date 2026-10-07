/**
 * MAGNUM OPUS WAVE 2 · F8 — TASTE RADAR LOCKS.
 *
 * The bar: fixture listens produce EXPECTED axis values (literals);
 * the 30-second rule gates every axis; zero streams → honestly zero
 * (never a fake shape); the hexagon geometry is deterministic and
 * placement-ready; the share text renders offline from the axes alone;
 * reduced-motion is honored BY CONSTRUCTION (nothing animates — locked
 * as a source law: no Animated import in the chart).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  computeRadarAxes,
  computeRadarAxesKey,
  RADAR_AXIS_ORDER,
  radarGeometry,
  radarShareText,
  type RadarAxes,
} from '../src/ai/radar';
import type { ListenRecord, TasteProfile } from '../src/ai/core/types';

// ── fixture builders (deterministic — no Math.random anywhere) ──────────

let seq = 0;
function listen(p: Partial<ListenRecord> & { artist: string }): ListenRecord {
  seq += 1;
  return {
    trackId: p.trackId ?? `t${seq}`,
    artistId: p.artistId,
    artist: p.artist,
    title: p.title ?? `Track ${seq}`,
    year: p.year,
    energy: p.energy ?? 0.5,
    valence: p.valence ?? 0.5,
    sessionId: 's1',
    surface: 'player',
    startedTs: 1700000000000 + seq,
    listenedMs: p.listenedMs ?? 120000,
    durationMs: p.durationMs ?? 200000,
    completionRatio: 0.6,
    grade: 'COMPLETED',
    wasRecommended: false,
    explorationSlot: false,
  };
}

const emptyProfile: TasteProfile = {
  builtAt: 0,
  sessionCount: 0,
  artists: {},
  genres: {},
  languages: {},
  eras: {},
  proxy: { energyPref: { mean: 0.5, std: 0 }, valencePref: { mean: 0.5, std: 0 }, tempoDist: { slow: 0, mid: 0, fast: 0 } },
  daypart: {},
  activities: {},
  skipProfiles: {},
  coplayTracks: {},
  coplayArtists: {},
  flowTracks: {},
  clusters: { artistClusters: [], moodCells: [] },
} as unknown as TasteProfile;

const NOW = new Date(2025, 5, 15, 12, 0, 0).getTime();

describe('F8 · computeRadarAxes — documented formulas over fixtures', () => {
  test('two artists, two tracks × 2 plays each → exact literal axes', () => {
    // 4 counted streams: A/B artists, t1/t2 tracks, years 1994 & 2001
    const listens = [
      listen({ artist: 'A. Rahman', trackId: 't1', year: 1994, energy: 0.8, valence: 0.6 }),
      listen({ artist: 'A. Rahman', trackId: 't1', year: 1994, energy: 0.6, valence: 0.4 }),
      listen({ artist: 'Shreya Ghoshal', trackId: 't2', year: 2001, energy: 0.4, valence: 0.8 }),
      listen({ artist: 'Shreya Ghoshal', trackId: 't2', year: 2001, energy: 0.2, valence: 0.2 }),
    ];
    const ax = computeRadarAxes(emptyProfile, listens, NOW);
    // energy = (0.8+0.6+0.4+0.2)/4 = 0.5 ; valence = (0.6+0.4+0.8+0.2)/4 = 0.5
    expect(ax.energy).toBeCloseTo(0.5, 10);
    expect(ax.valence).toBeCloseTo(0.5, 10);
    // diversity = 2 distinct artists / 25 saturation = 0.08
    expect(ax.diversity).toBeCloseTo(2 / 25, 10);
    // discovery = 0 — both tracks were met twice (no 1-play finds)
    expect(ax.discovery).toBeCloseTo(0, 10);
    // loyalty = top artist share 2/4 = 0.5 → 0.5/0.5 = 1.0 (saturated)
    expect(ax.loyalty).toBeCloseTo(1, 10);
    // eraSpread = 2 decades (1990s, 2000s) / 6 saturation = 1/3
    expect(ax.eraSpread).toBeCloseTo(2 / 6, 10);
  });

  test('discovery counts the finds you met exactly once', () => {
    const listens = [
      listen({ artist: 'A', trackId: 'met-once' }),
      listen({ artist: 'B', trackId: 'return' }),
      listen({ artist: 'B', trackId: 'return' }),
    ];
    const ax = computeRadarAxes(emptyProfile, listens, NOW);
    expect(ax.discovery).toBeCloseTo(1 / 2, 10); // 1 of 2 distinct tracks is a 1-play find
  });

  test('the 30-second rule gates EVERY axis (a 2s open is not taste)', () => {
    const short = [listen({ artist: 'A', listenedMs: 29999 }), listen({ artist: 'B', listenedMs: 5000 })];
    expect(computeRadarAxesKey(computeRadarAxes(emptyProfile, short, NOW))).toBe('0|0|0|0|0|0');
    // 30000 exactly passes — the boundary is inclusive
    const edge = [listen({ artist: 'A', listenedMs: 30000, energy: 0.7, valence: 0.3 })];
    const ax = computeRadarAxes(emptyProfile, edge, NOW);
    expect(ax.energy).toBeCloseTo(0.7, 10);
    expect(ax.valence).toBeCloseTo(0.3, 10);
  });

  test('zero listens → all-zero axes; the empty key drives the cold caption', () => {
    const ax = computeRadarAxes(emptyProfile, [], NOW);
    expect(ax).toEqual({ energy: 0, valence: 0, diversity: 0, discovery: 0, loyalty: 0, eraSpread: 0 });
    expect(radarIsEmpty(ax)).toBeTrue();
  });

  test('axes clamp at 1 (a 30-artist binge cannot exceed the hexagon)', () => {
    const many = Array.from({ length: 30 }, (_, i) => listen({ artist: `artist-${i}`, trackId: `t${i}` }));
    const ax = computeRadarAxes(emptyProfile, many, NOW);
    expect(ax.diversity).toBe(1); // 30/25 clamped
    expect(ax.loyalty).toBeCloseTo(1 / 30 / 0.5, 10); // top share 1/30 → /0.5 = 0.0667
  });

  test('axis order is the hexagon contract: six fixed spokes', () => {
    expect(RADAR_AXIS_ORDER).toEqual(['energy', 'valence', 'diversity', 'discovery', 'loyalty', 'eraSpread']);
  });

  test('share text renders offline from the axes alone (deterministic)', () => {
    const text = radarShareText({ energy: 1, valence: 0.5, diversity: 0.08, discovery: 0, loyalty: 1, eraSpread: 2 / 6 });
    expect(text).toContain('MY TASTE RADAR — TSF MUSIC');
    expect(text).toContain('Energy 100%');
    expect(text).toContain('Vibe 50%');
    expect(text).toContain('Range 8%');
    expect(text).toContain('Finds 0%');
    expect(text).toContain('Eras 33%');
    expect(radarShareText({ energy: 0, valence: 0, diversity: 0, discovery: 0, loyalty: 0, eraSpread: 0 })).toBe(
      'MY TASTE RADAR — TSF MUSIC\nEnergy 0% · Vibe 0% · Range 0%\nFinds 0% · Loyalty 0% · Eras 0%',
    );
  });

  function radarIsEmpty(ax: RadarAxes): boolean {
    return computeRadarAxesKey(ax) === '0|0|0|0|0|0';
  }
});

describe('F8 · radarGeometry — the View-drawn hexagon (no svg)', () => {
  test('full axes: top vertex at (size/2, 2), frame radius size/2-2', () => {
    const g = radarGeometry([1, 1, 1, 1, 1, 1], 240);
    expect(g.center).toEqual({ x: 120, y: 120 });
    expect(g.frame[0].x).toBeCloseTo(120, 10);
    expect(g.frame[0].y).toBeCloseTo(2, 10); // -90° → straight up, radius 118
    expect(g.spokeLengths.every((l) => Math.abs(l - 118) < 1e-9)).toBeTrue();
    expect(g.frameEdges.length).toBe(6);
    expect(g.dataEdges.length).toBe(6);
    expect(g.spokes.length).toBe(6);
  });

  test('data polygon follows each axis value (0.5 → half radius)', () => {
    const g = radarGeometry([0.5, 0.5, 0.5, 0.5, 0.5, 0.5], 240);
    expect(g.data[0].y).toBeCloseTo(120 - 59, 10); // 118 * 0.5 = 59 above center
    // a zero axis still shows a pinprick (0.04 floor), never disappears
    const z = radarGeometry([0, 0.5, 0.5, 0.5, 0.5, 0.5], 240);
    expect(z.data[0].y).toBeCloseTo(120 - 118 * 0.04, 10);
  });

  test('determinism: same values + size → byte-identical geometry, twice', () => {
    const a = JSON.stringify(radarGeometry([0.9, 0.1, 0.5, 0.5, 0.2, 0.7], 240));
    const b = JSON.stringify(radarGeometry([0.9, 0.1, 0.5, 0.5, 0.2, 0.7], 240));
    expect(a).toBe(b);
  });

  test('source laws: no svg dependency, no animation, no randomness', () => {
    const chart = readFileSync('src/components/RadarChart.tsx', 'utf8');
    expect(chart).not.toMatch(/from ['"]react-native-svg['"]/); // no svg IMPORT (a mention in prose is fine)
    expect(chart).not.toMatch(/Animated/); // static render → reduce-motion honored by construction
    expect(chart).toContain('radarGeometry'); // the locked pure math is the renderer's source
    const core = readFileSync('src/ai/radar.ts', 'utf8');
    expect(core).not.toMatch(/Math\.random\s*\(/); // determinism law X4 (a prose mention is not a call)
  });
});
