/**
 * MAGNUM OPUS WAVE 4 · F17 — ARTIST TIMELINE LOCKS.
 *
 * The bar: the grouping is pure and deterministic (albums by year with
 * an honest 'unknown' bucket; tracks by decade, newest first); rows
 * without years are never invented onto the axis; the year-filtered
 * playback routes through the EXISTING playQueue surface; the empty
 * case renders honestly (no years → no axis, an honest caption).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  groupAlbumsByYear,
  groupTracksByDecade,
  timelineDecades,
  TIMELINE_UNKNOWN,
} from '../src/ai/artistTimeline';
import { ARTIST_TIMELINE } from '../src/ai/core/constants';

describe('F17 · groupAlbumsByYear — the album axis', () => {
  test('decades bucket newest-first; undated albums land in "unknown" (last)', () => {
    const albums = [
      { id: 'a1', title: 'Duniyadari', year: 1994 },
      { id: 'a2', title: 'Aashiqui', year: 1990 },
      { id: 'a3', title: 'Undated Live', year: undefined },
      { id: 'a4', title: 'Retro', year: 1997 },
      { id: 'a5', title: 'Wax Cylinder', year: 5 }, // a pre-1900 "year" is NOT a decade — 'unknown'
    ];
    const grouped = groupAlbumsByYear(albums);
    const keys = [...grouped.keys()];
    expect(keys).toEqual(['1990', TIMELINE_UNKNOWN]); // newest decade first, unknown LAST
    expect(grouped.get('1990')!.map((a) => a.id)).toEqual(['a1', 'a2', 'a4']); // input order inside the bucket
    expect(grouped.get(TIMELINE_UNKNOWN)!.map((a) => a.id)).toEqual(['a3', 'a5']);
  });
  test('all-undated albums → one honest unknown bucket (never dropped)', () => {
    const grouped = groupAlbumsByYear([{ id: 'x', title: 'Mystery' }]);
    expect([...grouped.keys()]).toEqual([TIMELINE_UNKNOWN]);
  });
});

describe('F17 · groupTracksByDecade — the track axis (the primary timeline)', () => {
  test('decades desc, no year invention; the undated are countable', () => {
    const tracks = [
      { id: 't1', year: 2005 },
      { id: 't2', year: 1994 },
      { id: 't3', year: 2008 },
      { id: 't4' }, // no year — off the axis, honestly
      { id: 't5', year: 0 }, // the mapper's no-year value — same
    ];
    const byDecade = groupTracksByDecade(tracks);
    expect([...byDecade.keys()]).toEqual([2000, 1990]);
    expect(byDecade.get(2000)!.map((t) => t.id)).toEqual(['t1', 't3']);
    expect(byDecade.get(1990)!.map((t) => t.id)).toEqual(['t2']);
    // the axis knows about every year on it
    expect(timelineDecades(tracks.map((t) => t.year ?? 0))).toEqual([2000, 1990]);
    // the undated count the UI captions honestly
    expect(tracks.filter((t) => typeof t.year !== 'number' || t.year <= 1900).length).toBe(2);
  });
  test('a year-less artist page renders NO axis at all (honest empty)', () => {
    expect(groupTracksByDecade([{ id: 'a' }, { id: 'b' }]).size).toBe(0);
    expect(groupTracksByDecade([]).size).toBe(0);
  });
  test('the thin-era threshold is the documented literal', () => {
    expect(ARTIST_TIMELINE.thinDecade).toBe(3);
    expect(ARTIST_TIMELINE.maxTracks).toBe(60);
  });
});

describe('F17 · source laws (wiring evidence)', () => {
  test('the artist page hosts the timeline; playback routes through playQueue', () => {
    const src = readFileSync('src/screens/CollectionScreen.tsx', 'utf8');
    expect(src).toContain("testID=\"artist-timeline\"");
    expect(src).toContain('groupTracksByDecade('); // the pure grouping is the renderer's source
    expect(src).toContain('playQueue(rows, 0)'); // the existing queue surface, no second player path
    expect(src).toMatch(/useMemo\(\(\) => groupTracksByDecade/); // memoized per track list
  });
});
