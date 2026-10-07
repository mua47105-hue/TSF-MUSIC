/**
 * MAGNUM OPUS WAVE 5 · F19 — GENRE EXPLORER LOCKS.
 *
 * The bar: genreMapLayout(genres, seed) is DETERMINISTIC (same genres +
 * same seed ⇒ the same map on every device, every run — law X4); radii
 * are the documented formula over the priors' energy (literal bands);
 * relaxation keeps bubbles apart; the pan/zoom transform is pure math;
 * the screen plays through the EXISTING searchSaavnClean surface (the
 * app's already-filterClean ladder) and adds ZERO image assets and
 * ZERO gesture dependencies (PanResponder is RN core).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { genreMapLayout, mulberry32, mapToScreen } from '../src/ai/genreExplorer';
import { GENRE_PRIORS } from '../src/ai/core/priors';
import { GENRE_EXPLORER } from '../src/ai/core/constants';

const KEYS = Object.keys(GENRE_PRIORS); // 26 genres

describe('F19 · genreMapLayout — determinism is the feature', () => {
  test('same genres + same seed ⇒ the identical map, bubble for bubble', () => {
    const a = genreMapLayout(null, 1994);
    const b = genreMapLayout(null, 1994);
    expect(a.size).toBe(26); // the literal taxonomy size
    for (const [genre, bubble] of a) {
      const twin = b.get(genre)!;
      expect(twin.x).toBe(bubble.x);
      expect(twin.y).toBe(bubble.y);
      expect(twin.radius).toBe(bubble.radius);
    }
  });

  test('a different seed MOVES the map (the seed is load-bearing, not decor)', () => {
    const a = genreMapLayout(null, 1994);
    const b = genreMapLayout(null, 777);
    const moved = KEYS.some((g) => a.get(g)!.x !== b.get(g)!.x || a.get(g)!.y !== b.get(g)!.y);
    expect(moved).toBeTrue();
  });

  test('an explicit genre subset places exactly those bubbles (unknown keys get the neutral prior)', () => {
    const map = genreMapLayout(['metal', 'not-a-genre'], 5);
    expect(map.size).toBe(2);
    expect(map.get('metal')!.radius).toBeCloseTo(48 + 52 * 0.9, 5); // 94.8 — the formula, literally
    expect(map.get('not-a-genre')!.radius).toBeCloseTo(48 + 52 * 0.5, 5); // 74 — the neutral fallback
    expect(map.get('not-a-genre')!.energy).toBe(0.5);
    expect(map.get('not-a-genre')!.valence).toBe(0.5);
  });
});

describe('F19 · the layout is sane physics', () => {
  test('every bubble sits fully inside the map space (radius-clamped at the walls)', () => {
    const map = genreMapLayout(null, 1994);
    for (const b of map.values()) {
      expect(b.x).toBeGreaterThanOrEqual(b.radius);
      expect(b.x).toBeLessThanOrEqual(GENRE_EXPLORER.space - b.radius);
      expect(b.y).toBeGreaterThanOrEqual(b.radius);
      expect(b.y).toBeLessThanOrEqual(GENRE_EXPLORER.space - b.radius);
    }
  });

  test('relaxation works: every pair of bubbles reaches positive clearance (measured, not intended)', () => {
    const map = genreMapLayout(null, 1994);
    const bubbles = [...map.values()];
    let worst = Infinity;
    for (let i = 0; i < bubbles.length; i++) {
      for (let j = i + 1; j < bubbles.length; j++) {
        const a = bubbles[i];
        const b = bubbles[j];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        worst = Math.min(worst, dist - (a.radius + b.radius));
      }
    }
    // at the shipped 48..100 band the 26-bubble map packs at ~48% area —
    // measured worst pair gap is +5 map units (positive = separated).
    // A negative number here means the relaxer died (or the band grew).
    expect(worst).toBeGreaterThan(0);
  });

  test('radii follow the energy prior: metal > bollywood > sleep (the literal bands)', () => {
    const map = genreMapLayout(null, 1994);
    const r = (g: string) => map.get(g)!.radius;
    expect(r('metal')).toBeCloseTo(94.8, 5); // 48 + 52 * 0.9
    expect(r('bollywood')).toBeCloseTo(76.6, 5); // 48 + 52 * 0.55
    expect(r('sleep')).toBeCloseTo(54.24, 5); // 48 + 52 * 0.12
    expect(r('metal')).toBeGreaterThan(r('bollywood'));
    expect(r('bollywood')).toBeGreaterThan(r('sleep'));
  });
});

describe('F19 · mulberry32 + the view transform (pure math)', () => {
  test('the PRNG is a literal, reproducible sequence (seed 1 → 0.62707…, 0.00273…, 0.52744…)', () => {
    const rand = mulberry32(1);
    expect(rand()).toBeCloseTo(0.6270739405881613, 15);
    expect(rand()).toBeCloseTo(0.002735721180215478, 15);
    expect(rand()).toBeCloseTo(0.5274470399599522, 15);
  });

  test('mapToScreen is the documented affine math (zoom, pan, viewport)', () => {
    const bubble = { x: 500, y: 400, radius: 95 };
    // scale = zoom * viewport/space = 1 * 340/1000 = 0.34
    const at = mapToScreen(bubble, 1, 0, 0, 340);
    expect(at.size).toBeCloseTo(95 * 2 * 0.34, 5); // 64.6
    expect(at.left).toBeCloseTo((500 - 95) * 0.34, 5); // 137.7
    expect(at.top).toBeCloseTo((400 - 95) * 0.34, 5); // 103.7
    // pan shifts by exactly pan; zoom scales by exactly zoom
    const zoomed = mapToScreen(bubble, 2, 10, -20, 340);
    expect(zoomed.size).toBeCloseTo(95 * 2 * 0.68, 5);
    expect(zoomed.left).toBeCloseTo((500 - 95) * 0.68 + 10, 5);
    expect(zoomed.top).toBeCloseTo((400 - 95) * 0.68 - 20, 5);
  });
});

describe('F19 · source laws (PanResponder, filterClean playback, zero assets, lazy door)', () => {
  test('the screen pans/zooms with RN-core PanResponder — NO gesture-handler, NO svg, NO reanimated IMPORTS', () => {
    const screen = readFileSync('src/screens/GenreExplorer.tsx', 'utf8');
    expect(screen).toMatch(/PanResponder/);
    // scope to import statements — the header comment explains WHY the
    // gesture libs are absent and must keep naming them honestly
    expect(screen).not.toMatch(/from '(react-native-gesture-handler|react-native-svg|react-native-reanimated)'/);
  });

  test('THE TAP IS WIRED (critic P0-1): release-classified tap → hit-test → playGenre', () => {
    const screen = readFileSync('src/screens/GenreExplorer.tsx', 'utf8');
    // the pan responder owns every touch, so the tap lives in the RELEASE
    expect(screen).toMatch(/onPanResponderRelease/);
    // the tap gate is the documented double threshold
    expect(screen).toMatch(/travel <= GENRE_EXPLORER\.tapSlopPx/);
    expect(screen).toMatch(/elapsed <= GENRE_EXPLORER\.tapMaxMs/);
    // the hit-test resolves through the ONE shared transform and plays
    expect(screen).toMatch(/mapToScreen\(b, zoomRef\.current/);
    // the LIVE call — a dead `if (false) void playGenre(…)` must fail here
    expect(screen).toMatch(/if \(best\) void playGenre\(best\.bubble\)/);
    // and the busy guard is a REF (a state read would be stale in the gesture closure)
    expect(screen).toMatch(/loadingRef\.current = true/);
  });

  test('THE PAN MATH IS THE DOCUMENTED ONE (critic P1-1): base + cumulative dx·damping', () => {
    const screen = readFileSync('src/screens/GenreExplorer.tsx', 'utf8');
    expect(screen).toMatch(/panBaseRef\.current = \{ \.\.\.panRef\.current \}/); // base captured at GRANT
    expect(screen).toMatch(/panBaseRef\.current\.x \+ g\.dx \* GENRE_EXPLORER\.panDamping/); // absolute, not per-event
    expect(screen).toMatch(/panClampPx/); // the map cannot be dragged out of view
  });

  test('THE ART PROBES AFTER PAINT (critic P1-2): useEffect + InteractionManager + per-run cache', () => {
    const screen = readFileSync('src/screens/GenreExplorer.tsx', 'utf8');
    expect(screen).toMatch(/InteractionManager\.runAfterInteractions/);
    expect(screen).toMatch(/const artCache = new Map/); // module-level, once per APP RUN
    expect(screen).toMatch(/cancelled = true/); // unmount-safe setState
    // the render body itself never starts the fetch (no render-body kick-off pattern)
    expect(screen).not.toMatch(/requested\.current = true/);
  });

  test('tap-a-bubble plays through searchSaavnClean (the app\'s filterClean ladder), honestly empty otherwise', () => {
    const screen = readFileSync('src/screens/GenreExplorer.tsx', 'utf8');
    expect(screen).toMatch(/searchSaavnClean\(/);
    expect(screen).toContain('NO ' ); // honest empty toast — `NO ${genre} ROWS…`
    expect(screen).toContain('testID={`genre-${b.genre}`}'); // every bubble is a lockable surface
  });

  test('zero image assets shipped for the map (<2MB impact bar)', () => {
    const screen = readFileSync('src/screens/GenreExplorer.tsx', 'utf8');
    expect(screen).not.toMatch(/require\('\.\.\/\.\.\/assets|\.png'|\.jpg'/);
  });

  test('the door is registered LAZY in App.tsx (bar X5 — the cold path gains the pointer, never the module)', () => {
    const app = readFileSync('App.tsx', 'utf8');
    expect(app).toMatch(/name="GenreExplorer"/);
    expect(app).toMatch(/getComponent=\{\(\) => require\('\.\/src\/screens\/GenreExplorer'\)\.GenreExplorer\}/);
    expect(app).not.toMatch(/import \{ GenreExplorer \} from '\.\/src\/screens\/GenreExplorer'/);
    const nav = readFileSync('src/screens/navigation.ts', 'utf8');
    expect(nav).toContain('GenreExplorer: undefined;');
    const library = readFileSync('src/screens/LibraryScreen.tsx', 'utf8');
    expect(library).toContain('testID="genre-map-btn"');
  });

  test('the constants bridge: the documented numbers are the behavior above', () => {
    const constants = readFileSync('src/ai/core/constants.ts', 'utf8');
    expect(constants).toMatch(/GENRE_EXPLORER = \{/);
    expect(constants).toMatch(/space: 1000/);
    expect(constants).toMatch(/viewport: 340/);
    expect(constants).toMatch(/mapSeed: 1994/);
    expect(constants).toMatch(/minZoom: 0\.6/);
    expect(constants).toMatch(/maxZoom: 3,/);
    expect(constants).toMatch(/panDamping: 0\.15/);
    expect(constants).toMatch(/panClampPx: 260/);
    expect(constants).toMatch(/tapSlopPx: 6/);
    expect(constants).toMatch(/tapMaxMs: 500/);
    expect(constants).toMatch(/minRadius: 48/);
    expect(constants).toMatch(/maxRadius: 100/);
    expect(constants).toMatch(/relaxPasses: 40/);
    expect(constants).toMatch(/relaxGap: 12/);
    expect(constants).toMatch(/rowsPerGenre: 16/);
    expect(constants).toMatch(/artMinSize: 44/);
    expect(constants).toMatch(/artProbeSeed: 7919/);
  });
});
