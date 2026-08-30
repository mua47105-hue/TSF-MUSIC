/**
 * W1 WINDOW-POLICY LOCKS (gauntlet R4).
 *
 * The bug being locked: v3.4.0 shipped `resizeableActivity="false"` +
 * `maxAspectRatio="2.4"` + legacy `android.max_aspect` — the textbook
 * trigger for OS compatibility letterboxing on Android 12L+/One UI
 * tablets (field-proven: two tablets rendered the app in a ~48%-height
 * window with the tab bar mid-screen).
 *
 * These locks prove the compiled manifest can never carry that policy:
 * if anyone reverts the plugin (or hand-edits the transform), the suite
 * fails before the APK can ship.
 */
import { describe, expect, test } from 'bun:test';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const plugin = require('../../plugins/withWindowPolicy');
const applyWindowPolicy = plugin.applyWindowPolicy as (m: any) => any;

function freshManifest(extraApplicationAttrs: Record<string, string> = {}) {
  return {
    manifest: {
      application: [
        {
          $: {
            'android:name': '.MainApplication',
            'android:label': 'TSF Music',
            ...extraApplicationAttrs,
          },
          'meta-data': [
            { $: { 'android:name': 'android.max_aspect', 'android:value': '2.4' } },
            { $: { 'android:name': 'expo.modules.updates.EXPO_UPDATE_URL', 'android:value': 'https://x' } },
          ],
        },
      ],
    },
  };
}

describe('W1 — window policy (v3.4.1)', () => {
  test('the plugin exports the app plugin function itself', () => {
    expect(typeof plugin).toBe('function');
  });

  test('resizeableActivity is explicitly TRUE — never false', () => {
    const m = applyWindowPolicy(freshManifest({ 'android:resizeableActivity': 'false' }));
    expect(m.manifest.application[0].$['android:resizeableActivity']).toBe('true');
  });

  test('a clean manifest also gets the explicit true (future-proof vs default flips)', () => {
    const m = applyWindowPolicy(freshManifest());
    expect(m.manifest.application[0].$['android:resizeableActivity']).toBe('true');
  });

  test('stale v3.4.0 maxAspectRatio attr is stripped', () => {
    const m = applyWindowPolicy(freshManifest({ 'android:maxAspectRatio': '2.4' }));
    expect(m.manifest.application[0].$['android:maxAspectRatio']).toBeUndefined();
  });

  test('stale legacy android.max_aspect meta-data is stripped; other meta-data survives', () => {
    const m = applyWindowPolicy(freshManifest());
    const names = m.manifest.application[0]['meta-data'].map(
      (x: any) => x.$['android:name'],
    );
    expect(names).not.toContain('android.max_aspect');
    expect(names).toContain('expo.modules.updates.EXPO_UPDATE_URL');
  });

  test('no aspect-ratio cap of ANY value survives the transform', () => {
    const m = applyWindowPolicy(
      freshManifest({ 'android:maxAspectRatio': '1.8' }),
    );
    expect(JSON.stringify(m)).not.toContain('maxAspectRatio');
    expect(JSON.stringify(m)).not.toContain('android.max_aspect');
  });

  test('missing application node is a no-op (never throws)', () => {
    const weird = { manifest: {} };
    expect(applyWindowPolicy(weird)).toBe(weird);
  });
});
