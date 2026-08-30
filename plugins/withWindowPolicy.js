/**
 * withWindowPolicy v3 — the real tablet fix: full-surface rendering on
 * every device, immune to BOTH the legacy Samsung/One UI aspect layer
 * and the Android 14+ compatibility-override framework.
 *
 * COMPLETE ROOT-CAUSE HISTORY (five rounds of field + binary evidence):
 *
 * The field bug (two Samsung One UI tablets, lab.3 → v3.4.2): the app
 * renders in a ~half-height window pinned to the top of the screen with
 * the tab bar mid-screen and a uniform RGB(10,10,10) matte below (the
 * app's own windowBackground #0A0A0B — what the OS paints compat
 * mattes with).
 *
 * R6 forensics finally decoded the window SHAPE: the app window on the
 * 600x927-content tablet is 600x450 — the LARGEST 4:3-RATIO RECTANGLE
 * THAT FITS THE SCREEN WIDTH (600 / (4/3) = 450). Every prior field
 * screenshot matches the same 4:3 geometry once the 13px matte-shadow
 * band is subtracted. A 4:3 clamp is an ASPECT-RATIO compatibility
 * policy — applied by the OS override layer, NOT by anything the app
 * declares:
 *
 *   - Android 14+/One UI 6 ships a USER "app aspect ratio" menu whose
 *     options include literal "3:4"; One UI additionally auto-applies
 *     phone-aspect (4:3) clamps to apps its legacy layer considers
 *     phone-class (notably: apps that never declare max aspect).
 *   - v3.4.0 (resizeableActivity="false") triggered the non-resizable
 *     letterbox path. v3.4.1/v3.4.2 removed EVERY restriction — and
 *     still clamped, because an UNDECLARED max aspect leaves the app in
 *     the legacy auto-clamp bucket, and a stored user/OEM aspect
 *     override survives manifest changes (the user's "Full screen"
 *     toggle never neutralized it: One UI re-evaluates window policy
 *     only on cold start, and the menu kept re-applying the override).
 *     Rotation freedom in v3.4.2 proved the new manifest was active —
 *     the clamp rides a different layer entirely.
 *
 * THE v3 POLICY (belt + suspenders across both override layers):
 *   1. `android:resizeableActivity="true"` (kept) — never a
 *      non-resizable letterbox candidate.
 *   2. NO orientation restriction (kept) — screenOrientation stripped
 *      from every activity (v3.4.2, field-verified: rotation works).
 *   3. `<supports-screens>` large/xlarge/anyDensity (kept).
 *   4. DECLARE a modern max aspect: `android:maxAspectRatio="2.4"` +
 *      legacy `<meta-data android:name="android.max_aspect" 2.4>`.
 *      Stock Android IGNORES declared aspect when
 *      resizeableActivity="true" (official doc), so this is a no-op on
 *      AOSP — but Samsung's legacy layer reads max_aspect to decide
 *      which apps get the 4:3 phone-aspect clamp; declaring ≥ screen
 *      ratio (2.4 > 1.55 tablet, > 2.22 tall phones) marks the app
 *      full-bleed there.
 *   5. OPT OUT of the entire Android 14+/One UI 6 compat override
 *      framework via PackageManager properties on <application>:
 *        PROPERTY_COMPAT_ALLOW_USER_ASPECT_RATIO_OVERRIDE=false
 *          → app is REMOVED from the user aspect menu; any stored 3:4
 *            user override can no longer apply to it.
 *        PROPERTY_COMPAT_ALLOW_MIN_ASPECT_RATIO_OVERRIDE=false
 *          → OEM OVERRIDE_MIN_ASPECT_RATIO_* (4:3/50% split clamps)
 *            cannot touch the app.
 *        PROPERTY_COMPAT_ALLOW_ORIENTATION_OVERRIDE=false
 *          → OVERRIDE_ANY_ORIENTATION_* cannot re-lock orientation.
 *        PROPERTY_COMPAT_ALLOW_RESIZEABLE_ACTIVITY_OVERRIDES=false
 *          → FORCE_NON_RESIZE_APP / FORCE_RESIZE_APP cannot flip
 *            resizability.
 *      (Parsed by the platform from the manifest via
 *      PackageManager.getProperty — the AOSP compat framework reads it
 *      platform-side; no Jetpack WindowManager dependency is involved
 *      in whether OVERRIDES apply. Pre-API-30 parsers ignore <property>
 *      tags silently, and those Androids predate the framework.)
 *
 * iOS keeps its portrait lock via Info.plist — unchanged.
 *
 * Must stay a config plugin: CI regenerates android/ with
 * `expo prebuild` every build, so hand-edits would be overwritten.
 */

const { withAndroidManifest } = require('expo/config-plugins');

// Modern full-bleed max aspect: must EXCEED every real display's
// long/short ratio — tall phones top out ~2.33 (21:9), Samsung Z Flip
// folds are 22:9 = 2.444, tablets ~1.6 — so 2.6 clears everything with
// margin (a smaller value would let Samsung's legacy layer CLAMP the
// app onto itself on exactly those tall screens). Ignored by stock
// Android while resizeableActivity=true — meaningful only to Samsung's
// legacy clamp, which needs to SEE a declaration ≥ device ratio.
const MAX_ASPECT = '2.6';

// The four compat-framework opt-outs (official names from
// developer.android.com/guide/practices/device-compatibility-mode).
const COMPAT_PROPERTIES = [
  'android.window.PROPERTY_COMPAT_ALLOW_USER_ASPECT_RATIO_OVERRIDE',
  'android.window.PROPERTY_COMPAT_ALLOW_MIN_ASPECT_RATIO_OVERRIDE',
  'android.window.PROPERTY_COMPAT_ALLOW_ORIENTATION_OVERRIDE',
  'android.window.PROPERTY_COMPAT_ALLOW_RESIZEABLE_ACTIVITY_OVERRIDES',
];

/**
 * Upsert-style helpers so the transform is idempotent (prebuild may run
 * the plugin on manifests our older versions already touched, and the
 * test suite asserts double-application stability).
 */
function upsertMetaData(application, name, value) {
  if (!Array.isArray(application['meta-data'])) application['meta-data'] = [];
  const arr = application['meta-data'];
  const found = arr.find((m) => m?.$?.['android:name'] === name);
  if (found) found.$['android:value'] = value;
  else arr.push({ $: { 'android:name': name, 'android:value': value } });
}

function upsertProperty(application, name, value) {
  if (!Array.isArray(application.property)) application.property = [];
  const arr = application.property;
  const found = arr.find((p) => p?.$?.['android:name'] === name);
  if (found) found.$['android:value'] = value;
  else arr.push({ $: { 'android:name': name, 'android:value': value } });
}

/**
 * Pure manifest transform (exported for tests — W1 locks). Mutates the
 * parsed AndroidManifest object graph in place and returns it.
 */
function applyWindowPolicy(manifest) {
  const application = manifest.manifest.application?.[0];
  if (!application) return manifest;

  // 1. explicitly resizeable — never a compatibility-window candidate
  application.$['android:resizeableActivity'] = 'true';

  // 2. no aspect RESTRICTIONS (min clamps are restrictions; max, with
  //    resizable=true, is a legacy-Samsung full-bleed declaration —
  //    set below). Strip any stale minAspectRatio from old versions.
  delete application.$['android:minAspectRatio'];

  // 4a. modern attribute (API 26+; ignored by stock when resizable)
  application.$['android:maxAspectRatio'] = MAX_ASPECT;
  // 4b. legacy meta-data (pre-API-26 OEM layers, Samsung legacy clamp)
  upsertMetaData(application, 'android.max_aspect', MAX_ASPECT);

  // 5. opt out of every compat override family (API 30+ parses
  //    <property>; older platforms skip the tag harmlessly).
  for (const name of COMPAT_PROPERTIES) {
    upsertProperty(application, name, 'false');
  }

  // 3. orientation freedom on every activity — a fixed
  //    screenOrientation is a restriction the override framework can
  //    amplify; strip whichever lock Expo wrote (portrait / landscape /
  //    userPortrait / locked / nosensor ...).
  if (Array.isArray(application.activity)) {
    for (const activity of application.activity) {
      if (activity?.$) delete activity.$['android:screenOrientation'];
    }
  }

  // 3b. explicit large-screen support declaration. Manifest merges are
  //     last-writer-wins per attribute, so only touch the flags.
  const supports = {
    $: {
      'android:largeScreens': 'true',
      'android:xlargeScreens': 'true',
      'android:normalScreens': 'true',
      'android:smallScreens': 'true',
      'android:anyDensity': 'true',
    },
  };
  const existing = Array.isArray(manifest.manifest['supports-screens'])
    ? manifest.manifest['supports-screens']
    : [];
  if (existing.length > 0) {
    existing[0].$ = { ...existing[0].$, ...supports.$ };
  } else {
    manifest.manifest['supports-screens'] = [supports];
  }

  return manifest;
}

function withWindowPolicy(config) {
  return withAndroidManifest(config, (config) => {
    applyWindowPolicy(config.modResults);
    return config;
  });
}

module.exports = withWindowPolicy;
module.exports.applyWindowPolicy = applyWindowPolicy;
module.exports.MAX_ASPECT = MAX_ASPECT;
module.exports.COMPAT_PROPERTIES = COMPAT_PROPERTIES;
