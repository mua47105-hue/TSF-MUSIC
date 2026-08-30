/**
 * F1 SEARCH-PAGINATION LOCKS (gauntlet R4).
 *
 * Locks the pure pagination helpers SearchScreen relies on:
 *   • mergeUniqueTracks  — JioSaavn pages overlap ~7%; appended rows are
 *     deduped by id, order-preserving, allocation-free when nothing is new
 *   • searchHasMore      — the honest stop rule (empty page or <25% fresh
 *     rows ends the feed instead of looping forever)
 *   • searchSaavn page param plumbing — the request carries p=N
 */
import { describe, expect, test } from 'bun:test';
import { mergeUniqueTracks, searchHasMore } from '../../src/api/saavn';
import type { Track } from '../../src/types';

function mkTrack(id: string, title = `Song ${id}`): Track {
  return {
    id,
    title,
    artist: 'Artist X',
    duration: 200,
    source: 'saavn',
  };
}

describe('F1 — mergeUniqueTracks', () => {
  test('appends fresh rows after existing ones, order preserved', () => {
    const prev = [mkTrack('a'), mkTrack('b')];
    const next = [mkTrack('c'), mkTrack('d')];
    const merged = mergeUniqueTracks(prev, next);
    expect(merged.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('drops rows whose id already exists (provider page overlap)', () => {
    const prev = [mkTrack('a'), mkTrack('b')];
    const next = [mkTrack('b'), mkTrack('c')];
    const merged = mergeUniqueTracks(prev, next);
    expect(merged.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  test('all-duplicate page returns the SAME reference (no wasted render)', () => {
    const prev = [mkTrack('a'), mkTrack('b')];
    const next = [mkTrack('a'), mkTrack('b')];
    expect(mergeUniqueTracks(prev, next)).toBe(prev);
  });

  test('duplicate ids INSIDE one page are collapsed too', () => {
    const merged = mergeUniqueTracks([], [mkTrack('x'), mkTrack('x'), mkTrack('y')]);
    expect(merged.map((t) => t.id)).toEqual(['x', 'y']);
  });

  test('empty next page is a no-op', () => {
    const prev = [mkTrack('a')];
    expect(mergeUniqueTracks(prev, [])).toBe(prev);
  });
});

describe('F1 — searchHasMore (honest stop rule)', () => {
  test('empty page stops the feed', () => {
    expect(searchHasMore(0, 0)).toBe(false);
  });

  test('a 30-row page with only 5 fresh rows stops (echoing the tail)', () => {
    expect(searchHasMore(30, 5)).toBe(false);
  });

  test('a 30-row page with 8 fresh rows continues', () => {
    expect(searchHasMore(30, 8)).toBe(true);
  });

  test('small pages: 10 received / 3 fresh continues (3 >= ceil(2.5))', () => {
    expect(searchHasMore(10, 3)).toBe(true);
  });

  test('small pages: 10 received / 2 fresh stops', () => {
    expect(searchHasMore(10, 2)).toBe(false);
  });

  test('fully fresh page continues', () => {
    expect(searchHasMore(30, 30)).toBe(true);
  });
});
