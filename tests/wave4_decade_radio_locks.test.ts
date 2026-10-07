/**
 * MAGNUM OPUS WAVE 4 · F16 — DECADE RADIO LOCKS.
 *
 * The bar: the query ladder is DETERMINISTIC (same year in, same rungs
 * out — literals); the clamps hold; year filtering keeps rows with no
 * metadata honestly and rejects rows from other decades; the kill
 * switch gates the facade; a thin year is declared thin (the UI says
 * so, it does not pad).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { decadeQuery, inDecade } from '../src/ai/decadeRadio';
import { DECADE_RADIO } from '../src/ai/core/constants';

describe('F16 · decadeQuery — the deterministic ladder', () => {
  test('1994 → "1994 hits" / "90s hits" / "90s bollywood" (literals)', () => {
    const q = decadeQuery(1994);
    expect(q.exact).toBe('1994 hits');
    expect(q.decade).toBe('90s hits');
    expect(q.genre).toBe('90s bollywood');
    expect(q.decadeStart).toBe(1990);
  });
  test('2004 → the 00s rungs; 1985 → the 80s rungs (literals)', () => {
    expect(decadeQuery(2004)).toMatchObject({ exact: '2004 hits', decade: '00s hits', genre: '00s bollywood', decadeStart: 2000 });
    expect(decadeQuery(1985)).toMatchObject({ exact: '1985 hits', decade: '80s hits', genre: '80s bollywood', decadeStart: 1980 });
  });
  test('determinism: same year → byte-identical ladder, twice (X4)', () => {
    expect(JSON.stringify(decadeQuery(1972))).toBe(JSON.stringify(decadeQuery(1972)));
  });
  test('clamps: a pre-history year and a far-future year stay radio-able', () => {
    expect(decadeQuery(1800).exact).toBe(`${DECADE_RADIO.minYear} hits`);
    expect(decadeQuery(9999).exact).toBe(`${DECADE_RADIO.maxYear} hits`);
    expect(DECADE_RADIO.minYear).toBe(1950);
    expect(DECADE_RADIO.maxYear).toBe(2077);
  });
});

describe('F16 · inDecade — honest year filtering', () => {
  test('a row WITH a year must sit in the decade; a row WITHOUT one stays', () => {
    expect(inDecade({ year: 1994 }, 1990)).toBeTrue();
    expect(inDecade({ year: 1999 }, 1990)).toBeTrue();
    expect(inDecade({ year: 1985 }, 1990)).toBeFalse(); // a different decade is a lie
    expect(inDecade({}, 1990)).toBeTrue(); // no metadata → keep, honestly
    expect(inDecade({ year: 0 }, 1990)).toBeTrue(); // the mapper's "no year" value
  });
});

describe('F16 · source laws (facade + honesty)', () => {
  test('the kill switch gates the facade; reconcile + filterClean at the merge', () => {
    const src = readFileSync('src/ai/mindbeat.ts', 'utf8');
    const m = src.match(/async decadeRadio\([\s\S]*?\n  \}/);
    expect(m).toBeTruthy();
    expect(m![0]).toContain('if (this.disabled) return');
    expect(m![0]).toContain('filterClean(reconcileRecordings(rows))');
    expect(m![0]).toContain('inDecade(t, ladder.decadeStart)');
  });
  test('a thin year is declared thin (the UI says so, never pads)', () => {
    expect(DECADE_RADIO.thinCount).toBe(5);
    const stats = readFileSync('src/screens/StatsScreen.tsx', 'utf8');
    expect(stats).toContain('decade-radio-btn'); // the wiring evidence
    expect(stats).toContain('THIN CATALOG');
  });
});
