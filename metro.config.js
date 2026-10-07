/**
 * Metro config — web-only module redirects for the screenshot harness.
 *
 * On platform 'web' the data + player layers resolve to src/webmocks/*
 * (fixtures + an in-memory player). The Android build (expo export
 * --platform android / CI) is 100% unaffected: every branch below is
 * gated on platform === 'web'.
 */

const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;

const WEB_MODULE_ALIASES = {
  'react-native-track-player': path.join(projectRoot, 'src/webmocks/trackPlayer.ts'),
  'expo-file-system': path.join(projectRoot, 'src/webmocks/fileSystem.ts'),
};

const WEB_PATH_REDIRECTS = [
  { suffix: path.join('src', 'api', 'saavn.ts'), to: path.join(projectRoot, 'src/webmocks/saavn.ts') },
  // SEARCH V2: the REAL engine orchestrator runs on web — its deps all
  // redirect below, so the lab exercises the true S0→S5 pipeline.
  { suffix: path.join('src', 'api', 'itunes.ts'), to: path.join(projectRoot, 'src/webmocks/itunes.ts') },
  { suffix: path.join('src', 'api', 'artists.ts'), to: path.join(projectRoot, 'src/webmocks/artists.ts') },
  // SEARCH V2: LRCLIB lyric verification → fixture lyrics (lab parity)
  { suffix: path.join('src', 'api', 'lrclib.ts'), to: path.join(projectRoot, 'src/webmocks/lrclib.ts') },
  // YOUTUBE SOURCE (v3.4.0): InnerTube ships no CORS headers — a browser
  // page can never call it live. Fixture-backed webmock keeps the harness
  // deterministic; the real module is covered by bun suites + live probes.
  { suffix: path.join('src', 'api', 'youtube.ts'), to: path.join(projectRoot, 'src/webmocks/youtube.ts') },
  // MINDBEAT: the SQLite ledger store has no web build — the in-memory
  // store exports the same createLedgerStore() signature (harness parity).
  { suffix: path.join('src', 'ai', 'core', 'storeSqlite.ts'), to: path.join(projectRoot, 'src/ai/core/storeMemory.ts') },
  // MAGNUM OPUS: the app-content tables (stories/bookmarks/memory tags/
  // session snapshots) swap SQLite for Maps on web (house rule ⑮ parity).
  { suffix: path.join('src', 'storage', 'appTables.ts'), to: path.join(projectRoot, 'src/webmocks/appTables.ts') },
];

module.exports = (async () => {
  const config = await getDefaultConfig(projectRoot);

  // MAGNUM OPUS F5 — inline requires ON (Expo's default is FALSE,
  // @expo/metro-config ExpoMetroConfig.js). Module bodies initialize at
  // first require instead of at bundle load: the boot path executes only
  // what App.tsx actually needs before first paint. Behavior is
  // unchanged (same modules, same singletons — later timing); the full
  // test suite + web lab validate both.
  config.transformer.getTransformOptions = async () => ({
    transform: {
      experimentalImportSupport: false,
      inlineRequires: true,
    },
  });

  config.resolver.resolveRequest = (context, moduleName, platform) => {
    if (platform === 'web' && WEB_MODULE_ALIASES[moduleName]) {
      return context.resolveRequest(
        context,
        WEB_MODULE_ALIASES[moduleName],
        platform,
      );
    }

    const defaultResult = context.resolveRequest(context, moduleName, platform);

    if (
      platform === 'web' &&
      defaultResult &&
      defaultResult.type === 'sourceFile' &&
      defaultResult.filePath
    ) {
      for (const redirect of WEB_PATH_REDIRECTS) {
        if (defaultResult.filePath.endsWith(redirect.suffix)) {
          return context.resolveRequest(context, redirect.to, platform);
        }
      }
    }

    return defaultResult;
  };

  return config;
})();
