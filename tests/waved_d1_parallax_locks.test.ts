/**
 * WAVE D · D1 — the ParallaxArtwork locks.
 *
 * Evidence classes:
 *
 *  1. THE BAR as pure literals: the drift is clamp(scrollY × 0.15,
 *     −20, +20) — a 100px scroll drifts 15, the cap holds at ±20 from
 *     ±(20/0.15) ≈ 133.3px onward, zero at rest, symmetric on the
 *     bounce. No recomputed expectations: the numbers ARE the bar.
 *
 *  2. THE GATES as pure literals: Reduce Motion disables parallax (X5),
 *     Data Saver disables parallax (X6), an invisible row runs no
 *     parallax (viewability) — and each gate alone is sufficient.
 *
 *  3. THE 60fps MECHANISM (X4) as source laws: the screens drive the
 *     shared value with Animated.event(..., { useNativeDriver: true })
 *     at scrollEventThrottle 16; the component builds a NATIVE clamped
 *     interpolation (no Animated.clamp node exists on this RN — the
 *     clamped interpolation is the native-driver-safe equivalent); no
 *     JS frame loop anywhere in the feature (no setInterval /
 *     requestAnimationFrame / Math.random — the PseudoVisualizer law).
 *
 *  4. THE WIRING: the Home feed FlatList drives the shared value (feed
 *     shelf rows per-row viewability; the header shelves ride the
 *     'fh-0' first-feed-row proxy — ListHeaderComponent emits no view
 *     tokens, RN tracks data rows only); the Library grid cells ride
 *     the crates FlatList; ShelfCard renders ParallaxArtwork only when
 *     handed a scroll value — every other consumer stays bit-identical
 *     plain Artwork (zero regression, X2).
 *
 * Mutations proven RED (worklog):
 *  M-D1-1  useNativeDriver: true → false in a screen → the source laws
 *          fail (the 60fps mechanism is gone);
 *  M-D1-2  the Reduce Motion branch removed from ParallaxArtwork → the
 *          accessibility law fails (X5);
 *  M-D1-3  viewabilityConfig removed from a screen → the visibility law
 *          fails (the D1 perf bar).
 */

import { describe, expect, test, mock } from 'bun:test';
import { rnMockSurface } from './helpers/rnMockSurface';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// ── module mocks (bun per-file registry; the waveb pattern) ────────────
mock.module('react-native', () => rnMockSurface({
  AccessibilityInfo: {
    isReduceMotionEnabled: async () => false,
    addEventListener: () => ({ remove: () => undefined }),
  },
  Animated: {},
  Image: () => null,
  StyleSheet: { create: (s: Record<string, unknown>) => s },
  Text: () => null,
  View: () => null,
  Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android },
}));
mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (_k: string) => null,
    setItem: async (_k: string, _v: string) => undefined,
    removeItem: async (_k: string) => undefined,
  },
}));
mock.module('@expo/vector-icons', () => ({ Ionicons: () => null }));

const { parallaxMode, parallaxOffset } = await import('../src/components/ParallaxArtwork');
const { PARALLAX } = await import('../src/ai/core/constants');

describe('WAVE D · D1 — the pure drift: parallaxOffset (THE BAR as literals)', () => {
  test('at rest the art sits exactly in its frame', () => {
    expect(parallaxOffset(0)).toBe(0);
  });

  test('a 100px scroll drifts 15 — the 0.15 slope, subtle not dizzying', () => {
    expect(parallaxOffset(100)).toBeCloseTo(15, 10);
    expect(parallaxOffset(10) - parallaxOffset(0)).toBeCloseTo(1.5, 10);
    expect(parallaxOffset(-100)).toBeCloseTo(-15, 10);
  });

  test('the ±20px cap holds — art never flies off its frame', () => {
    expect(parallaxOffset(1000)).toBe(20);
    expect(parallaxOffset(-1000)).toBe(-20);
    // the cap engages exactly at capPx/factor ≈ 133.33px of scroll
    expect(parallaxOffset(PARALLAX.capPx / PARALLAX.factor)).toBe(20);
    expect(parallaxOffset(-PARALLAX.capPx / PARALLAX.factor)).toBe(-20);
  });

  test('the drift is monotone in the scroll offset', () => {
    expect(parallaxOffset(50)).toBeLessThan(parallaxOffset(120));
    expect(parallaxOffset(120)).toBeLessThan(parallaxOffset(500));
    expect(parallaxOffset(-50)).toBeGreaterThan(parallaxOffset(-120));
  });
});

describe('WAVE D · D1 — the gates: parallaxMode (accessibility + data saver + viewability)', () => {
  test('a visible row with motion allowed and bytes un-saved runs parallax', () => {
    expect(parallaxMode(false, false, true)).toBeTrue();
  });

  test('Reduce Motion alone disables parallax (X5 — the §13 house law)', () => {
    expect(parallaxMode(true, false, true)).toBeFalse();
  });

  test('Data Saver alone disables parallax (X6 — the §11 house law)', () => {
    expect(parallaxMode(false, true, true)).toBeFalse();
  });

  test('an invisible row alone disables parallax (the viewability gate)', () => {
    expect(parallaxMode(false, false, false)).toBeFalse();
  });

  test('the gates compose — every closed gate is sufficient', () => {
    expect(parallaxMode(true, true, true)).toBeFalse();
    expect(parallaxMode(true, true, false)).toBeFalse();
    expect(parallaxMode(false, true, false)).toBeFalse();
    expect(parallaxMode(true, false, false)).toBeFalse();
  });
});

describe('WAVE D · D1 — the tuning numbers live in constants (no magic numbers)', () => {
  test('THE BAR literals: factor 0.15, cap ±20px, viewability 15%', () => {
    expect(PARALLAX.factor).toBe(0.15);
    expect(PARALLAX.capPx).toBe(20);
    expect(PARALLAX.itemVisiblePercentThreshold).toBe(15);
  });
});

describe('WAVE D · D1 — source laws: the 60fps mechanism (X4, by construction)', () => {
  const component = readFileSync('src/components/ParallaxArtwork.tsx', 'utf8');
  const home = readFileSync('src/screens/HomeScreen.tsx', 'utf8');
  const library = readFileSync('src/screens/LibraryScreen.tsx', 'utf8');

  test('the screens drive the shared value with Animated.event + useNativeDriver: true', () => {
    for (const src of [home, library]) {
      expect(src).toContain('Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }]');
      expect(src).toContain('useNativeDriver: true');
      expect(src).not.toMatch(/useNativeDriver: false/);
      expect(src).toContain('scrollEventThrottle={16}');
    }
  });

  test('the native-driver onScroll rides an Animated-WRAPPED list (the Android invariant)', () => {
    // v5.2.0 — the E2E lab found this one: a PLAIN FlatList carrying
    // Animated.event(..., { useNativeDriver: true }) throws a FATAL
    // Invariant Violation on Android at mount ("Components based on
    // VirtualizedList must be wrapped with Animated.createAnimatedComponent
    // to support native onScroll events with useNativeDriver") — while the
    // web build runs it happily, which is exactly why the bun suite and
    // the emulator lab diverged. The list must be the Animated preset.
    // Mutation M-D1-4: reverting to the plain <FlatList → this lock RED.
    for (const [src, name] of [[home, 'HomeScreen'], [library, 'LibraryScreen']] as const) {
      expect(src).toContain('<Animated.FlatList');
      expect(src).not.toMatch(/<FlatList[\s>]/);
    }
  });

  test('the component builds the NATIVE clamped interpolation (same numbers as parallaxOffset)', () => {
    expect(component).toContain('PARALLAX.capPx / PARALLAX.factor');
    expect(component).toContain('outputRange: [-PARALLAX.capPx, PARALLAX.capPx]');
    expect(component).toContain("extrapolate: 'clamp'");
  });

  test('no JS frame loop anywhere in the feature (zero JS frames per scroll event)', () => {
    for (const src of [component, home, library]) {
      expect(src).not.toMatch(/setInterval|requestAnimationFrame/);
      expect(src).not.toMatch(/Math\.random\s*\(/);
    }
  });

  test('the gap-free drift: the inner art is oversized by 2×cap and clipped', () => {
    expect(component).toContain('top: -PARALLAX.capPx');
    expect(component).toContain('left: -PARALLAX.capPx');
    expect(component).toContain('size + PARALLAX.capPx * 2');
    expect(component).toContain('transform: [{ translateY }]');
  });
});

describe('WAVE D · D1 — source laws: the gates are wired, not just declared', () => {
  const component = readFileSync('src/components/ParallaxArtwork.tsx', 'utf8');

  test('the Reduce Motion branch exists and is LIVE (X5 — the mutation target)', () => {
    expect(component).toMatch(/AccessibilityInfo\.isReduceMotionEnabled/);
    expect(component).toContain("'reduceMotionChanged'");
    expect(component).toContain('parallaxMode(reduceMotion, dataSaver, visible)');
  });

  test('the Data Saver gate is wired to the module flag, live (X6)', () => {
    expect(component).toContain('dataSaverActive');
    expect(component).toContain('subscribeDataSaver');
  });

  test('a closed gate renders the plain primitive (bit-identical fallback)', () => {
    expect(component).toContain('if (!translateY)');
    expect(component).toContain('<Artwork');
  });
});

describe('WAVE D · D1 — source laws: the wiring (shelf cards + grid cells)', () => {
  const home = readFileSync('src/screens/HomeScreen.tsx', 'utf8');
  const library = readFileSync('src/screens/LibraryScreen.tsx', 'utf8');
  const shelf = readFileSync('src/components/Shelf.tsx', 'utf8');

  test('HomeScreen: the feed FlatList carries viewability + drives the shelves', () => {
    expect(home).toContain('viewabilityConfig={viewabilityConfig}');
    expect(home).toContain('onViewableItemsChanged={onViewableItemsChanged}');
    expect(home).toContain('visibleRows.has(item.key)');
    // the header proxy — ListHeaderComponent emits no view tokens
    expect(home).toContain("'fh-0'");
    expect(home).toContain('setHeaderParallaxOn(t.isViewable)');
    expect(home).toContain('parallaxScrollY={scrollY}');
  });

  test('LibraryScreen: grid cells render ParallaxArtwork behind the viewability gate', () => {
    expect(library).toContain('viewabilityConfig={viewabilityConfig}');
    expect(library).toContain('onViewableItemsChanged={onViewableItemsChanged}');
    expect(library).toContain('<ParallaxArtwork');
    expect(library).toContain('visible={visibleRows.has(item.key)}');
    expect(library).toContain('scrollY={scrollY}');
  });

  test('ShelfCard: parallax ONLY when handed a scroll value — otherwise the plain primitive', () => {
    expect(shelf).toContain('parallaxScrollY ? (');
    expect(shelf).toContain('<ParallaxArtwork');
    expect(shelf).toContain('<Artwork uri={artwork}');
  });

  test('mount isolation: ParallaxArtwork is imported by exactly Shelf + LibraryScreen (zero regression elsewhere)', () => {
    // import EDGES, not name mentions: HomeScreen adopts the parallax
    // cover through ShelfCard's props and must never import the module.
    const hits = execSync(
      `grep -rEl "from '(\\./|\\.\\./components/)ParallaxArtwork'" src/ --include='*.tsx' --include='*.ts'`,
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .sort();
    expect(hits).toEqual(['src/components/Shelf.tsx', 'src/screens/LibraryScreen.tsx']);
  });
});
