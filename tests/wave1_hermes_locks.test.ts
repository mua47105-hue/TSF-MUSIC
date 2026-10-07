/**
 * MAGNUM OPUS WAVE 1 · F5 — HERMES/METRO COLD-START LOCKS.
 *
 * The bar (mission): real optimization flags in the build pipeline, the
 * full suite still green, zero runtime errors from the transform. These
 * locks pin the REAL levers (ground-truth verified):
 *   • metro.config.js transformer.getTransformOptions → inlineRequires
 *     true (Expo's default is FALSE — ExpoMetroConfig.js:322).
 *   • plugins/withHermesFlags.js pins hermesc flags on the prebuilt
 *     gradle — RN default ['-O','-output-source-map'] plus the verified
 *     '-fstrip-function-names'. The mission draft's '-emit-moving-average'
 *     does NOT exist in hermesc and must NEVER appear (anti-hallucination).
 *   • app.json registers the plugin so expo prebuild applies it in CI.
 * The device p50 verdict itself rides the emulator E2E lab (cold-start
 * marks) — a unit test cannot honestly measure a phone's cold start.
 */

import { describe, expect, test } from 'bun:test';

describe('F5 · metro config (inline requires)', () => {
  test('the exported metro config transforms with inlineRequires: true', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const metroConfig = await require('../metro.config.js');
    expect(typeof metroConfig.transformer.getTransformOptions).toBe('function');
    const opts = await metroConfig.transformer.getTransformOptions();
    expect(opts.transform.inlineRequires).toBe(true);
  });

  test('expo ships inlineRequires: false by default — our override is the point', () => {
    const { readFileSync } = require('node:fs');
    const expoDefaults = readFileSync(
      `${import.meta.dir}/../node_modules/@expo/metro-config/build/ExpoMetroConfig.js`,
      'utf8',
    );
    expect(expoDefaults).toContain('inlineRequires: false');
    const ours = readFileSync(`${import.meta.dir}/../metro.config.js`, 'utf8');
    expect(ours).toContain('inlineRequires: true');
  });
});

describe('F5 · withHermesFlags plugin (real flags only)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const plugin = require('../plugins/withHermesFlags');
  const applyHermesFlags = plugin.applyHermesFlags as (g: string) => string;
  const HERMES_FLAGS = plugin.HERMES_FLAGS as string[];

  test('flags are exactly the RN default + the verified strip flag', () => {
    expect(HERMES_FLAGS).toEqual(['-O', '-output-source-map', '-fstrip-function-names']);
  });

  test('the anti-hallucination pin: the fabricated flag never ships', () => {
    expect(HERMES_FLAGS).not.toContain('-emit-moving-average');
    expect(applyHermesFlags('react {\n}\n')).not.toContain('-emit-moving-average');
  });

  test('the block lands on a prebuilt gradle file with a react extension block', () => {
    const fixture = `
react {
    /* Folders */
    root = file("../../")
}
dependencies {
    implementation("com.facebook.react:react-native")
}
`;
    const out = applyHermesFlags(fixture);
    expect(out).toContain('hermesFlags = ["-O","-output-source-map","-fstrip-function-names"]');
    expect(out.lastIndexOf('react {')).toBeGreaterThan(fixture.indexOf('dependencies'));
    expect(out).toContain('tsf-hermes-flags');
  });

  test('idempotent: re-applying never duplicates the block', () => {
    const once = applyHermesFlags('dependencies {\n}\n');
    const twice = applyHermesFlags(once);
    expect(twice.split('tsf-hermes-flags').length - 1).toBe(1);
    expect(twice).toBe(once);
  });

  test('app.json registers the plugin (expo prebuild applies it in CI)', () => {
    const { readFileSync } = require('node:fs');
    const appJson = JSON.parse(
      readFileSync(`${import.meta.dir}/../app.json`, 'utf8'),
    );
    expect(appJson.expo.plugins).toContain('./plugins/withHermesFlags');
  });
});
