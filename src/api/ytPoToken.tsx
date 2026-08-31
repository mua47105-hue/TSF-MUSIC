/**
 * YT PO-TOKEN MINTER — the hidden-WebView BotGuard engine (lab.3).
 *
 * YouTube's player endpoint rejects unattested web traffic ("Sign in to
 * confirm you're not a bot"). The fix every shipping Android player uses
 * (NewPipe PoTokenWebView, Metrolist): run BotGuard inside a WebView on
 * the youtube.com origin and mint Proof-of-Origin tokens. This module is
 * the RN port of the flow PROVEN live from the lab sandbox (worklog
 * Task 11): homepage (ytcfg + ytAtN) challenge pair → interpreter via
 * script-tag → VM snapshot → WAA GenerateIT (ROTATED request key) →
 * webPo minter → 128-byte tokens.
 *
 * Division of labor: this module MINTS (visitor-bound session pot +
 * per-videoId player pots). src/api/youtube.ts consumes them through
 * setPoTokenProvider() and owns every player request + deciphering.
 *
 * Kill-switch discipline: the bridge never blocks the JioSaavn core —
 * every entry point resolves null on any failure, within timeouts.
 */

import React, { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
// rn-webview's IOS&Android&Windows props intersection degrades to `never`
// under TS strict — cast to a permissive component type (runtime API is
// identical across the props we use).
import { WebView as RNWebView, type WebViewMessageEvent } from 'react-native-webview';
import { setPoTokenProvider, type YtPoTokenPair } from './youtube';

const WebView = RNWebView as unknown as React.FunctionComponent<any>;

/** The minter only exists on native — rn-webview's web fallback renders a
 *  visible "does not support this platform" error block that overlays the
 *  UI (and its container eats pointer events). Never mount it on web. */
const IS_WEB = Platform.OS === 'web';

// ── the page-side engine (runs INSIDE the WebView, youtube.com origin) ──

const PAGE_ENGINE = `
(function () {
  'use strict';
  var STATE = { ready: false, minting: false, cb: null, token: null, visitorData: '', expiresAt: 0 };

  function send(obj) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(obj)); } catch (e) {}
  }
  function b64url(u8) {
    var s = '';
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }
  function b64ToU8(b64) {
    var norm = b64.replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(norm);
    var u8 = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
    return u8;
  }
  function bytesOf(str) { return new TextEncoder().encode(str); }

  // balanced-brace object extraction (JS object literal inside the page)
  function extractCallArg(page, marker, requireDirectBrace) {
    var from = 0;
    while (true) {
      var start = page.indexOf(marker, from);
      if (start < 0) return null;
      var openIdx = start + marker.length - 1;
      if (requireDirectBrace) {
        var after = page.slice(openIdx + 1, openIdx + 12).replace(/^\\s+/, '');
        if (after.charAt(0) !== '{') { from = start + marker.length; continue; }
      }
      var objStart = page.indexOf('{', openIdx);
      var depth = 0, inStr = false, q = '', esc = false;
      for (var i = objStart; i < page.length; i++) {
        var c = page.charAt(i);
        if (esc) { esc = false; continue; }
        if (c === '\\\\') { esc = true; continue; }
        if (inStr) { if (c === q) inStr = false; continue; }
        if (c === "'" || c === '"') { inStr = true; q = c; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return page.slice(objStart, i + 1); }
      }
      return null;
    }
  }

  async function loadSession() {
    if (STATE.cb && Date.now() < STATE.expiresAt) return;
    var page = await fetch('https://www.youtube.com/', { credentials: 'include' }).then(function (r) { return r.text(); });
    var ytcfgArg = extractCallArg(page, 'ytcfg.set(', true);
    if (!ytcfgArg) throw new Error('no ytcfg in homepage');
    var cfg = (new Function('return (' + ytcfgArg + ')'))();
    window.yt = { config_: cfg }; // BotGuard reads yt.config_
    STATE.visitorData = (cfg && cfg.INNERTUBE_CONTEXT && cfg.INNERTUBE_CONTEXT.client && cfg.INNERTUBE_CONTEXT.client.visitorData) || '';
    var ytAtArg = extractCallArg(page, 'window.ytAtN({', false);
    if (!ytAtArg) throw new Error('no ytAtN challenge in homepage');
    var attData = (new Function('return (' + ytAtArg + ')'))();
    var attestation = typeof attData.R === 'string' ? JSON.parse(attData.R) : attData.R;
    var bgc = attestation && attestation.bgChallenge;
    if (!bgc || !bgc.program || !bgc.interpreterUrl) throw new Error('ytAtN missing bgChallenge');

    // interpreter via classic script tag (same JS the web player loads)
    var iu = bgc.interpreterUrl.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
    await new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = (iu.indexOf('//') === 0 ? 'https:' : '') + iu;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('interpreter script failed')); };
      document.head.appendChild(s);
    });
    if (!window[bgc.globalName]) throw new Error('vm global missing after script');

    // VM snapshot (port of the BotGuard client invoke protocol)
    var vm = window[bgc.globalName];
    STATE.cb = await new Promise(function (resolve, reject) {
      var settled = false;
      var timeout = setTimeout(function () { if (!settled) { settled = true; reject(new Error('vm setup timeout')); } }, 10000);
      try {
        vm.a(bgc.program, function (asyncSnapshot, shutdown, passEvent, checkCamera) {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(asyncSnapshot);
        }, true, undefined, function () {}, [[], []], undefined, false, [function () {}, function () {}, function () {}, function () {}, function () {}]);
      } catch (e) { settled = true; clearTimeout(timeout); reject(e); }
    });
    STATE.token = null;
    STATE.expiresAt = Date.now() + 11 * 60 * 60 * 1000;
  }

  async function ensureToken() {
    if (STATE.token && Date.now() < STATE.expiresAt) return STATE.token;
    var out = [];
    var resp = await new Promise(function (resolve, reject) {
      var timeout = setTimeout(function () { reject(new Error('snapshot timeout')); }, 10000);
      try {
        STATE.cb(function (r) { clearTimeout(timeout); resolve(r); }, [undefined, undefined, out, undefined]);
      } catch (e) { clearTimeout(timeout); reject(e); }
    });
    var gen = await fetch('https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/GenerateIT', {
      method: 'POST',
      headers: { 'content-type': 'application/json+protobuf', 'x-goog-api-key': 'AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw', 'x-user-agent': 'grpc-web-javascript/0.1' },
      body: JSON.stringify(['O43z0dpjhgX20SCx4KAo', resp]),
    }).then(function (r) { return r.json(); });
    var token = gen && gen[0];
    if (!token) throw new Error('GenerateIT returned no token');
    var getMinter = out[0];
    if (!getMinter) throw new Error('VM emitted no webPo minter');
    STATE.token = await getMinter(b64ToU8(token));
    if (typeof STATE.token !== 'function') throw new Error('minter not a function');
    return STATE.token;
  }

  async function mint(binding) {
    await loadSession();
    var minter = await ensureToken();
    var pot = b64url(await minter(bytesOf(binding)));
    if (!pot || pot.length < 16) throw new Error('mint produced empty token');
    return pot;
  }

  async function handle(req) {
    try {
      if (req.type === 'yt-mint-session') {
        await loadSession();
        var webPot = await mint(STATE.visitorData);
        send({ type: 'yt-session', reqId: req.reqId, visitorData: STATE.visitorData, webPot: webPot });
        return;
      }
      if (req.type === 'yt-mint-player') {
        var pot = await mint(req.videoId);
        send({ type: 'yt-player-pot', reqId: req.reqId, videoId: req.videoId, pot: pot });
        return;
      }
      send({ type: 'yt-error', reqId: req.reqId, error: 'unknown request type' });
    } catch (e) {
      // a failed session setup poisons the VM state — force full reload next time
      STATE.cb = null; STATE.token = null; STATE.expiresAt = 0;
      send({ type: 'yt-error', reqId: req.reqId, error: String((e && e.message) || e).slice(0, 120) });
    }
  }

  window.__ytOnMsg = function (raw) {
    try { handle(typeof raw === 'string' ? JSON.parse(raw) : raw); } catch (e) { send({ type: 'yt-error', error: String(e).slice(0, 120) }); }
  };
  document.addEventListener('message', function (ev) { window.__ytOnMsg(ev.data); });
  window.addEventListener('message', function (ev) { if (ev.data && ev.data !== '[object Object]') window.__ytOnMsg(ev.data); });
  send({ type: 'yt-page-live' });
})();
`;

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8" /></head><body><script>${PAGE_ENGINE}</script></body></html>`;

// ── the RN bridge ──

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();
let webviewRef: { current: any } | null = null;
let pageLive = false;
let cachedPair: { visitorData: string; webPot: string; expiresAt: number } | null = null;
/** CRITIC P2-2 — single-flight mint: ytSearchMusic fires TWO parallel
 *  WEB_REMIX probes; both await poTokenProvider(). Without this mutex
 *  a cold session minted the session pair TWICE (2× homepage fetch,
 *  2× BotGuard VM, 2× GenerateIT) and the failure path of one mint
 *  reset state mid-flight of the other. Concurrent callers now share
 *  ONE in-flight promise. */
let mintInFlight: Promise<void> | null = null;
let reqSeq = 0;

function callPage(payload: Record<string, unknown>): void {
  const ref = webviewRef?.current;
  if (!ref) return;
  ref.injectJavaScript(`window.__ytOnMsg(${JSON.stringify(JSON.stringify(payload))}); true;`);
}

function request(payload: Record<string, unknown>, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const reqId = `r${(reqSeq += 1)}_${Date.now()}`;
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error('ytPoToken request timeout'));
    }, timeoutMs);
    pending.set(reqId, { resolve, reject, timer });
    callPage({ ...payload, reqId });
  });
}

function handleMessage(ev: WebViewMessageEvent): void {
  let msg: any;
  try {
    msg = JSON.parse(String(ev.nativeEvent.data));
  } catch {
    return;
  }
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'yt-page-live') {
    pageLive = true;
    return;
  }
  const p = pending.get(msg.reqId);
  if (!p) return;
  pending.delete(msg.reqId);
  clearTimeout(p.timer);
  if (msg.type === 'yt-error') p.reject(new Error(String(msg.error ?? 'ytPoToken error')));
  else p.resolve(msg);
}

/** The hidden WebView — mount ONCE near the app root (PlayerProvider). */
export function YtPoTokenBridge(): JSX.Element | null {
  const ref = useRef<any>(null);
  useEffect(() => {
    if (IS_WEB) return; // no WebView on web — the provider stays null
    webviewRef = ref;
    // wire the minter into youtube.ts the moment this mounts
    setPoTokenProvider(async (): Promise<YtPoTokenPair | null> => {
      if (!pageLive) return null;
      try {
        const now = Date.now();
        if (!cachedPair || now >= cachedPair.expiresAt) {
          mintInFlight ??= (async () => {
            try {
              const s = await request({ type: 'yt-mint-session' }, 20000);
              cachedPair = { visitorData: String(s.visitorData ?? ''), webPot: String(s.webPot ?? ''), expiresAt: Date.now() + 11 * 60 * 60 * 1000 };
            } finally {
              mintInFlight = null;
            }
          })();
          await mintInFlight;
        }
        const pair = cachedPair;
        if (!pair) return null; // mint failed — callers run tokenless (ladder handles it)
        return {
          visitorData: pair.visitorData,
          webPot: pair.webPot,
          mintPlayerPot: async (videoId: string) => {
            try {
              if (!pageLive) return null;
              const r = await request({ type: 'yt-mint-player', videoId }, 12000);
              return String(r.pot ?? '') || null;
            } catch {
              return null;
            }
          },
        };
      } catch {
        return null;
      }
    });
    return () => {
      if (webviewRef === ref) webviewRef = null;
    };
  }, []);
  if (IS_WEB) return null;
  return (
    <WebView
      ref={ref}
      source={{ html: PAGE_HTML, baseUrl: 'https://www.youtube.com' }}
      // R7 LAYOUT CONTRACT — the v3.4.0–v3.4.3 half-screen bug.
      // react-native-webview v14 renders
      //   <View style={[{flex:1,overflow:'hidden'}, containerStyle]}>
      //     <NativeWebView style={[{flex:1},{backgroundColor:'#fff'}, style]}/>
      //   </View>
      // — `style` lands ONLY on the inner native WebView. The OUTER wrapper
      // is sized by `containerStyle` and DEFAULTS TO flex:1 IN-FLOW. This
      // bridge used to carry position:absolute on `style` alone, leaving a
      // flex:1 transparent wrapper as a sibling of the entire app under
      // SafeAreaProvider's flex:1 View — Yoga split the screen 50/50 on
      // every Android device (app top half, bottom nav mid-screen, void
      // below). BOTH levels must be out-of-flow: containerStyle here, plus
      // the absolute host View in PlayerProvider (poTokenHost) as the
      // second, library-version-proof belt.
      style={{ flex: 1, backgroundColor: 'transparent' }}
      containerStyle={{
        position: 'absolute',
        width: 1,
        height: 1,
        top: 0,
        left: 0,
        opacity: 0.01,
      }}
      testID="yt-po-token-webview"
      originWhitelist={['*']}
      javaScriptEnabled
      domStorageEnabled
      onMessage={handleMessage}
      onError={() => {
        /* synthetic-key errors etc — the provider resolves null, ladder carries */
      }}
      onHttpError={() => undefined}
      setSupportMultipleWindows={false}
      pointerEvents="none"
    />
  );
}

/** Test/dev hook. */
export function resetYtPoTokenBridge(): void {
  pending.forEach((p) => {
    clearTimeout(p.timer);
    p.reject(new Error('bridge reset'));
  });
  pending.clear();
  pageLive = false;
  cachedPair = null;
  mintInFlight = null; // CRITIC P2-2: a stale in-flight mint must not resolve into the reset state
  webviewRef = null;
}
