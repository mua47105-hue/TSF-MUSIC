/**
 * WAVE A · A3 — the screen-splitting locks.
 *
 * THE BAR: App.tsx wraps EXACTLY the eight named screens in React.lazy
 * (each behind its own Suspense + ScreenSkeleton boundary) and keeps the
 * four boot-critical screens EAGER. Zero testID breakage: every screen
 * keeps its navigation name, and the boot file's synchronous shape is
 * untouched (X5 — perfMark('js-boot') still opens the module, no new
 * sync work on the boot path).
 *
 * Mutations proven RED (worklog):
 *  M-A3-1  StatsScreen reverted to an eager static import → the lazy
 *          bar AND the eager-absence bar both fail;
 *  M-A3-2  the Suspense fallback stripped (null) → the boundary bar
 *          fails.
 */

import { describe, expect, test } from 'bun:test';

const fs = require('fs');
const app = fs.readFileSync('App.tsx', 'utf8');
const skeleton = fs.readFileSync('src/components/ScreenSkeleton.tsx', 'utf8');
const appJson = JSON.parse(fs.readFileSync('app.json', 'utf8'));

const LAZY_SCREENS = [
  'StatsScreen',
  'TasteScreen',
  'GenreExplorer',
  'MindbeatWireScreen',
  'CollectionScreen',
  'PlaylistScreen',
  'PremiumScreen',
  'AIScreen',
] as const;

const EAGER_SCREENS = ['HomeScreen', 'SearchScreen', 'LibraryScreen', 'PlayerScreen'] as const;

describe('WAVE A · A3 — the eight named screens are React.lazy', () => {
  for (const name of LAZY_SCREENS) {
    test(`${name} rides lazy(() => import(...))`, () => {
      expect(app).toMatch(
        new RegExp(`const ${name} = lazy\\(\\(\\) => import\\('./src/screens/${name}'\\)`),
      );
    });

    test(`${name} has NO eager static import left`, () => {
      expect(app).not.toMatch(new RegExp(`import \\{ ${name} \\} from './src/screens/${name}'`));
    });

    test(`${name} mounts behind its own Suspense + ScreenSkeleton`, () => {
      const at = app.indexOf(`<${name} />`);
      expect(at).toBeGreaterThan(-1);
      const slot = app.slice(at - 200, at);
      expect(slot).toContain('<Suspense fallback={<ScreenSkeleton />}>');
    });
  }
});

describe('WAVE A · A3 — the boot-critical four stay EAGER', () => {
  for (const name of EAGER_SCREENS) {
    test(`${name} keeps its static import and its component= wiring`, () => {
      expect(app).toContain(`import { ${name} } from './src/screens/${name}'`);
      expect(app).not.toMatch(new RegExp(`lazy\\(\\(\\) => import\\('./src/screens/${name}'\\)`));
    });
  }

  test('all twelve screens remain registered (zero reachability loss)', () => {
    for (const name of LAZY_SCREENS) {
      expect(app).toContain(`<${name} />`);
    }
    for (const name of EAGER_SCREENS) {
      expect(app).toContain(`component={${name}}`);
    }
    for (const navName of [
      'name="Home"',
      'name="Search"',
      'name="Library"',
      'name="Wire"',
      'name="Collection"',
      'name="Playlist"',
      'name="Stats"',
      'name="Taste"',
      'name="AI"',
      'name="Premium"',
      'name="GenreExplorer"',
      'name="Player"',
    ]) {
      expect(app).toContain(navName);
    }
  });
});

describe('WAVE A · A3 — the fallback is honest and the split is real', () => {
  test('ScreenSkeleton: deterministic shimmer (Animated loop, NO Math.random), no fake content', () => {
    expect(skeleton).toContain('Animated.loop');
    expect(skeleton).not.toMatch(/Math\.random\s*\(/); // no call form — the doc comment may SAY "no Math.random"
    expect(skeleton).toContain('testID="lazy-screen-skeleton"');
    expect(skeleton).not.toMatch(/<Text/); // a skeleton that fakes rows is a lie with a fade
  });

  test('the split is DECLARED (asyncRoutes + extra.router.ln) — measured reality on RN 0.76 native: ONE monolithic chunk', () => {
    // THE HONEST NOTE (anti-hallucination law): the mission's ≥30%
    // initial-chunk drop is UNMEETABLE on this toolchain and this lock
    // refuses to pretend otherwise. Measured three ways via
    // `expo export --platform android` (byte-exact):
    //   baseline (pre-A3):            12,244,282 B  AppEntry-9b084768…hbc
    //   after A3:                     12,248,527 B  AppEntry-ec2f5cea…hbc
    //   after A3 + extra.router.ln:   12,248,526 B  AppEntry-ec2f5cea…hbc (identical hash)
    // RN 0.76 native loads exactly one .hbc; @expo/cli SDK 52 only
    // splits for the WEB runtime (@expo/metro-runtime fetch+eval —
    // metroOptions.ts: shouldEnableAsyncImports). The lazy wiring is
    // still shipped because it is correct and future-proof: the day a
    // splitting-capable pipeline lands (expo-router migration / RN
    // multi-bundle), the eight screens are ALREADY deferred — and the
    // getComponent-require dance is retired.
    expect(appJson.expo?.experiments?.asyncRoutes).toBe(true);
    expect(appJson.expo?.extra?.router?.ln).toBe(true);
  });

  test('X5 — the boot path stays synchronous-shaped: perfMark(js-boot) still opens the module, no boot-time async chains', () => {
    const boot = app.slice(0, app.indexOf('export default function App()'));
    expect(boot).toContain("perfMark('js-boot')");
    expect(boot).not.toContain('await '); // no top-level await sneaked in
    // .then( is allowed ONLY inside the lazy factories (never executed at
    // boot — the import() is deferred to first navigation):
    const outsideLazy = boot
      .split('\n')
      .filter((l) => !l.includes('= lazy('))
      .join('\n');
    expect(outsideLazy).not.toContain('.then(');
    expect(outsideLazy).not.toContain('require('); // the old getComponent require is gone too
  });
});
