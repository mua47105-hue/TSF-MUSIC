/**
 * SIG GAUNTLET (SEARCH-INTENT-RESCUE-PLAN §4) — bars SI1–SI6 as locks.
 *
 * Fixture = the live-probe evidence from research/tuchahiye (v3.3.0's
 * real failure for "tu chaiye of atif aslam"): the merged junk pool
 * where every safety net was suppressed and O'Meri Laila painted as
 * "Best match". These tests lock the fix forever.
 */

import { describe, expect, test, mock } from 'bun:test';

// The engine orchestrator imports storage (AsyncStorage) transitively —
// stub the RN-native modules BEFORE the dynamic import below.
mock.module('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
  Platform: { OS: 'android', select: (o: any) => o.android },
  NativeModules: {},
}));
mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
    multiRemove: async () => undefined,
  },
}));

import type { Track } from '../../src/types';
import { planSearch, registerArtistLexicon } from '../../src/search/plan';
import { probesFor } from '../../src/search/retrieve';
import { rankRows, artistContains, titleQueryTokens } from '../../src/search/rank';
import { verifySet } from '../../src/search/verify';
import { sigUnmet, verifyRescueRow } from '../../src/search/rescue';

// Module-load registration (NOT beforeAll — describe bodies and collection
// run before hooks, and the classifier reads this module state).
registerArtistLexicon(['atif aslam', 'arijit singh', 'shreya ghoshal', 'pritam']);

function track(p: Partial<Track> & { id: string; title: string }): Track {
  return {
    artist: 'Unknown',
    artwork: '',
    duration: 200,
    source: 'saavn',
    previewOnly: false,
    encryptedUrl: 'enc',
    ...p,
  } as Track;
}

// ── the live junk pool (captured from the real provider, v3.3.0 failure) ──
const JUNK: Track[] = [
  track({ id: 'j1', title: "O'Meri Laila", artist: 'Atif Aslam, Jyotica Tangri', artistsFull: ['Atif Aslam', 'Jyotica Tangri'], playCount: 39513344 }),
  track({ id: 'j2', title: 'Kon Mayate', artist: 'Atif Aslam BD', artistsFull: ['Atif Aslam BD'], playCount: 280 }),
  track({ id: 'j3', title: 'Tu Chahiye', artist: 'A.R. Dixit', artistsFull: ['A.R. Dixit'], playCount: 22124 }),
  track({ id: 'j4', title: 'Mujhko Tu Chaiye', artist: 'Tarun Panchal, Mahi Panchal', artistsFull: ['Tarun Panchal', 'Mahi Panchal'], playCount: 25056 }),
  track({ id: 'j5', title: 'Tu Chaiye', artist: 'SPECRO', artistsFull: ['SPECRO'], playCount: 56 }),
  track({ id: 'j6', title: 'Na Tu Chaiye', artist: 'Rock Hussain', artistsFull: ['Rock Hussain'], playCount: 52490 }),
  track({ id: 'j7', title: 'Tu Chahiye Mujhe', artist: 'Priyaanshi Verma', artistsFull: ['Priyaanshi Verma'], playCount: 1502 }),
];

const THE_QUERY = 'tu chaiye of atif aslam';

describe('SI3 — word-boundary artist matching (M2.2)', () => {
  test('"atif aslam" matches the plain credit', () => {
    expect(artistContains('atif aslam', 'atif aslam')).toBe(true);
  });
  test('"atif aslam" matches inside "muhammad atif aslam"', () => {
    expect(artistContains('muhammad atif aslam', 'atif aslam')).toBe(true);
  });
  test('"atif aslam" NEVER matches "atif aslam bd" (the v3.3.0 junk row)', () => {
    expect(artistContains('atif aslam bd', 'atif aslam')).toBe(false);
  });
  test('"atif aslam" never matches an unrelated credit', () => {
    expect(artistContains('jyotica tangri', 'atif aslam')).toBe(false);
  });
});

describe('SI5 — connector stripping + probe uniqueness (M1.1/M1.2)', () => {
  const plan = planSearch(THE_QUERY);
  test('plan splits artist/title/connectors correctly', () => {
    expect(plan.kind).toBe('artist_title');
    expect(plan.artistTokens).toEqual(['atif aslam']);
    expect(plan.titleTokens).toEqual(['tu', 'chaiye']);
    expect(plan.connectorTokens).toEqual(['of']);
  });
  test('no probe contains the connector "of"', () => {
    const probes = probesFor(plan);
    for (const p of probes) expect(p.includes(' of ')).toBe(false);
  });
  test('the clean title probe exists ("tu chaiye")', () => {
    expect(probesFor(plan)).toContain('tu chaiye');
  });
  test('probes are unique (v3.3.0 wasted a slot on raw ≡ normalized)', () => {
    const probes = probesFor(plan);
    expect(new Set(probes).size).toBe(probes.length);
  });
});

describe('SI6 — bounded orthographic variant expansion (M1.3)', () => {
  test('"tu chaiye" expands to "tu chahiye" (≤2, deterministic)', () => {
    const plan = planSearch('tu chaiye');
    expect(plan.variants).toContain('tu chahiye');
    expect(plan.variants.length).toBeLessThanOrEqual(2);
  });
  test('expansion is symmetric — "tu chahiye" offers "tu chaiye"', () => {
    expect(planSearch('tu chahiye').variants).toContain('tu chaiye');
  });
  test('known-correct titles produce no runaway variants', () => {
    expect(planSearch('kesariya').variants).toEqual([]);
  });
});

describe('SI4 — queryMatch truth: artist tokens never double-count (M2.1)', () => {
  test("O'Meri Laila (right artist, wrong song) has queryMatch 0", () => {
    const plan = planSearch(THE_QUERY);
    const ranked = rankRows(plan, verifySet(plan, [{ pool: 'p1', tracks: JUNK }]).rows);
    const row = ranked.find((r) => r.title === "O'Meri Laila");
    expect(row).toBeTruthy();
    expect(row!.queryMatch).toBe(0);
    expect(row!.artistMatch).toBe(1);
  });
  test('"Tu Chahiye" (A.R. Dixit) clears the 0.5 title bar', () => {
    const plan = planSearch(THE_QUERY);
    const ranked = rankRows(plan, verifySet(plan, [{ pool: 'p1', tracks: JUNK }]).rows);
    const row = ranked.find((r) => r.title === 'Tu Chahiye');
    // ortho-aware coverage (M1.3 applied to matching): "chahiye" in the
    // title is a plan-variant of the query's "chaiye", so BOTH tokens hit
    // \u2014 coverage 2/2 = 1.0 (previously 0.5 with exact-token matching).
    // The SIG bar itself is unchanged: the row must still clear 0.5 to
    // count as a title-match row, and artist tokens still never inflate it.
    expect(row!.queryMatch).toBe(1);
    expect(row!.queryMatch).toBeGreaterThanOrEqual(0.5);
    expect(row!.artistMatch).toBe(0);
  });
});

describe('SI2 — disambiguation override v2 (M2.3)', () => {
  const at = (title: string) => {
    const plan = planSearch(THE_QUERY);
    const ranked = rankRows(plan, verifySet(plan, [{ pool: 'p1', tracks: JUNK }]).rows);
    return ranked.findIndex((r) => r.title === title);
  };
  test('the title-matching row outranks O\'Meri Laila', () => {
    expect(at('Tu Chahiye')).toBeGreaterThanOrEqual(0);
    expect(at('Tu Chahiye')).toBeLessThan(at("O'Meri Laila"));
  });
  test('the title-matching row outranks "Kon Mayate" (Atif Aslam BD junk)', () => {
    expect(at('Tu Chahiye')).toBeLessThan(at('Kon Mayate'));
  });
  test('no artist-only row carries "Best match for your search"', () => {
    const plan = planSearch(THE_QUERY);
    const ranked = rankRows(plan, verifySet(plan, [{ pool: 'p1', tracks: JUNK }]).rows);
    for (const r of ranked) {
      if (r.reasonCode === 'MATCHES_SEARCH') {
        expect(r.artistMatch >= 1 && r.queryMatch >= 0.5).toBe(true);
      }
    }
  });
  test('entity_artist kind still resolves (artist searches never zero out)', () => {
    const p2 = planSearch('atif aslam');
    expect(p2.kind).toBe('entity_artist');
    const v2 = verifySet(p2, [{ pool: 'p1', tracks: JUNK }]);
    const r2 = rankRows(p2, v2.rows);
    // artist-credit rows float: O'Meri Laila (Atif Aslam) is top
    expect(r2[0].artistMatch).toBeGreaterThanOrEqual(1);
  });
});

describe('SIG gate — sigUnmet + rescue verification (M3/M4 contract)', () => {
  test('the junk pool is SIG-UNMET (no row matches both axes)', () => {
    const plan = planSearch(THE_QUERY);
    const verified = verifySet(plan, [{ pool: 'p1', tracks: JUNK }]);
    const ranked = rankRows(plan, verified.rows);
    expect(sigUnmet(plan, ranked)).toBe(true);
  });
  test('a pool containing a both-axes row is SIG-MET', () => {
    const withTarget = [
      ...JUNK,
      track({ id: 'ok1', title: 'Tu Chahiye (From "Bajrangi Bhaijaan")', artist: 'Atif Aslam', artistsFull: ['Atif Aslam'] }),
    ];
    const plan = planSearch(THE_QUERY);
    const verified = verifySet(plan, [{ pool: 'p1', tracks: withTarget }]);
    const ranked = rankRows(plan, verified.rows);
    expect(sigUnmet(plan, ranked)).toBe(false);
  });
  test('verifyRescueRow accepts the real target and rejects junk', () => {
    const plan = planSearch(THE_QUERY);
    const good: Track = track({ id: 'yt-1', title: 'Tu Chahiye', artist: 'Pritam, Atif Aslam & Amitabh Bhattacharya', artistsFull: ['Pritam', 'Atif Aslam', 'Amitabh Bhattacharya'], source: 'youtube' });
    expect(verifyRescueRow(plan, good)).toBe(true);
    expect(verifyRescueRow(plan, JUNK[0])).toBe(false); // O'Meri Laila
    expect(verifyRescueRow(plan, JUNK[2])).toBe(false); // A.R. Dixit version
  });
  test('titleQueryTokens excludes connectors + type words', () => {
    const p2 = planSearch('tu chaiye of');
    expect(p2.connectorTokens).toEqual(['of']);
    expect(titleQueryTokens(p2)).toEqual(['tu', 'chaiye']);
  });
});
