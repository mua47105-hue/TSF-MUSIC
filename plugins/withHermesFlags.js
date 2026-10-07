/**
 * withHermesFlags (MAGNUM OPUS F5) — pins the hermesc flag set used for
 * the release bytecode via a second `react { }` block appended to the
 * prebuilt android/app/build.gradle (a second block reconfigures the
 * SAME ReactExtension — the flags TaskConfiguration hands to hermesc).
 *
 * WHY: RN's gradle plugin defaults hermesFlags to
 * ['-O', '-output-source-map'] (ReactExtension.kt) — '-O' is already on.
 * We add '-fstrip-function-names' (verified against the toolchain's
 * `hermesc --help`): function names leave the bytecode string table,
 * shrinking the packed string blob the runtime parses at load. The
 * mission draft suggested '-emit-moving-average' — that flag DOES NOT
 * EXIST in hermesc and is NOT shipped (anti-hallucination law).
 *
 * Expo prebuild regenerates android/ in CI (never committed), so the
 * plugin is the only honest injection point. The mod is idempotent:
 * an existing TSF hermes block is replaced, never duplicated.
 */

const { withAppBuildGradle, createRunOncePlugin } = require('@expo/config-plugins');

const RN_DEFAULT_FLAGS = ['-O', '-output-source-map'];
const EXTRA_FLAGS = ['-fstrip-function-names'];

/** The exact gradle block this plugin manages (exported for the locks). */
const HERMES_MARKER = '/* tsf-hermes-flags (MAGNUM OPUS F5) */';
function hermesGradleBlock() {
  const flags = JSON.stringify([...RN_DEFAULT_FLAGS, ...EXTRA_FLAGS]);
  return [
    HERMES_MARKER,
    'react {',
    `    hermesFlags = ${flags}`,
    '}',
    '',
  ].join('\n');
}

/** Pure string transform (locked directly in tests). */
function applyHermesFlags(gradle) {
  const block = hermesGradleBlock();
  // Idempotent: strip any previous TSF block (marker through its closing
  // `}` line), then append fresh. The block body never contains `\n}\n`
  // before its own end, so the lazy match stops exactly there.
  const esc = HERMES_MARKER.replace(/[*/()]/g, '\\$&');
  const cleaned = gradle.replace(new RegExp(`${esc}[\\s\\S]*?\\n\\}\\n`), '');
  return `${cleaned.replace(/\s*$/, '\n')}\n${block}`;
}

const withHermesFlags = (config) =>
  withAppBuildGradle(config, (cfg) => {
    // Blind-critic P2-a: patch ONLY groovy build files (RN 0.76 prebuilds
    // groovy; a kotlin build.gradle.kts gets the same block via a future
    // kotlin variant — never a groovy block appended to the wrong file).
    if (cfg.modResults.language !== 'groovy') return cfg;
    cfg.modResults.contents = applyHermesFlags(cfg.modResults.contents);
    return cfg;
  });

module.exports = createRunOncePlugin(withHermesFlags, 'withHermesFlags', '1.0.0');
module.exports.applyHermesFlags = applyHermesFlags;
module.exports.hermesGradleBlock = hermesGradleBlock;
module.exports.HERMES_MARKER = HERMES_MARKER;
module.exports.HERMES_FLAGS = [...RN_DEFAULT_FLAGS, ...EXTRA_FLAGS];
