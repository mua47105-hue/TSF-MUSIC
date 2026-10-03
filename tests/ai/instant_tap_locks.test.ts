/**
 * INSTANT TAP LOCKS (Task 29 · godmode wave 2):
 *
 *   1. miniDisplay — real playback always wins; the optimistic plant
 *      only shows while nothing real is active; nothing to show → null.
 *   2. isDoubleTap — the 320ms window: inside counts, outside doesn't,
 *      cold start (lastAt=0) never counts, clock skew (now<lastAt)
 *      never counts.
 */

import { describe, expect, test } from 'bun:test';
import { isDoubleTap, miniDisplay } from '../../src/player/miniModel';
import type { Track } from '../../src/types';

const row = (id: string): Track =>
  ({ id, title: `T-${id}`, artist: 'A' }) as unknown as Track;

describe('instant tap · miniDisplay', () => {
  test('real playback wins over the plant (tuning=false)', () => {
    const d = miniDisplay(row('real'), row('planted'));
    expect(d.shown?.id).toBe('real');
    expect(d.tuning).toBe(false);
  });

  test('plant shows only while nothing real is active (tuning=true)', () => {
    const d = miniDisplay(null, row('planted'));
    expect(d.shown?.id).toBe('planted');
    expect(d.tuning).toBe(true);
  });

  test('nothing anywhere → hidden', () => {
    expect(miniDisplay(null, null).shown).toBeNull();
    expect(miniDisplay(null, null).tuning).toBe(false);
  });

  test('active alone (the normal case) is untouched', () => {
    const d = miniDisplay(row('real'), null);
    expect(d.shown?.id).toBe('real');
    expect(d.tuning).toBe(false);
  });
});

describe('instant tap · isDoubleTap', () => {
  test('inside the 320ms window counts', () => {
    expect(isDoubleTap(1000, 800)).toBe(true); // 200ms gap
    expect(isDoubleTap(1000, 680)).toBe(true); // exactly 320ms
  });
  test('outside the window does not count', () => {
    expect(isDoubleTap(1000, 679)).toBe(false); // 321ms gap
    expect(isDoubleTap(1000, 100)).toBe(false);
  });
  test('cold start / clock skew never counts', () => {
    expect(isDoubleTap(1000, 0)).toBe(false); // no previous tap
    expect(isDoubleTap(500, 800)).toBe(false); // now before lastAt
  });
});
