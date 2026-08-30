/**
 * W1 WINDOW-POLICY LOCKS (gauntlet R5, v3.4.2).
 *
 * The full bug history being locked (three rounds of field evidence):
 *
 *  - v3.4.0 shipped `resizeableActivity="false"` + `maxAspectRatio="2.4"`
 *    + legacy `android.max_aspect` — a manufactured letterbox trigger
 *    (reverted in v3.4.1).
 *  - v3.4.1 (resizable, uncapped) STILL letterboxed on two Samsung
 *    tablets, and the One UI per-app "Full screen" aspect setting
 *    changed nothing → the trigger was never the aspect path.
 *  - v3.4.2 forensics (field screenshot = EXACTLY 50% window; decoded
 *    AXML manifest diff v3.3.0/v3.4.0/v3.4.1 identical apart from the
 *    v3.4.0 policy) isolated the constant since v1:
 *    `android:screenOrientation="portrait"` — per Google's
 *    device-compatibility-mode doc, portrait-restricted apps are
 *    letterboxed on large screens (mattes to one side, painted with the
 *    app's own windowBackground — the exact void in every field shot).
 *
 * These locks prove the compiled manifest can never carry ANY of the
 * three restriction families again: orientation lock, non-resizable,
 * aspect caps. If anyone reverts the plugin (or re-locks orientation in
 * app.json), the suite fails before the APK can ship.
 */
import { describe, expect, test } from 'bun:test';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const plugin = require('../../plugins/withWindowPolicy');
const applyWindowPolicy = plugin.applyWindowPolicy as (m: any) => any;

function freshManifest(opts: {
  applicationAttrs?: Record<string, string>;
  activities?: Array<Record<string, any>>;
  existingSupportsScreens?: Array<Record<string, any>>;
} = {}) {
  return {
    manifest: {
      'supports-screens': opts.existingSupportsScreens,
      application: [
        {
          $: {
            'android:name': '.MainApplication',
            'android:label': 'TSF Music',
            ...(opts.applicationAttrs ?? {}),
          },
          'meta-data': [
            { $: { 'android:name': 'android.max_aspect', 'android:value': '2.4' } },
            { $: { 'android:name': 'expo.modules.updates.EXPO_UPDATE_URL', 'android:value': 'https://x' } },
          ],
          activity: opts.activities ?? [
            {
              $: {
                'android:name': '.MainActivity',
                'android:exported': 'true',
                'android:screenOrientation': 'portrait',
                'android:configChanges': 'orientation|screenSize',
              },
            },
          ],
        },
      ],
    },
  };
}

describe('W1 — window policy (v3.4.2: orientation freedom)', () => {
  test('the plugin exports the app plugin function itself', () => {
    expect(typeof plugin).toBe('function');
  });

  test('resizeableActivity is explicitly TRUE — never false', () => {
    const m = applyWindowPolicy(freshManifest({ applicationAttrs: { 'android:resizeableActivity': 'false' } }));
    expect(m.manifest.application[0].$['android:resizeableActivity']).toBe('true');
  });

  test('a clean manifest also gets the explicit true (future-proof vs default flips)', () => {
    const m = applyWindowPolicy(freshManifest());
    expect(m.manifest.application[0].$['android:resizeableActivity']).toBe('true');
  });

  test('stale v3.4.0 maxAspectRatio attr is stripped', () => {
    const m = applyWindowPolicy(freshManifest({ applicationAttrs: { 'android:maxAspectRatio': '2.4' } }));
    expect(m.manifest.application[0].$['android:maxAspectRatio']).toBeUndefined();
  });

  test('stale minAspectRatio attr is also stripped', () => {
    const m = applyWindowPolicy(freshManifest({ applicationAttrs: { 'android:minAspectRatio': '1.0' } }));
    expect(m.manifest.application[0].$['android:minAspectRatio']).toBeUndefined();
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
      freshManifest({ applicationAttrs: { 'android:maxAspectRatio': '1.8' } }),
    );
    expect(JSON.stringify(m)).not.toContain('maxAspectRatio');
    expect(JSON.stringify(m)).not.toContain('android.max_aspect');
  });

  // ── THE ROOT FIX: orientation freedom ─────────────────────────────

  test('screenOrientation="portrait" is stripped from activities (the v1→v3.4.1 root cause)', () => {
    const m = applyWindowPolicy(freshManifest());
    const acts = m.manifest.application[0].activity;
    for (const a of acts) {
      expect(a.$['android:screenOrientation']).toBeUndefined();
    }
    // other activity attributes survive untouched
    expect(acts[0].$['android:name']).toBe('.MainActivity');
    expect(acts[0].$['android:configChanges']).toBe('orientation|screenSize');
  });

  test('landscape locks are stripped too (never trade one lock for another)', () => {
    const m = applyWindowPolicy(
      freshManifest({
        activities: [
          { $: { 'android:name': '.A', 'android:screenOrientation': 'landscape' } },
          { $: { 'android:name': '.B', 'android:screenOrientation': 'userPortrait' } },
          { $: { 'android:name': '.C', 'android:screenOrientation': 'locked' } },
          { $: { 'android:name': '.D' } }, // already free — stays free
        ],
      }),
    );
    for (const a of m.manifest.application[0].activity) {
      expect(a.$['android:screenOrientation']).toBeUndefined();
    }
    expect(m.manifest.application[0].activity.length).toBe(4);
  });

  test('a manifest with NO activity array is still safe (never throws)', () => {
    const m = applyWindowPolicy(freshManifest());
    delete m.manifest.application[0].activity;
    expect(applyWindowPolicy(m)).toBe(m);
  });

  // ── explicit large-screen support declaration ─────────────────────

  test('supports-screens declares large/xlarge/anyDensity support', () => {
    const m = applyWindowPolicy(freshManifest());
    const ss = m.manifest['supports-screens'][0].$;
    expect(ss['android:largeScreens']).toBe('true');
    expect(ss['android:xlargeScreens']).toBe('true');
    expect(ss['android:anyDensity']).toBe('true');
    expect(ss['android:normalScreens']).toBe('true');
    expect(ss['android:smallScreens']).toBe('true');
  });

  test('an existing supports-screens element is merged, not duplicated', () => {
    const m = applyWindowPolicy(
      freshManifest({
        existingSupportsScreens: [
          { $: { 'android:largeScreens': 'false', 'android:resizeable': 'true' } },
        ],
      }),
    );
    const list = m.manifest['supports-screens'];
    expect(list.length).toBe(1);
    expect(list[0].$['android:largeScreens']).toBe('true'); // flipped
    expect(list[0].$['android:resizeable']).toBe('true'); // preserved
  });

  test('missing application node is a no-op (never throws)', () => {
    const weird = { manifest: {} };
    expect(applyWindowPolicy(weird)).toBe(weird);
  });
});
