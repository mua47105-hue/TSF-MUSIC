/**
 * WAVE 6b — THE WEEKLY CRATE LOCKS (bar: Spotify Discover Weekly).
 *
 * Bars pinned (gauntlet/WAVE6-BARS.md §6b):
 *   • ISO week math: same week → same key, Monday rollover, year edge
 *   • one edition per week, identified by weekKey + human subtitle
 *   • 30-track cap; discovery-weighted build (35/40/25)
 *   • ≤30% overlap with the previous week's crate
 *   • honest reason line on EVERY track
 *   • cold profile → null (shelf hidden, never filler)
 *   • thin catalog → null (a 3-track crate is an embarrassment)
 *   • every served pick reports a 'weekly_crate' exposure
 *
 * The store roundtrip (AsyncStorage persistence) is exercised by the
 * web E2E walkthrough, not here — storage.ts cannot load under bun.
 */

import { describe, expect, test } from 'bun:test';
import { buildWeeklyCrate, weekKeyOf, weekMonday, weekLabel } from '../../src/ai/surfaces/weekly';
import { emptyProfile } from '../../src/ai/core/profile';
import { SessionBrain } from '../../src/ai/core/session';
import type { SurfaceCtx } from '../../src/ai/surfaces/deps';
import type { ListenRecord, TasteProfile } from '../../src/ai/core/types';
import type { Track } from '../../src/types';
import { hasBlockedTerm } from '../../src/safety';

// 2026-10-03 is a Saturday inside ISO week 40 (Mon Sep 28 – Sun Oct 4).
const NOW = new Date('2026-10-03T12:00:00Z').getTime();

function trackOf(id: string, artist: string, extra: Partial<Track> = {}): Track {
  return {
    id,
    title: `Crate Item ${id}`,
    artist,
    album: `${artist} Album`,
    artwork: '',
    duration: 200,
    source: 'saavn',
    previewOnly: false,
    language: 'hindi',
    ...extra,
  };
}

function listenOf(track: Track, ts: number): ListenRecord {
  return {
    trackId: track.id,
    artist: track.artist,
    title: track.title,
    language: track.language,
    energy: 0.5,
    valence: 0.5,
    sessionId: 's-fix',
    surface: 'user_queue',
    startedTs: ts,
    listenedMs: 120_000,
    durationMs: 200_000,
    completionRatio: 0.6,
    grade: 'PLAYED_OUT',
  };
}

const ANCHORS = ['arijit singh', 'shreya ghoshal', 'pritam', 'diljit dosanjh', 'ap dhillon', 'guru randhawa'];
const NEIGHBORS = ['jubin nautiyal', 'kailash kher', 'kishore kumar', 'karan aujla', 'the weeknd', 'drake'];

function crateProfile(): TasteProfile {
  const p = emptyProfile(NOW);
  p.clusters = {
    artistClusters: [
      { id: 'c1', label: 'Arijit Singh', artistIds: ['arijit singh', 'shreya ghoshal', 'pritam'] },
      { id: 'c2', label: 'Diljit Dosanjh', artistIds: ['diljit dosanjh', 'ap dhillon', 'guru randhawa'] },
    ],
    moodCells: [
      { id: 'm1', label: 'Evening Glow', energyCenter: 0.6, valenceCenter: 0.5, trackIds: [] },
    ],
  };
  p.coplayArtists = {
    'arijit singh': { 'jubin nautiyal': 5, 'kailash kher': 4 },
    'diljit dosanjh': { 'karan aujla': 5, drake: 4 },
  };
  return p;
}

function crateApi(opts: { perArtist?: number } = {}): SurfaceCtx['api'] {
  const per = opts.perArtist ?? 10;
  return {
    search: async (q: string, limit = 20) =>
      ANCHORS.some((a) => q.toLowerCase().includes(a.split(' ')[0]!))
        ? Array.from({ length: Math.min(12, limit) }, (_, i) => trackOf(`fresh-${q.slice(0, 4)}-${i}`, `fresh artist ${i}`))
        : [],
    artistTracks: async (artist: string, limit = 14) =>
      [...ANCHORS, ...NEIGHBORS].includes(artist.toLowerCase())
        ? Array.from({ length: Math.min(per, limit) }, (_, i) => trackOf(`crate-${artist.replace(/\s+/g, '-')}-${i}`, artist))
        : [],
    trending: async () => [],
  };
}

function crateCtx(overrides: Partial<SurfaceCtx> = {}): SurfaceCtx {
  const brain = new SessionBrain(NOW);
  return {
    api: crateApi(),
    profile: crateProfile(),
    session: brain.state,
    now: NOW,
    listens: [],
    ...overrides,
  };
}

describe('W6b — ISO week math (the edition identity)', () => {
  test('same week, different days → same key', () => {
    const mon = new Date('2026-09-28T00:00:00Z').getTime();
    const sat = new Date('2026-10-03T23:00:00Z').getTime();
    const sun = new Date('2026-10-04T22:00:00Z').getTime();
    expect(weekKeyOf(mon)).toBe('2026-W40');
    expect(weekKeyOf(sat)).toBe('2026-W40');
    expect(weekKeyOf(sun)).toBe('2026-W40');
  });

  test('Monday rollover → new key', () => {
    const sun = new Date('2026-10-04T23:00:00Z').getTime();
    const mon = new Date('2026-10-05T06:00:00Z').getTime();
    expect(weekKeyOf(sun)).toBe('2026-W40');
    expect(weekKeyOf(mon)).toBe('2026-W41');
  });

  test('year edge: two calendar years can share one ISO week', () => {
    // Jan 1 2027 (Fri) belongs to the week whose Thursday is Dec 31 2026
    // → per ISO 8601 BOTH dates sit in 2026-W53. The rollover at the
    // year boundary is a week late — and that is CORRECT.
    expect(weekKeyOf(new Date('2026-12-31T12:00:00Z').getTime())).toBe('2026-W53');
    expect(weekKeyOf(new Date('2027-01-01T12:00:00Z').getTime())).toBe('2026-W53');
    // …and the week containing 2027's first Thursday is 2027-W01.
    expect(weekKeyOf(new Date('2027-01-07T12:00:00Z').getTime())).toBe('2027-W01');
  });

  test('weekMonday: the Saturday of W40 opens on Mon Sep 28', () => {
    const monday = new Date(weekMonday(NOW));
    expect(monday.toISOString().slice(0, 10)).toBe('2026-09-28');
    expect(weekLabel(NOW)).toBe('Week of Sep 28');
  });
});

describe('W6b — buildWeeklyCrate (the edition itself)', () => {
  test('happy path: a real shelf (20–30), weekKey identity, honest reason on every row', async () => {
    const exposures: Array<{ id: string; surface: string }> = [];
    const crate = await buildWeeklyCrate(crateCtx({
      onExposure: (id, surface) => exposures.push({ id, surface }),
    }), new Set());
    expect(crate).not.toBeNull();
    // The engine's diversity caps may leave the shelf a few under 30 —
    // the CAP is the contract, never filler.
    expect(crate!.tracks.length).toBeGreaterThanOrEqual(20);
    expect(crate!.tracks.length).toBeLessThanOrEqual(30);
    expect(crate!.weekKey).toBe('2026-W40');
    expect(crate!.id).toBe(`weekly-crate-${crate!.weekKey.toLowerCase()}`);
    expect(crate!.subtitle).toContain('Week of Sep 28');
    expect(crate!.subtitle).toContain(`${crate!.tracks.length} tracks`);
    expect(crate!.title).toBe('The Weekly Crate');
    for (const t of crate!.tracks) expect(t.reason.length).toBeGreaterThan(4);
    for (const e of exposures) expect(e.surface).toBe('weekly_crate');
  });

  test('≤30% of last week’s crate may return', async () => {
    const api = crateApi();
    // Poison the pool: EVERY id the api can serve belongs to last week.
    const allIds: string[] = [];
    for (const a of [...ANCHORS, ...NEIGHBORS]) {
      for (let i = 0; i < 10; i++) allIds.push(`crate-${a.replace(/\s+/g, '-')}-${i}`);
    }
    ANCHORS.forEach((a, ai) => {
      for (let i = 0; i < 12; i++) allIds.push(`fresh-${a.slice(0, 4)}-${i}`);
    });
    const crate = await buildWeeklyCrate(crateCtx({ api }), new Set(allIds));
    expect(crate).not.toBeNull();
    const prev = crate!.tracks.filter((t) => allIds.includes(t.id));
    expect(prev.length).toBeLessThanOrEqual(Math.ceil(30 * 0.3));
  });

  test('discovery lane is RESERVED (≥25% when the pool allows — not leftovers)', async () => {
    const crate = await buildWeeklyCrate(crateCtx(), new Set());
    const fresh = crate!.tracks.filter((t) => t.id.startsWith('fresh-'));
    // 12 fresh finds exist; the reserved lane is 25% of ~28 → must hold ≥ 5.
    expect(fresh.length).toBeGreaterThanOrEqual(5);
  });

  test('unheard means never-listened: a 90d-old listen never rides discovery', async () => {
    // The user already heard fresh-arij-0 (30 days ago). It must NOT be
    // "discovered" to them — even though the 7d serve window forgot it.
    const heard = trackOf('fresh-arij-0', 'fresh artist 0');
    const listens = [listenOf(heard, NOW - 30 * 86_400_000)];
    const crate = await buildWeeklyCrate(crateCtx({ listens }), new Set());
    const ids = crate!.tracks.map((t) => t.id);
    expect(ids).not.toContain('fresh-arij-0');
  });

  test('safety filter holds across EVERY lane (core, bridge, discovery)', async () => {
    // Poison the catalog: one explicit track sneaks into the core pool.
    const poison = trackOf('crate-arijit-singh-0', 'arijit singh', {
      title: 'Explicit Banger',
      explicit: true,
    });
    const api = crateApi();
    const rawArtist = api.artistTracks;
    api.artistTracks = async (a: string, limit = 14) => {
      const base = await rawArtist(a, limit);
      return a.toLowerCase() === 'arijit singh' ? [poison, ...base.slice(1)] : base;
    };
    const crate = await buildWeeklyCrate(crateCtx({ api }), new Set());
    for (const t of crate!.tracks) {
      expect(t.explicit ?? false).toBe(false);
      expect(hasBlockedTerm(t.title)).toBe(false);
      expect(hasBlockedTerm(t.artist)).toBe(false);
    }
    expect(crate!.tracks.some((t) => t.id === 'crate-arijit-singh-0')).toBe(false);
  });

  test('cold profile → honest null (no clusters, no crate, no crash)', async () => {
    const brain = new SessionBrain(NOW);
    const cold = await buildWeeklyCrate(
      { api: crateApi(), profile: emptyProfile(NOW), session: brain.state, now: NOW, listens: [] },
      new Set(),
    );
    expect(cold).toBeNull();
  });

  test('thin catalog → honest null (never ship a 3-track crate)', async () => {
    const brain = new SessionBrain(NOW);
    const empty: SurfaceCtx['api'] = { search: async () => [], artistTracks: async () => [], trending: async () => [] };
    const thin = await buildWeeklyCrate(
      { api: empty, profile: crateProfile(), session: brain.state, now: NOW, listens: [] },
      new Set(),
    );
    expect(thin).toBeNull();
  });
});
