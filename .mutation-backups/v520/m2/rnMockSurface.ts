/**
 * THE REACT-NATIVE MOCK SURFACE — v5.2.0 FIX 1 (the P0 mock-leak class).
 *
 * THE INCIDENT CLASS (twice now): bun's `mock.module` registry is
 * PROCESS-GLOBAL and survives across test files. Any test file that
 * registers a PARTIAL react-native mock poisons every LATER file that
 * imports a react-native-dependent module without registering its own
 * mock — the victim destructures a key the partial mock never carried
 * and dies at module scope. v5.0.2 shipped exactly this fix for
 * expo-network (docs/CHANGELOG.md); this file closes the same class for
 * the react-native mock itself, which 19 test files had been
 * hand-rolling as partial literals (the waved_d1 ParallaxArtwork
 * StyleSheet crash class — reproducible with a two-file minimal pair:
 * fix_b3_prewarm_locks.test.ts followed by any StyleSheet-using module
 * without its own mock).
 *
 * THE LAW: every `mock.module('react-native', ...)` registration MUST
 * route through `rnMockSurface(...)` — the file's own overrides spread
 * LAST, so each file keeps EXACTLY the behavior it locked, while every
 * key any `from 'react-native'` named import in this repo touches is
 * guaranteed present. A future import of a new RN API without a surface
 * key is caught by tests/fix_v520_rn_mock_surface_locks.test.ts (the
 * live union-completeness lock), not by a crashed suite.
 *
 * THIS FILE MUST NOT IMPORT REACT-NATIVE — it is the thing that stands
 * in for it (pinned by the lock suite).
 */

type Surface = Record<string, unknown>;

/** Identity StyleSheet — `create` returns the styles untouched (the
 *  dominant hand-rolled default across the suite). */
const identityStyleSheet = {
  create: (s: Record<string, unknown>) => s,
  flatten: (s: Record<string, unknown>) => s,
  absoluteFill: {},
  hairlineWidth: 1,
};

/** The inert native-handler default for AppState (the most common
 *  hand-rolled override, kept byte-compatible). */
const appState = {
  addEventListener: () => ({ remove: () => undefined }),
  currentState: 'active',
};

/** The honest-a11y default: Reduce Motion OFF, live subscription stub. */
const accessibilityInfo = {
  isReduceMotionEnabled: async () => false,
  addEventListener: () => ({ remove: () => undefined }),
};

/** Minimal-but-present Animated: nothing in the suite animates under
 *  bun, but module-scope destructures must never meet `undefined`. */
const animated = {
  View: () => null,
  Text: () => null,
  ScrollView: () => null,
  event: () => () => undefined,
  timing: () => ({ start: () => undefined, stop: () => undefined }),
  delay: () => undefined,
  createAnimatedComponent: (C: unknown) => C,
  Value: class {
    setValue() {}
    interpolate() {
      return null;
    }
    addListener() {
      return { remove: () => undefined };
    }
    removeListener() {}
    removeAllListeners() {}
    stopAnimation() {}
    resetAnimation() {}
  },
  ValueXY: class {
    setValue() {}
    interpolate() {
      return null;
    }
    addListener() {
      return { remove: () => undefined };
    }
    removeListener() {}
  },
};

const platform = {
  OS: 'android',
  select: (o: Record<string, unknown>) => o.android,
  Version: 34,
};

/** The FULL default surface. Every named import this repo makes from
 *  'react-native' (the union across src/ + tests/ + App.tsx — live-
 *  checked by the lock suite) resolves here. */
const FULL_SURFACE: Surface = {
  // ── components ────────────────────────────────────────────────────────
  View: () => null,
  Text: () => null,
  ScrollView: () => null,
  FlatList: () => null,
  SectionList: () => null,
  Pressable: () => null,
  TextInput: () => null,
  ActivityIndicator: () => null,
  Modal: () => null,
  Image: () => null,
  ImageBackground: () => null,
  Switch: () => null,
  StatusBar: () => null,
  KeyboardAvoidingView: () => null,
  RefreshControl: () => null,

  // ── imperative APIs ───────────────────────────────────────────────────
  Alert: { alert: () => undefined },
  Keyboard: {
    dismiss: () => undefined,
    addListener: () => ({ remove: () => undefined }),
    removeListener: () => undefined,
    isVisible: async () => false,
  },
  PanResponder: { create: () => ({ panHandlers: {} }) },

  // ── style ─────────────────────────────────────────────────────────────
  StyleSheet: identityStyleSheet,

  // ── platform / device ─────────────────────────────────────────────────
  Platform: platform,
  NativeModules: {},
  Dimensions: {
    get: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }),
    addEventListener: () => ({ remove: () => undefined }),
  },
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }),
  I18nManager: { isRTL: false, allowRTL: () => undefined, forceRTL: () => undefined },
  PermissionsAndroid: {
    request: async () => 'granted',
    check: async () => true,
    PERMISSIONS: {},
    RESULTS: { GRANTED: 'granted', DENIED: 'denied', NEVER_ASK_AGAIN: 'never_ask_again' },
  },

  // ── app lifecycle / a11y ──────────────────────────────────────────────
  AppState: appState,
  AccessibilityInfo: accessibilityInfo,
  InteractionManager: {
    runAfterInteractions: (cb: () => void) => {
      cb();
      return { cancel: () => undefined };
    },
  },
  DeviceEventEmitter: {
    addListener: () => ({ remove: () => undefined }),
    emit: () => undefined,
    removeAllListeners: () => undefined,
  },
  TurboModuleRegistry: { get: () => undefined, getEnforcing: () => undefined },
  AppRegistry: { registerComponent: () => undefined, registerRunnable: () => undefined },

  // ── motion ────────────────────────────────────────────────────────────
  Animated: animated,
  Easing: {
    linear: (t: number) => t,
    in: (t: number) => t,
    out: (t: number) => t,
    inOut: (t: number) => t,
  },

  // ── share / links / haptics ───────────────────────────────────────────
  Share: { share: async () => ({ dismissedAction: true }) },
  Linking: {
    openURL: async () => undefined,
    canOpenURL: async () => false,
    getInitialURL: async () => null,
    addEventListener: () => ({ remove: () => undefined }),
  },
  Vibration: { vibrate: () => undefined, cancel: () => undefined },
};

export function rnMockSurface(overrides: Surface = {}): Surface {
  return { ...FULL_SURFACE, ...overrides };
}

/** The key list the lock suite pins (a key dropped from the surface is
 *  a RED, not a silent regression). */
export const RN_SURFACE_KEYS = Object.keys(FULL_SURFACE).sort();
