/**
 * withWindowPolicy — adaptive, any-window, any-orientation policy
 * (v3.4.2; the plugin that finally matches the real root cause).
 *
 * FULL HISTORY (why this file exists, and why v3.4.2 removes the
 * orientation lock — the actual root cause of the tablet bug):
 *
 * The field bug (reported from lab.3 through v3.4.1, on two Samsung
 * tablets): the app renders in a ~half-height window pinned to the top,
 * with the tab bar mid-screen and a uniform RGB(10,10,10) void below.
 * The void color == the app's own windowBackground (#0A0A0B) — that is
 * the OS "matte": per Android's official device-compatibility-mode doc,
 * letterboxed apps on large screens are positioned "to one side or the
 * other" with solid-color mattes "along the sides or top and bottom".
 *
 * Diagnosis timeline:
 *   - lab.3 guessed "Samsung split-screen container";
 *   - v3.4.0 shipped resizeableActivity="false" + maxAspectRatio 2.4 to
 *     "refuse" such containers (manufactured an even stronger compat
 *     trigger);
 *   - v3.4.1 inverted that (resizeableActivity="true", no caps) — the
 *     tablets STILL letterboxed, and the One UI per-app "Full screen"
 *     aspect setting changed nothing (it controls the aspect-ratio
 *     letterbox path, not the orientation one).
 *   - v3.4.2 forensics: the one window restriction present in EVERY
 *     shipped version is `android:screenOrientation="portrait"` on the
 *     activity (app.json "orientation": "portrait"). Google's docs are
 *     explicit: "App restricted to portrait orientation is letterboxed
 *     on landscape tablet and foldable" — and the fix is "Remove all
 *     orientation and fixed aspect ratio restrictions". Phones are
 *     compact-window devices and never letterbox; sw600dp+ tablets
 *     always do, for orientation-locked apps. That is why every phone
 *     was fine and every tablet was broken, regardless of app version.
 *
 * v3.4.2 policy (this file):
 *   1. `android:resizeableActivity="true"` (kept from v3.4.1).
 *   2. NO aspect caps: strips maxAspectRatio attr + legacy
 *      android.max_aspect meta-data (kept from v3.4.1).
 *   3. THE ROOT FIX — strips `android:screenOrientation` from every
 *      activity, so the app never declares a fixed orientation and can
 *      never be classified as a "phone-only app" that large screens
 *      must letterbox. The app's layout is fully window-reactive
 *      (useWindowDimensions everywhere that used to freeze phone
 *      constants), so free orientation is safe. Android 16 already
 *      ignores orientation locks on sw600dp+ screens, and API 37 will
 *      ignore them everywhere — this policy just gets there first.
 *   4. Explicit `<supports-screens>` declaring large-screen support
 *      (largeScreens/xlargeScreens/anyDensity = true) — the declaration
 *      Google's large-screen checklists ask for.
 *
 * iOS keeps its portrait lock via Info.plist (UISupportedInterfaceOrientations)
 * — iPad is unsupported there and the bug is Android-only, so iOS behavior
 * is intentionally unchanged.
 *
 * Note: this MUST stay a config plugin — CI regenerates android/ via
 * `expo prebuild` on every build, so hand-edits to the committed manifest
 * would be silently overwritten.
 */

const { withAndroidManifest } = require('expo/config-plugins');

/**
 * Pure manifest transform (exported for tests — W1 locks). Mutates the
 * parsed AndroidManifest object graph in place and returns it.
 */
function applyWindowPolicy(manifest) {
  const application = manifest.manifest.application?.[0];
  if (!application) return manifest;

  // 1. explicitly resizeable — never a compatibility-window candidate
  application.$['android:resizeableActivity'] = 'true';

  // 2. no aspect-ratio caps (remove any stale v3.4.0 output)
  delete application.$['android:maxAspectRatio'];
  delete application.$['android:minAspectRatio'];
  if (Array.isArray(application['meta-data'])) {
    application['meta-data'] = application['meta-data'].filter(
      (m) => m?.$?.['android:name'] !== 'android.max_aspect',
    );
  }

  // 3. THE ROOT FIX — orientation freedom on every activity. A fixed
  //    screenOrientation is what made every sw600dp+ device letterbox
  //    the app since v1 ("portrait-locked apps get compatibility
  //    windows on large screens"). Strip whichever lock Expo wrote
  //    (portrait / landscape / userPortrait / locked / nosensor ...).
  if (Array.isArray(application.activity)) {
    for (const activity of application.activity) {
      if (activity?.$) delete activity.$['android:screenOrientation'];
    }
  }

  // 4. explicit large-screen support declaration. Manifest merges are
  //    last-writer-wins per attribute, so only touch the four flags.
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
