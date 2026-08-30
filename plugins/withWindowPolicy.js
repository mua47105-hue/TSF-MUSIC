/**
 * withWindowPolicy — resizeable, any-window policy (v3.4.1).
 *
 * HISTORY (why this file exists and why it was INVERTED):
 *
 * v3.4.0 (lab.4 port) wrote `resizeableActivity="false"` +
 * maxAspectRatio="2.4" + legacy `android.max_aspect` meta-data, believing
 * the field-reported "~48%-height window pinned to the top with the
 * launcher visible below" was a Samsung split-screen / pop-up container
 * the app could refuse.
 *
 * That diagnosis was wrong. The v3.4.1 field report is decisive: on two
 * separate tablets the app rendered in exactly that ~48%-height window —
 * pixel forensics on the uploaded screenshot (600x960) show the app's UI
 * ending at 46.6% with the tab bar at the window's bottom edge and a
 * uniform RGB(10,10,10) ≈ #0A0A0B (the app's own windowBackground) fill
 * below it, i.e. an OS-painted letterbox. `resizeableActivity="false"` is
 * the textbook trigger: on Android 12L+/One UI tablets with a taskbar,
 * NON-RESIZABLE apps are hosted in fixed-size compatibility windows
 * instead of full-screen. The plugin manufactured the very bug it shipped
 * to fix.
 *
 * v3.4.1 policy (this file):
 *   1. `android:resizeableActivity="true"` — explicit, future-proof.
 *      The system may host the activity in ANY container (fullscreen,
 *      split-screen, pop-up, freeform, foldable postures) and the app
 *      must lay out correctly in all of them. React Native + flexbox +
 *      useWindowDimensions already do this; the app's layout is
 *      window-reactive by construction.
 *   2. NO maxAspectRatio attr, NO legacy android.max_aspect meta-data —
 *      the app renders edge-to-edge at any ratio (16:10 tablets, 21:9
 *      phones, 2.4:1 tall screens) with zero letterbox excuses.
 *   3. The plugin also REMOVES any stale v3.4.0 attributes/meta-data so
 *      an upgraded build can never inherit the old policy.
 *
 * Note: this MUST stay a config plugin — CI regenerates android/ via
 * `expo prebuild` on every build, so hand-edits to the committed manifest
 * would be silently overwritten.
 */

const { withAndroidManifest } = require('expo/config-plugins');

/**
 * Pure manifest transform (exported for tests — W1 lock). Mutates the
 * parsed AndroidManifest object graph in place and returns it.
 */
function applyWindowPolicy(manifest) {
  const application = manifest.manifest.application?.[0];
  if (!application) return manifest;

  // 1. explicitly resizeable — never a compatibility-window candidate
  application.$['android:resizeableActivity'] = 'true';

  // 2. no aspect-ratio caps (remove any stale v3.4.0 output)
  delete application.$['android:maxAspectRatio'];
  if (Array.isArray(application['meta-data'])) {
    application['meta-data'] = application['meta-data'].filter(
      (m) => m?.$?.['android:name'] !== 'android.max_aspect',
    );
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
