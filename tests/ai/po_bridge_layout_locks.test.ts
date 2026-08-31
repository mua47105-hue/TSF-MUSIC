/**
 * R7 PO-BRIDGE LAYOUT LOCKS — the half-screen bug (v3.4.0 → v3.4.3).
 *
 * FIELD FAILURE (itel P55 phone + OPPO Pad Air tablet + two Samsung
 * tablets, portrait AND landscape, all at EXACTLY 50%): the whole app
 * rendered in the top half of the screen with the bottom nav bar
 * floating mid-screen and a uniform RGB(10,10,10) void (the raw
 * windowBackground #0A0A0B) below. Onboarding was unaffected (native
 * Modal), the RN-web build was unaffected (bridge renders null) — a
 * native-only, app-shell-level layout halving.
 *
 * ROOT CAUSE: react-native-webview v14's Android render is
 *   <View style={[{flex:1, overflow:'hidden'}, containerStyle]}>
 *     <NativeWebView style={[{flex:1}, {backgroundColor:'#fff'}, style]} />
 *   </View>
 * The caller's `style` lands ONLY on the inner native WebView; the OUTER
 * wrapper is sized by `containerStyle` and DEFAULTS TO flex:1 IN-FLOW.
 * YtPoTokenBridge mounted with position:absolute on `style` alone, so an
 * invisible flex:1 wrapper sat as a sibling of the entire app under
 * SafeAreaProvider's flex:1 View — Yoga split the screen 50/50.
 *
 * THE LOCKS BELOW render the REAL bridge through a FAITHFUL replica of
 * v14's wrapper (the same style-merge shape, verified against
 * node_modules/react-native-webview@14.0.1 lib/WebView.android.js) and
 * assert the wrapper the library would create is OUT-OF-FLOW. A mount
 * that leaks ANY in-flow wrapper at the app-root level can never ship
 * again.
 */

import { describe, expect, test, mock, beforeAll } from 'bun:test';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── faithful v14 wrapper replica ──────────────────────────────────────
// The exact default styles react-native-webview v14 applies (WebView.styles.js:
// container = {flex:1, overflow:'hidden'}, webView = {backgroundColor:'#ffffff'}).

const V14_DEFAULT_CONTAINER = { flex: 1, overflow: 'hidden' };

/** Records every view the mock tree creates (style arrays flattened the
 *  way RN's StyleSheet.flatten merges them: later entries win per key). */
const recorded: Array<{ kind: string; flat: Record<string, unknown> }> = [];

function flatten(styles: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(styles)) styles = [styles];
  for (const s of styles as unknown[]) {
    if (s && typeof s === 'object') Object.assign(out, s);
  }
  return out;
}

// v14's WebView.styles.js defaults, verbatim
const V14_DEFAULT_WEBVIEW_BG = { backgroundColor: '#ffffff' };

const ViewMock = (props: any) => {
  recorded.push({ kind: 'view', flat: flatten(props?.style) });
  return props?.children ?? null;
};

/** Byte-faithful structural replica of WebView.android.js v14: the outer
 *  View is sized by containerStyle (defaults flex:1!), the inner native
 *  WebView by `style`. The bridge's layout contract lives in this shape. */
function WebViewV14(props: any) {
  const { style, containerStyle } = props;
  return React.createElement(
    ViewMock,
    { style: [V14_DEFAULT_CONTAINER, containerStyle] },
    React.createElement(function NativeWebViewMock(p: any) {
      recorded.push({ kind: 'webview', flat: flatten(p?.style) });
      return null;
    }, { style: [V14_DEFAULT_CONTAINER, V14_DEFAULT_WEBVIEW_BG, style as any] })
  );
}

mock.module('react-native', () => ({
  Platform: { OS: 'android', select: (o: any) => o?.android },
}));
mock.module('react-native-webview', () => ({
  WebView: WebViewV14,
}));

// import the REAL bridge AFTER the mocks are installed
const { YtPoTokenBridge } = await import('../../src/api/ytPoToken');

/** In-flow in Yoga = participates in the parent's flex layout. Only
 *  absolute positioning takes a node out of flow (relative STAYS in flow
 *  — it is merely offset). */
function isInFlow(flat: Record<string, unknown>): boolean {
  return flat.position !== 'absolute';
}

describe('R7 — the bridge through the faithful v14 wrapper', () => {
  beforeAll(() => {
    recorded.length = 0;
  });

  test('the wrapper the library creates for the bridge is OUT-OF-FLOW (absolute, sub-pixel)', () => {
    recorded.length = 0;
    renderToString(React.createElement(YtPoTokenBridge));
    const wrappers = recorded.filter((r) => r.kind === 'view');
    expect(wrappers.length).toBe(1);
    const w = wrappers[0].flat;
    // the exact invariant that was violated for four releases
    expect(w.position).toBe('absolute');
    expect(w.width).toBe(1);
    expect(w.height).toBe(1);
    expect(isInFlow(w)).toBe(false);
  });

  test('the inner native WebView fills its sub-pixel wrapper, transparent', () => {
    recorded.length = 0;
    renderToString(React.createElement(YtPoTokenBridge));
    const inner = recorded.filter((r) => r.kind === 'webview');
    expect(inner.length).toBe(1);
    const s = inner[0].flat;
    expect(s.flex).toBe(1);
    // transparent MUST override the library's default #ffffff — the
    // webview would otherwise paint a visible white pixel at (0,0)
    expect(s.backgroundColor).toBe('transparent');
    // the old broken mount put position:absolute HERE (inner view) —
    // it must live on the CONTAINER now, never on the inner view
    expect(s.position).toBeUndefined();
  });

  test('MECHANISM LOCK: the v14 wrapper with the OLD style-only mount is in-flow (the bug, documented)', () => {
    recorded.length = 0;
    // what the bridge used to pass before v3.4.4: absolute on `style` only
    renderToString(
      React.createElement(WebViewV14, {
        style: { width: 1, height: 1, opacity: 0.01, position: 'absolute' },
      })
    );
    const w = recorded.find((r) => r.kind === 'view')!.flat;
    // the library default flex:1 wins the wrapper → in-flow → 50/50 split.
    // This is WHY four manifest-level "fixes" (v3.4.0–v3.4.3) did nothing.
    expect(w.flex).toBe(1);
    expect(isInFlow(w)).toBe(true);
  });

  test('MECHANISM LOCK: containerStyle alone (even without the host wrapper) takes the wrapper out of flow', () => {
    recorded.length = 0;
    renderToString(
      React.createElement(WebViewV14, {
        style: { flex: 1, backgroundColor: 'transparent' },
        containerStyle: { position: 'absolute', width: 1, height: 1, top: 0, left: 0, opacity: 0.01 },
      })
    );
    const w = recorded.find((r) => r.kind === 'view')!.flat;
    expect(w.position).toBe('absolute');
    expect(isInFlow(w)).toBe(false);
  });
});

// ── library-drift guard: the replica above mirrors the INSTALLED
// react-native-webview. If an upgrade changes the wrapper shape, this
// lock fires so the replica (and the whole R7 contract) gets revisited
// — the absolute host belt in PlayerProvider keeps the app safe either
// way, but silent drift must never go unnoticed. ───────────────────────

describe('R7 — installed-library shape guard', () => {
  const libAndroid = readFileSync(
    join(__dirname, '../../node_modules/react-native-webview/lib/WebView.android.js'),
    'utf8'
  );

  test('v14 still wraps: outer View gets [container, containerStyle], inner gets style', () => {
    expect(libAndroid).toMatch(/webViewContainerStyle=\[_WebView\.default\.container,containerStyle\]/);
    expect(libAndroid).toMatch(/webViewStyles=\[_WebView\.default\.container,_WebView\.default\.webView,style\]/);
  });

  test('v14 default container is still flex:1 in-flow (the hazard this file locks against)', () => {
    const styles = readFileSync(
      join(__dirname, '../../node_modules/react-native-webview/lib/WebView.styles.js'),
      'utf8'
    );
    expect(styles).toMatch(/container:\{flex:1,overflow:'hidden'\}/);
  });
});

// ── source-contract locks (protect against silent regressions of the
//    double-belt mount: containerStyle in the bridge + absolute host in
//    PlayerProvider) ────────────────────────────────────────────────────

const SRC = (p: string) => readFileSync(join(__dirname, '../../src', p), 'utf8');

describe('R7 — source contracts (the double belt)', () => {
  test('ytPoToken.tsx mounts with an out-of-flow containerStyle', () => {
    const src = SRC('api/ytPoToken.tsx');
    expect(src).toMatch(/containerStyle\s*=\s*\{\s*\{?\s*\n?\s*position:\s*'absolute'/);
    const cs = src.match(/containerStyle\s*=\s*\{\s*\{?([\s\S]*?)\n?\s*\}\s*\}/)?.[1] ?? '';
    expect(cs).toContain("width: 1");
    expect(cs).toContain("height: 1");
    // binary-verification marker: the testID survives Hermes minification
    // as a string literal and is unique to this mount (library prop names
    // like containerStyle appear in the library's own bundled code and
    // cannot distinguish our call site)
    expect(src).toContain('testID="yt-po-token-webview"');
  });

  test('ytPoToken.tsx never again carries the broken style-only absolute mount', () => {
    const src = SRC('api/ytPoToken.tsx');
    expect(src).not.toMatch(/style=\{\{\s*width:\s*1,\s*height:\s*1,\s*opacity:\s*0\.01,\s*position:\s*'absolute'\s*\}\}/);
  });

  test('PlayerProvider hosts the bridge in an absolute, touch-transparent View', () => {
    const src = SRC('player/PlayerProvider.tsx');
    // the host wrapper exists and is wired to the bridge
    expect(src).toMatch(/<View style=\{styles\.poTokenHost\} pointerEvents="none">\s*\n\s*<YtPoTokenBridge \/>/);
    // the host style itself is out-of-flow by construction
    const host = src.match(/poTokenHost:\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    expect(host).toContain("position: 'absolute'");
    expect(host).toContain("width: 1");
    expect(host).toContain("height: 1");
  });
});
