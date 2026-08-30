/**
 * W1 WINDOW-POLICY LOCKS (gauntlet R6, v3.4.3).
 *
 * The full bug history being locked (four rounds of field evidence):
 *
 *  - v3.4.0 shipped `resizeableActivity="false"` + maxAspectRatio 2.4
 *    + legacy `android.max_aspect` — a manufactured non-resizable
 *    letterbox trigger (reverted in v3.4.1).
 *  - v3.4.1 (resizable, uncapped) STILL clamped on two Samsung tablets;
 *    the One UI per-app "Full screen" aspect toggle changed nothing.
 *  - v3.4.2 stripped `android:screenOrientation` (rotation freedom —
 *    field-verified working) but the half-window survived: R6 forensics
 *    measured the app window at EXACTLY 600x450 = the largest 4:3
 *    rectangle fitting screen width (600/(4/3)=450; every prior field
 *    screenshot matches once the 13px matte-shadow band is subtracted).
 *    A 4:3 window is an ASPECT-RATIO compatibility clamp applied by the
 *    OS override layer — Android 14+/One UI 6 user "app aspect ratio"
 *    menu (options include literal 3:4) and Samsung's legacy auto
 *    phone-aspect clamp for apps that never declare max aspect.
 *  - v3.4.3 therefore DECLARES modern full-bleed max aspect (2.4 attr +
 *    legacy meta — ignored by stock while resizable=true, decisive for
 *    Samsung's legacy layer) and opts out of the whole compat override
 *    framework via the four official PROPERTY_COMPAT_* manifest
 *    properties, so no user/OEM aspect or orientation override can ever
 *    clamp the app again.
 *
 * These locks prove the compiled manifest can never carry an
 * orientation lock, non-resizability, or an aspect RESTRICTION — and
 * MUST carry the full-bleed declaration + override opt-outs.
 */
import { describe, expect, test } from 'bun:test';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const plugin = require('../../plugins/withWindowPolicy');
const applyWindowPolicy = plugin.applyWindowPolicy as (m: any) => any;
const COMPAT_PROPERTIES = plugin.COMPAT_PROPERTIES as string[];
const MAX_ASPECT = plugin.MAX_ASPECT as string;

function freshManifest(opts: {
  applicationAttrs?: Record<string, string>;
  activities?: Array<Record<string, any>>;
  existingSupportsScreens?: Array<Record<string, any>>;
  existingProperties?: Array<Record<string, any>>;
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
            { $: { 'android:name': 'android.max_aspect', 'android:value': '1.86' } },
            { $: { 'android:name': 'expo.modules.updates.EXPO_UPDATE_URL', 'android:value': 'https://x' } },
          ],
          ...(opts.existingProperties ? { property: opts.existingProperties } : {}),
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

function propNames(m: any): string[] {
  const arr = m.manifest.application[0].property ?? [];
  return arr.map((p: any) => p?.$?.['android:name']);
}

describe('W1 — window policy (v3.4.3: aspect-clamp immunity)', () => {
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

  // ── full-bleed aspect DECLARATION (legacy Samsung layer) ───────────

  test('maxAspectRatio is declared 2.6 — full-bleed on every real display', () => {
    const m = applyWindowPolicy(
      freshManifest({ applicationAttrs: { 'android:maxAspectRatio': '1.8' } }),
    );
    expect(m.manifest.application[0].$['android:maxAspectRatio']).toBe('2.6');
  });

  test('declared max aspect EXCEEDS the tallest real display ratio (Z Flip 22:9 = 2.444)', () => {
    // Samsung's legacy layer honors declared max aspect as a REAL clamp —
    // a value below the device ratio would letterbox the app onto itself.
    // Tall phones: 21:9 = 2.333; Samsung Z Flip 3/4/5 main: 22:9 = 2.444.
    const TALLEST_REAL_DISPLAY_RATIO = 2.444;
    expect(parseFloat(MAX_ASPECT)).toBeGreaterThan(TALLEST_REAL_DISPLAY_RATIO);
    // and stays a sane, industry-standard magnitude (not infinity-cargo)
    expect(parseFloat(MAX_ASPECT)).toBeLessThan(3.0);
  });

  test('legacy android.max_aspect meta is upserted to 2.6 (stale 1.86 rewritten, not duplicated)', () => {
    const m = applyWindowPolicy(freshManifest());
    const metas = m.manifest.application[0]['meta-data'];
    const maxAspects = metas.filter((x: any) => x.$['android:name'] === 'android.max_aspect');
    expect(maxAspects.length).toBe(1);
    expect(maxAspects[0].$['android:value']).toBe('2.6');
    // unrelated meta survives untouched
    expect(metas.some((x: any) => x.$['android:name'] === 'expo.modules.updates.EXPO_UPDATE_URL')).toBe(true);
  });

  test('a manifest with NO meta-data array still gains the max_aspect entry (create branch)', () => {
    const m = applyWindowPolicy(freshManifest());
    delete m.manifest.application[0]['meta-data'];
    const out = applyWindowPolicy(m);
    const metas = out.manifest.application[0]['meta-data'];
    expect(Array.isArray(metas)).toBe(true);
    const maxAspects = metas.filter((x: any) => x.$['android:name'] === 'android.max_aspect');
    expect(maxAspects.length).toBe(1);
    expect(maxAspects[0].$['android:value']).toBe('2.6');
  });

  test('minAspectRatio (a RESTRICTION) is always stripped', () => {
    const m = applyWindowPolicy(freshManifest({ applicationAttrs: { 'android:minAspectRatio': '1.0' } }));
    expect(m.manifest.application[0].$['android:minAspectRatio']).toBeUndefined();
    expect(JSON.stringify(m)).not.toContain('minAspectRatio');
  });

  // ── compat-framework opt-outs (Android 14+/One UI 6) ──────────────

  test('all four PROPERTY_COMPAT opt-outs are present and false', () => {
    const m = applyWindowPolicy(freshManifest());
    const names = propNames(m);
    for (const name of COMPAT_PROPERTIES) {
      expect(names).toContain(name);
      const p = m.manifest.application[0].property.find(
        (x: any) => x.$['android:name'] === name,
      );
      expect(p.$['android:value']).toBe('false');
    }
  });

  test('opt-out list includes the USER aspect override by its exact official name', () => {
    // the 3:4 user menu is the field-verified clamp path — lock the name
    expect(COMPAT_PROPERTIES).toContain(
      'android.window.PROPERTY_COMPAT_ALLOW_USER_ASPECT_RATIO_OVERRIDE',
    );
    expect(COMPAT_PROPERTIES).toContain(
      'android.window.PROPERTY_COMPAT_ALLOW_MIN_ASPECT_RATIO_OVERRIDE',
    );
    expect(COMPAT_PROPERTIES).toContain(
      'android.window.PROPERTY_COMPAT_ALLOW_ORIENTATION_OVERRIDE',
    );
    expect(COMPAT_PROPERTIES).toContain(
      'android.window.PROPERTY_COMPAT_ALLOW_RESIZEABLE_ACTIVITY_OVERRIDES',
    );
  });

  test('properties are upserted idempotently — no duplicates on double apply', () => {
    const once = applyWindowPolicy(freshManifest());
    const twice = applyWindowPolicy(once);
    const names = propNames(twice);
    const unique = new Set(names);
    expect(names.length).toBe(unique.size);
    expect(names.length).toBe(COMPAT_PROPERTIES.length);
  });

  test('a hostile pre-existing true value for ANY opt-out is rewritten to false', () => {
    const m = applyWindowPolicy(
      freshManifest({
        existingProperties: COMPAT_PROPERTIES.map((name) => ({
          $: { 'android:name': name, 'android:value': 'true' },
        })),
      }),
    );
    for (const p of m.manifest.application[0].property) {
      expect(p.$['android:value']).toBe('false');
    }
    expect(m.manifest.application[0].property.length).toBe(COMPAT_PROPERTIES.length);
  });

  // ── orientation freedom (v3.4.2, field-verified) ───────────────────

  test('screenOrientation="portrait" is stripped from activities', () => {
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

  // ── serialization round-trip: expo's OWN manifest reader/writer must
  //    preserve the <property> elements (the failure class that would
  //    silently kill this fix on an expo upgrade) ─────────────────────

  test('property + max-aspect declarations survive expo\'s XML write/read round-trip', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readAndroidManifestAsync, writeAndroidManifestAsync } = require('@expo/config-plugins/build/android/Manifest');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w1-rt-'));
    const file = path.join(dir, 'AndroidManifest.xml');
    fs.writeFileSync(file, '<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.tsf.music">\n  <application android:name=".MainApplication">\n    <activity android:name=".MainActivity" android:screenOrientation="portrait"/>\n  </application>\n</manifest>\n');
    try {
      const parsed = await readAndroidManifestAsync(file);
      applyWindowPolicy(parsed);
      await writeAndroidManifestAsync(file, parsed);
      const xml = fs.readFileSync(file, 'utf8');
      for (const name of COMPAT_PROPERTIES) {
        expect(xml).toContain(name);
      }
      expect(xml).toContain('android:name="android.max_aspect"');
      expect(xml).toContain('android:value="2.6"');
      expect(xml).toContain('android:maxAspectRatio="2.6"');
      expect(xml).not.toContain('screenOrientation="portrait"');
      // and re-parsing yields the same property set (stable structure)
      const reparsed = await readAndroidManifestAsync(file);
      const props = (reparsed.manifest.application[0].property ?? []).map(
        (p: any) => p.$['android:name'],
      );
      expect(props.length).toBe(COMPAT_PROPERTIES.length);
      expect(new Set(props).size).toBe(COMPAT_PROPERTIES.length);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
