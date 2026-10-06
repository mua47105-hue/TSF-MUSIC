/**
 * BAR 3.8 LOCKS — session-aware search ranking (the vibe aligner).
 *
 *   1. PEAK boosts high baked-energy rows; WIND_DOWN boosts low-energy rows
 *   2. lyric_fragment plans NEVER get the bonus (the SIG lyric path is sacred)
 *   3. artist-zero rows can never ride the bonus past a title-matching row
 *      (the disambiguation caps still bind AFTER the bonus)
 *   4. without sessionVibe the ranking is byte-identical to before
 *   5. the existing "tu chaiye" rescue path (search_sig_e2e) stays green
 */

import { describe, expect, test } from 'bun:test';
import { rankRows } from '../../src/search/rank';
import { SEARCH_VIBE } from '../../src/ai/core/constants';
import type { SearchPlan } from '../../src/search/plan';
import type { Candidate } from '../../src/search/verify';

function plan(over: Partial<SearchPlan> = {}): SearchPlan {
  return {
    kind: 'browse',
    normalized: 'x',
    tokens: ['x'],
    titleTokens: ['x'],
    artistTokens: [],
    variants: [],
    ...over,
  } as unknown as SearchPlan;
}

function row(id: string, over: Partial<Candidate> = {}): Candidate {
  return {
    id,
    title: `Song ${id}`,
    artist: 'Artist',
    poolRank: 0,
    ...over,
  } as unknown as Candidate;
}

describe('BAR 3.8 — the vibe alignment bonus', () => {
  const peak = { targetEnergy: SEARCH_VIBE.targetEnergy.PEAK!, maxBonus: SEARCH_VIBE.maxBonus };

  test('PEAK: the high-energy row overtakes its low-energy twin', () => {
    const rows = [row('calm'), row('hype')];
    const ranked = rankRows(
      plan(),
      rows,
      {
        sessionVibe: peak,
        energyOf: (r) => (r.id === 'hype' ? 0.9 : 0.1),
      },
    );
    expect(ranked[0].id).toBe('hype');
    expect(ranked[0].score - ranked[1].score).toBeGreaterThan(0.3);
  });

  test('WIND_DOWN: the low-energy row wins', () => {
    const wind = { targetEnergy: SEARCH_VIBE.targetEnergy.WIND_DOWN!, maxBonus: SEARCH_VIBE.maxBonus };
    const ranked = rankRows(
      plan(),
      [row('calm'), row('hype')],
      { sessionVibe: wind, energyOf: (r) => (r.id === 'hype' ? 0.9 : 0.1) },
    );
    expect(ranked[0].id).toBe('calm');
  });

  test('the bonus never exceeds maxBonus (0.5) even for a perfect alignment', () => {
    const ranked = rankRows(plan(), [row('a')], {
      sessionVibe: peak,
      energyOf: () => peak.targetEnergy,
    });
    const bare = rankRows(plan(), [row('a')], {});
    expect(ranked[0].score - bare[0].score).toBeLessThanOrEqual(SEARCH_VIBE.maxBonus + 1e-9);
  });

  test('lyric_fragment plans NEVER get the bonus (the SIG lyric path is sacred)', () => {
    const lyric = plan({ kind: 'lyric_fragment', normalized: 'tu chaiye' });
    const rows = [row('calm'), row('hype')];
    const withVibe = rankRows(lyric, rows, {
      sessionVibe: peak,
      energyOf: (r) => (r.id === 'hype' ? 0.9 : 0.1),
    });
    const withoutVibe = rankRows(lyric, rows, {
      energyOf: (r) => (r.id === 'hype' ? 0.9 : 0.1),
    });
    // byte-identical scores: the lyric ranking is vibe-immune
    expect(withVibe.map((r) => [r.id, r.score])).toEqual(withoutVibe.map((r) => [r.id, r.score]));
  });

  test('without sessionVibe the ranking is byte-identical to the legacy path', () => {
    const rows = [row('a', { poolRank: 0 }), row('b', { poolRank: 1 }), row('c', { poolRank: 2 })];
    const legacy = rankRows(plan(), rows, {});
    const wired = rankRows(plan(), rows, { energyOf: () => 0.7 }); // energy present, vibe absent
    expect(wired.map((r) => [r.id, r.score])).toEqual(legacy.map((r) => [r.id, r.score]));
  });

  test('artist-zero rows can never ride the bonus past a title-matching row', () => {
    // artistTokens present: the plan names an artist. Both rows match the
    // title (qm 1.0) but only real-match matches the artist — the SIG
    // override caps bind AFTER the bonus and sink the artist-zero row.
    const named = plan({ artistTokens: ['real'], kind: 'artist_title', titleTokens: ['x'] });
    const titleRow = row('real-match', { title: 'Real x', artist: 'Real' });
    const artistZero = row('junk', { title: 'Junk x', artist: 'Other Band' });
    const ranked = rankRows(named, [titleRow, artistZero], {
      sessionVibe: peak,
      energyOf: (r) => (r.id === 'junk' ? 0.85 : 0.0), // junk gets the FULL bonus
    });
    // the override caps bind AFTER the bonus: the real match still tops
    expect(ranked[0].id).toBe('real-match');
  });
});
