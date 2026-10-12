/**
 * v5.2.0 FIX 1 — THE REACT-NATIVE MOCK-SURFACE LOCKS (the P0 leak class).
 *
 * THE INCIDENT: bun's `mock.module` registry is PROCESS-GLOBAL. A test
 * file that registers a PARTIAL react-native mock poisons every LATER
 * file whose imports touch a key the partial factory never carried —
 * the victim dies at module scope (StyleSheet.create of undefined).
 * v5.0.2 closed this class for expo-network; the react-native mock
 * itself was still hand-rolled as a partial literal in 19 files. The
 * minimal pair (fix_b3_prewarm_locks.test.ts → any StyleSheet-using
 * module in a mock-less later file) reproduces the crash — recorded in
 * the v5.2.0 worklog; a module-graph crash cannot live inside a GREEN
 * suite, so the durable laws here are:
 *
 *  L1 UNION COMPLETENESS (live): every NAMED import this repo makes
 *     from 'react-native' (src/ + tests/ + App.tsx, scanned at run
 *     time) must exist as a key on the shared surface. A future
 *     `import { newAPI } from 'react-native'` without a surface key is
 *     a RED here — not a crashed suite next week.
 *  L2 SPREAD DISCIPLINE: every `mock.module('react-native', ...)`
 *     registration routes through rnMockSurface(...) — no file may
 *     regress to a bare partial literal factory.
 *  L3 THE INCIDENT REGRESSION: under the shared surface, the exact
 *     modules of the crash report (Artwork → ParallaxArtwork, whose
 *     module scope calls StyleSheet.create) evaluate fully.
 *  L4 HELPER PURITY: the surface factory must not import the very
 *     module it stands in for.
 *  L5 CORE-KEY STABILITY: the load-bearing keys (StyleSheet, Platform,
 *     AppState, AccessibilityInfo, Animated, Image, View, Text) stay
 *     on the surface.
 *
 * Mutations proven RED (v5.2.0 worklog):
 *  M-F1-1  one file reverted to the bare partial factory → L2 fails
 *          (and the pair-probe leak demonstrably returns);
 *  M-F1-2  StyleSheet dropped from the surface → L1 and L3 fail.
 */

import { describe, expect, test, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

import { RN_SURFACE_KEYS, rnMockSurface } from './helpers/rnMockSurface';

// ── the lock file rides the SAME surface it locks (no overrides — the
//    full default is the point), plus the two companion mocks the
//    import chain of L3 needs (async-storage via storage/store,
//    vector-icons via Artwork). ─────────────────────────────────────────
mock.module('react-native', () => rnMockSurface());
mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
    multiRemove: async () => undefined,
    multiGet: async () => [] as [string, string][],
  },
}));
mock.module('@expo/vector-icons', () => ({ Ionicons: () => null }));

/** Every NAMED (runtime) import from 'react-native' across the repo, live.
 *  Comment-stripped first (doc examples must never fake a key); the name
 *  list excludes `;{}` so a match can never cross statement boundaries;
 *  type-only statements/items are skipped (they are erased at runtime —
 *  they need no mock key). */
function repoNamedRnImports(): string[] {
  const files = execSync(
    `grep -rEl "from 'react-native'" src tests App.tsx --include='*.ts' --include='*.tsx'`,
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter(Boolean);
  const named = new Set<string>();
  const re = /import\s+(type\s+)?\{([^;{}]*?)\}\s*from\s*'react-native'/g;
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    for (const m of src.matchAll(re)) {
      if (m[1]) continue; // whole-statement type import — erased at runtime
      for (const raw of m[2].split(',')) {
        const k = raw.trim();
        if (k && !k.startsWith('type ')) named.add(k);
      }
    }
  }
  return [...named].sort();
}

describe('v5.2.0 FIX 1 · L1 — the surface covers every named RN import (live union)', () => {
  test('the repo-wide union of named react-native imports resolves on the surface', () => {
    const surface = rnMockSurface();
    const named = repoNamedRnImports();
    expect(named.length).toBeGreaterThan(10); // the scan actually saw the repo
    const missing = named.filter((k) => !(k in surface));
    expect(missing).toEqual([]); // THE law — a missing key is the leak class
  });

  test('the scan finds the known hot keys (the scan is not silently broken)', () => {
    const named = new Set(repoNamedRnImports());
    for (const k of ['View', 'StyleSheet', 'Text', 'Animated', 'Platform', 'AppState', 'AccessibilityInfo']) {
      expect(named.has(k)).toBeTrue();
    }
  });
});

describe('v5.2.0 FIX 1 · L2 — every registration routes through the surface factory', () => {
  test('all react-native mock registrations use rnMockSurface (no bare partial factories)', () => {
    const files = execSync(
      `grep -rl "mock.module('react-native'" tests --include='*.test.ts'`,
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(files.length).toBeGreaterThanOrEqual(19); // 19 at fix time; more must comply, not fewer
    const bare = files.filter((f) =>
      /mock\.module\('react-native',\s*\(\)\s*=>\s*\(\{/.test(readFileSync(f, 'utf8')),
    );
    expect(bare).toEqual([]); // the pre-fix shape is extinct
    const nonCompliant = files.filter((f) => !readFileSync(f, 'utf8').includes('rnMockSurface('));
    expect(nonCompliant).toEqual([]); // every carrier rides the factory
  });
});

describe('v5.2.0 FIX 1 · L3 — the incident regression: the crash modules evaluate', () => {
  test('Artwork + ParallaxArtwork (module-scope StyleSheet.create) load under the surface', async () => {
    const artwork = await import('../src/components/Artwork');
    expect(artwork.Artwork).toBeTruthy();
    const parallax = await import('../src/components/ParallaxArtwork');
    expect(typeof parallax.parallaxMode).toBe('function');
    expect(typeof parallax.parallaxOffset).toBe('function');
    expect(typeof parallax.ParallaxArtwork).toBe('object'); // React.memo
  });
});

describe('v5.2.0 FIX 1 · L4/L5 — the helper is honest and load-bearing', () => {
  test('the surface factory never imports the module it mocks (L4)', () => {
    // strip comments first — the doc header NAMES the law, it must not
    // trip it (the L1 lesson: comments are not code).
    const helper = readFileSync('tests/helpers/rnMockSurface.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(helper).not.toMatch(/from\s+'react-native'/);
    expect(helper).not.toMatch(/require\('react-native'\)/);
  });

  test('the core keys stay on the surface, pinned (L5)', () => {
    for (const k of ['StyleSheet', 'Platform', 'AppState', 'AccessibilityInfo', 'Animated', 'Image', 'View', 'Text', 'NativeModules']) {
      expect(RN_SURFACE_KEYS).toContain(k);
    }
  });
});
