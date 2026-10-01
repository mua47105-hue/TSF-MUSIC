/**
 * INPUT STABILITY LOCKS — v4.0.1 (the "hihiz" fix + artist-photo fix).
 *
 *   BUG 1 (user-reported): typing `hi` then `z` into the search field
 *   produced `hihiz`. Root cause: fully-controlled TextInputs
 *   (`value={state}`) race their own value prop when the JS thread is
 *   busy (search debounce + autocomplete + result-list re-renders) — a
 *   stale render commits old text back into the field between
 *   keystrokes. Fix: src/hooks/useStableField.ts — the field is
 *   UNCONTROLLED while typing (native text = source of truth), state is
 *   a throttled commit, and programmatic writes (chips/clear) go through
 *   setValue() which writes the native text directly.
 *
 *   BUG 2 (user-reported): selecting an artist often showed NO photo —
 *   the collection page's hero preferred the FIRST SONG's album cover
 *   (an unrelated image) or a blank hatch, and never looked the artist
 *   photo up. Fix: kind 'artist' routes resolve the real photo via
 *   lookupArtistPhoto and wear an initials stamp only when the provider
 *   genuinely has none (live probe: ~35% of JioSaavn artists are
 *   photo-less — the initials stamp is the honest terminal state, same
 *   as Spotify's artist placeholder).
 *
 * The locks below are structural: they pin the FIX in place and forbid
 * the buggy pattern from returning on any typing surface.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const SRC = (p: string) => readFileSync(join(ROOT, 'src', p), 'utf8');

describe('v4.0.1 — useStableField primitive', () => {
  const hook = SRC('hooks/useStableField.ts');

  test('the primitive exists and is uncontrolled by design', () => {
    expect(hook).toContain('export function useStableField');
    // the doc block names the exact bug it kills
    expect(hook).toContain('hihiz');
    // native text is the truth; no value prop is ever returned to a field
    expect(hook).toContain('getValue');
  });

  test('programmatic writes cover every platform', () => {
    // native (legacy arch): direct text write, no re-render, no race
    expect(hook).toContain('setNativeProps');
    // web: the ref IS the host <input> node
    expect(hook).toContain('value');
    // '' goes through the official clear() on both platforms
    expect(hook).toContain('clear');
  });

  test('typing commits are throttled, programmatic writes are instant', () => {
    expect(hook).toContain('commitMs');
    // setValue flushes synchronously (chip presses search immediately)
    expect(hook).toContain('flush()'); // inside setValue
  });
});

describe('v4.0.1 — SearchScreen no longer races its field', () => {
  const search = SRC('screens/SearchScreen.tsx');

  test('the main search field is uncontrolled (no value={query})', () => {
    expect(search).toContain('useStableField');
    expect(search).not.toContain('value={query}');
    expect(search).toContain('ref={field.inputRef}');
    expect(search).toContain('onChangeText={field.handleChange}');
  });

  test('submit + pagination read the FRESH field text', () => {
    expect(search).toContain('runSearch(field.getValue())');
    expect(search).toContain('field.getValue().trim()');
  });

  test('chips / did-you-mean / clear write through setValue', () => {
    expect(search).toContain("field.setValue('')");
    expect(search).toContain('field.setValue(s)');
    expect(search).toContain('field.setValue(c.to)');
  });
});

describe('v4.0.1 — the whole typing surface is race-free', () => {
  test('Onboarding artist search is uncontrolled', () => {
    const onb = SRC('components/Onboarding.tsx');
    expect(onb).toContain('useStableField');
    expect(onb).not.toContain('value={query}');
    expect(onb).toContain('field.getValue().trim()');
  });

  test('MindbeatWire prompt is uncontrolled (AI-run re-render race)', () => {
    const wire = SRC('screens/MindbeatWireScreen.tsx');
    expect(wire).toContain('useStableField');
    expect(wire).not.toContain('value={prompt}');
    expect(wire).toContain('run(promptField.getValue())');
    // idea chips write the FIELD too — state-only writes leave the native
    // text stale and the next send reads the wrong prompt (critic round 1)
    expect(wire).toContain('promptField.setValue(idea)');
    expect(wire).not.toContain('setPrompt(idea)');
  });

  test('the source toggle reads the FRESH field text (critic round 1)', () => {
    const search = SRC('screens/SearchScreen.tsx');
    // no `runSearch(query.trim(), ...)` committed-state reads may remain —
    // the toggle must use field.getValue() like submit and pagination do.
    // (The positive assertion below is also satisfied by submit/pagination;
    // the negative pin is the toggle-specific part of this lock.)
    expect(search).not.toContain('runSearch(query.trim()');
    expect(search).toContain('field.getValue().trim()');
  });

  test('rename dialogs stay controlled DELIBERATELY (documented)', () => {
    // Library/TrackMenu rename boxes have near-zero per-keystroke
    // re-render load — the race is unobservable there and a controlled
    // reset-on-open is simpler. If one of them ever grows derivative
    // rendering, migrate it to useStableField.
    expect(SRC('screens/LibraryScreen.tsx')).toContain('value={newName}');
    expect(SRC('components/TrackMenu.tsx')).toContain('value={newName}');
  });
});

describe('v4.0.1 — artist pages carry the artist PHOTO', () => {
  const collection = SRC('screens/CollectionScreen.tsx');

  test('artist routes resolve the real photo by name', () => {
    expect(collection).toContain("lookupArtistPhoto(collection.title)");
    expect(collection).toContain("collection.kind === 'artist'");
  });

  test('the hero NEVER shows the first track\u2019s album art on artist pages', () => {
    // the ARTIST branch of the hero ternary must be route-artwork → resolved
    // photo — `tracks` may only appear in the NON-artist branch (albums and
    // charts legitimately fall back to their first cover)
    expect(collection).toContain('isArtist\n    ? collection.artwork || artistPhoto\n    : tracks?.[0]?.artwork || collection.artwork');
  });

  test('a photo-less artist wears an initials stamp (never a blank box)', () => {
    expect(collection).toContain('initials={isArtist ? collection.title : undefined}');
  });

  test('routes pass kind: artist instead of kind: search', () => {
    const home = SRC('screens/HomeScreen.tsx');
    expect(home).toContain("kind: 'artist'");
    // the because-you-listened card no longer borrows a song cover as the
    // artist page hero
    expect(home).not.toContain('?? seedTrack?.artwork');
  });

  test('artist tiles fall back to initials, not the generic glyph', () => {
    const shelf = SRC('components/Shelf.tsx');
    expect(shelf).toContain('initials={name}');
    const stats = SRC('screens/StatsScreen.tsx');
    expect(stats).toContain('initials={a.artist}');
  });

  test('critic round 1 — no borrowed album covers on ANY artist tile', () => {
    const home = SRC('screens/HomeScreen.tsx');
    // "On The Rise" cards: the song cover must never dress up as the artist
    // (ShelfCards wearing t.artwork are LEGITIMATE — those are song tiles)
    expect(home).toContain('artwork={railArt ?? riseArt[key]}');
    expect(home).not.toMatch(/ArtistCard[\s\S]{0,220}artwork=\{t\.artwork\}/);
    expect(home).toContain('riseArt');
    // stats rows resolve REAL photos via the artist pipeline
    const stats = SRC('screens/StatsScreen.tsx');
    expect(stats).toContain('lookupArtistPhoto');
    // the legacy stored artwork (first-played track cover) is dropped
    expect(stats).not.toContain('(a as { artwork?: string }).artwork');
  });

  test('critic round 1 — the hero can never wear a stranger\u2019s face', () => {
    const artists = SRC('api/artists.ts');
    // the `?? found[0]` fallback accepted ANY first search result; joined
    // credits ("A, B") now resolve against the primary name with an exact
    // normalized match only
    expect(artists).not.toContain('?? found[0]');
    expect(artists).toContain("name.split(',')[0]");
  });

  test('critic round 1 — initials are WORD initials (AS, not AR / "A,")', () => {
    const artwork = SRC('components/Artwork.tsx');
    expect(artwork).not.toContain('initials.slice(0, 2)');
    expect(artwork).toContain("split(/\\s+/)");
  });
});
