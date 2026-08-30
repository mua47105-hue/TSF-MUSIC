/**
 * R5 WINDOWING LOCKS — pure adaptive-layout math.
 *
 * With the orientation lock removed (the tablet letterbox root fix),
 * the app can be laid out in ANY window: landscape phones, tablets,
 * split halves, DeX/desktop windows. These locks pin the two
 * calculations that used to assume "window = portrait phone":
 *
 *  - browseColumnsFor: Search "Browse all" grid columns by width
 *    (2 at phone widths, 4 at ≥720dp wide windows).
 *  - playerArtSize: player artwork edge by window box (full width at
 *    portrait phones, capped at 62% of window height otherwise, floored
 *    at 200dp so tiny split windows stay usable).
 */
import { describe, expect, test } from 'bun:test';
import { browseColumnsFor, playerArtSize } from '../../src/ui/windowing';

describe('R5 — browseColumnsFor', () => {
  test('phone portrait widths keep the historic 2 columns', () => {
    for (const w of [320, 360, 390, 412, 430, 480, 600, 719]) {
      expect(browseColumnsFor(w)).toBe(2);
    }
  });

  test('wide windows (landscape phones, tablets, desktop) get 4 columns', () => {
    for (const w of [720, 736, 800, 834, 910, 960, 1280, 1600]) {
      expect(browseColumnsFor(w)).toBe(4);
    }
  });

  test('the boundary is exactly 720 (first wide bucket)', () => {
    expect(browseColumnsFor(719.99)).toBe(2);
    expect(browseColumnsFor(720)).toBe(4);
  });

  test('degenerate inputs fall back to 2, never throw', () => {
    expect(browseColumnsFor(NaN)).toBe(2);
    expect(browseColumnsFor(0)).toBe(2);
    expect(browseColumnsFor(-400)).toBe(2);
    // @ts-expect-error runtime abuse guard
    expect(browseColumnsFor(undefined)).toBe(2);
  });
});

describe('R5 — playerArtSize', () => {
  test('portrait phones: unchanged historic look (width - 32)', () => {
    expect(playerArtSize(412, 915)).toBe(380);
    expect(playerArtSize(390, 844)).toBe(358);
    expect(playerArtSize(360, 800)).toBe(328);
  });

  test('portrait tablets: still width-driven (height cap not binding)', () => {
    expect(playerArtSize(600, 960)).toBe(568); // 0.62*960=595 > 568
    expect(playerArtSize(800, 1280)).toBe(768); // 0.62*1280=794 > 768
  });

  test('landscape windows: height cap binds (62% of height)', () => {
    expect(playerArtSize(960, 600)).toBe(372); // 0.62*600=372 < 928
    expect(playerArtSize(1280, 800)).toBe(496); // 0.62*800=496 < 1248
    expect(playerArtSize(915, 412)).toBe(255); // 0.62*412=255.4 < 883
  });

  test('never below the 200dp usability floor', () => {
    expect(playerArtSize(915, 300)).toBe(200); // 0.62*300=186 < 200
    expect(playerArtSize(1000, 240)).toBe(200);
  });

  test('degenerate inputs fall back to sane phone math, never throw', () => {
    expect(playerArtSize(NaN, 800)).toBe(Math.round(Math.min(400 - 32, 800 * 0.62)));
    // zeros are treated as "unknown", not as real dimensions: the helper
    // substitutes a sane 400x800 fallback window instead of a 0-size art.
    expect(playerArtSize(0, 0)).toBe(368);
    expect(playerArtSize(-50, -10)).toBe(368);
    // @ts-expect-error runtime abuse guard
    expect(playerArtSize(undefined, undefined)).toBe(368);
  });
});
