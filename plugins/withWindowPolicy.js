/**
 * withWindowPolicy — fullscreen-determinism config plugin (lab.4).
 *
 * WHY: the field report (v3.4.0-lab.3) captured the app wedged into a
 * ~48%-height window pinned to the top of the screen with the launcher
 * visible below — the classic Samsung split-screen / "snap window" /
 * pop-up container. Nothing in the app's layout was broken; the OS was
 * free to host the activity in a multi-window container because the
 * manifest declared no window policy at all.
 *
 * WHAT it writes into AndroidManifest.xml (idempotent, survives prebuild):
 *   1. android:resizeableActivity="false" on <application>
 *      → the system refuses split-screen / snap-window / pop-up hosts and
 *        always renders the activity full-screen (an attempted snap shows
 *        the standard "app doesn't support split screen" toast instead of
 *        wedging the UI).
 *   2. android:maxAspectRatio="2.4" on <application> (API 28+ attribute)
 *   3. <meta-data android:name="android.max_aspect" android:value="2.4"/>
 *      (legacy max-aspect declaration for API < 28 devices, so tall
 *      screens render full-bleed rather than letterboxed)
 *
 * Note: this MUST be a config plugin — CI regenerates android/ via
 * `expo prebuild` on every build, so hand-edits to the committed manifest
 * would be silently overwritten.
 */

const { withAndroidManifest } = require('expo/config-plugins');

const MAX_ASPECT = '2.4';

function withWindowPolicy(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    const application = manifest.manifest.application?.[0];
    if (!application) return config;

    // 1. refuse multi-window containers → deterministic full-screen
    application.$['android:resizeableActivity'] = 'false';
    // 2. tall-screen support attr (API 28+)
    application.$['android:maxAspectRatio'] = MAX_ASPECT;

    // 3. legacy max-aspect meta-data (API < 28)
    const metaData = application['meta-data'] ?? (application['meta-data'] = []);
    const exists = metaData.some((m) => m.$?.['android:name'] === 'android.max_aspect');
    if (!exists) {
      metaData.push({
        $: {
          'android:name': 'android.max_aspect',
          'android:value': MAX_ASPECT,
        },
      });
    }

    return config;
  });
}

module.exports = withWindowPolicy;
