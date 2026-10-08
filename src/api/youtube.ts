/**
 * THE SUPPLEMENTAL SOURCE — minimal on-device client (see docs/SUPPLEMENTAL-CATALOG-RFC.md).
 *
 * Pinned technique from the OSS ecosystem (NewPipe / youtubei.js / FreeTube),
 * built as our own ~300 LOC module so YouTube breakage can never touch the
 * JioSaavn core:
 *
 *   search   → WEB_REMIX (YT Music) catalog — verified working client-side
 *              with Song/Video/Album entities (research/youtube probes)
 *   stream   → client ladder over the `player` endpoint; the first client
 *              whose streamingData carries a direct audio URL wins. Data-
 *              driven order: a client that bot-walls ("LOGIN_REQUIRED")
 *              or returns DRM-only formats is skipped, never fatal.
 *   refresh  → googlevideo URLs are IP-bound + time-limited — same
 *              stale-URL recovery pattern as the saavn client.
 *   kill     → 3 consecutive stream failures soft-disable the source for
 *              1 h (auto-retry); `ytAvailable()` gates every entry point.
 *
 * PO tokens: the ladder accepts an optional injected token provider
 * (`setPoTokenProvider`) — the hidden-WebView minter lands as P2 without
 * touching this file's structure.
 */

import type { Track } from '../types';
import { recordingKey, reconcileRecordings } from './recording';

// ── client registry (ONE place to update when YouTube rotates shapes) ──
// Refreshed 2026-02 against the OSS playback ecosystem (yt-dlp PO-Token-Guide
// Jul-2026 edition, NewPipeExtractor dev ClientsConstants, Metrolist
// innertubex PlaybackClientCatalog benchmarks):
//
//   VISIONOS     1.04  — tokenless, PRE-SIGNED plain URLs, no decipher.
//                       The production client for NewPipe + yt-dlp default.
//                       Works from residential IPs; bot-walled from DCs.
//   WEB_REMIX    current — needs a BotGuard PO token (player+GVS) AND
//                       signatureCipher deciphering — served by the hidden
//                       WebView minter (ytPoToken.ts) when mounted.
//   ANDROID_VR   1.65.10 — tokenless plain URLs but dying (selective 403s
//                       since 2026.07); kept as a free last rung.
//
// The old IOS/ANDROID 19.09 rungs are DEAD (HTTP 400 version rejection) and
// TVHTML5_SIMPLY_EMBEDDED_PLAYER 2.0 is retired ("no longer supported").

interface YtClient {
  name: string;
  clientName: string;
  clientVersion: string;
  apiKey: string;
  userAgent: string;
  extraContext?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** needs a BotGuard PO token from the WebView minter before firing */
  needsPoToken?: boolean;
  /** requests go to music.youtube.com (WEB_REMIX origin rules) */
  musicOrigin?: boolean;
}

const YT_CLIENTS: YtClient[] = [
  {
    name: 'VISIONOS',
    clientName: 'VISIONOS',
    clientVersion: '1.04',
    apiKey: '',
    userAgent:
      'com.google.visionos.youtube/1.04(RealityDevice17,1; U; CPU visionOS 26_6_0 like Mac OS X; IN)',
    extraContext: {
      clientScreen: 'WATCH',
      deviceMake: 'Apple',
      deviceModel: 'RealityDevice17,1',
      osName: 'visionOS',
      osVersion: '26.6.0.23O770',
    },
  },
  {
    name: 'WEB_REMIX',
    clientName: 'WEB_REMIX',
    clientVersion: '1.20260707.12.00',
    apiKey: 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
    needsPoToken: true,
    musicOrigin: true,
  },
  {
    name: 'ANDROID_VR',
    clientName: 'ANDROID_VR',
    clientVersion: '1.65.10',
    apiKey: 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w',
    userAgent:
      'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    extraContext: {
      deviceMake: 'Oculus',
      deviceModel: 'Quest 3',
      osName: 'Android',
      osVersion: '12L',
      androidSdkVersion: 32,
    },
  },
];

const YTI = 'https://www.youtube.com/youtubei/v1';
const GL = 'IN';
const HL = 'en';

/** Injectable fetch (tests stub this; runtime uses global fetch). */
let ytFetch: typeof fetch = (input, init) => fetch(input as any, init as any);
export function setYtFetch(fn: typeof fetch | null): void {
  ytFetch = (fn ?? ((input, init) => fetch(input as any, init as any))) as typeof fetch;
}

/** PO-token provider — the hidden-WebView minter (ytPoToken.ts) plugs in
 *  here. Returns the SESSION PAIR: the visitorData the challenge was served
 *  with + the visitor-bound web pot (GVS). A videoId-bound player pot is
 *  minted per request by the provider itself. */
export interface YtPoTokenPair {
  visitorData: string;
  webPot: string;
  mintPlayerPot: (videoId: string) => Promise<string | null>;
}
let poTokenProvider: (() => Promise<YtPoTokenPair | null>) | null = null;
export function setPoTokenProvider(fn: (() => Promise<YtPoTokenPair | null>) | null): void {
  poTokenProvider = fn;
}

// ── session (visitorData bootstrap — the challenge/token pairing anchor) ──

let sessionVisitorData: string | null = null;
let sessionVisitorAt = 0;
const SESSION_TTL_MS = 3 * 60 * 60 * 1000; // visitorData lives long; refresh 3h

let sessionInFlight: Promise<string> | null = null;

async function ensureSession(): Promise<string> {
  const now = Date.now();
  if (sessionVisitorData && now - sessionVisitorAt < SESSION_TTL_MS) return sessionVisitorData;
  // CRITIC P2-2: ytSearchMusic's two parallel probes both land here —
  // single-flight the visitor_id POST so a cold search warms ONE session.
  if (sessionInFlight) return sessionInFlight;
  sessionInFlight = (async () => {
  try {
    const res = await ytFetch(`${YTI}/visitor_id?prettyPrint=false`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': YT_CLIENTS[0].userAgent,
        'X-Goog-Api-Format-Version': '2',
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: YT_CLIENTS[0].clientName,
            clientVersion: YT_CLIENTS[0].clientVersion,
            hl: HL,
            gl: GL,
            ...(YT_CLIENTS[0].extraContext ?? {}),
          },
        },
      }),
    });
    const j = await res.json();
    const v = j?.responseContext?.visitorData ?? '';
    if (v) {
      sessionVisitorData = v;
      sessionVisitorAt = now;
    }
  } catch {
    /* offline — proceed without a visitor; rungs handle it */
  } finally {
    sessionInFlight = null;
  }
  return sessionVisitorData ?? '';
  })();
  return sessionInFlight;
}
export function peekYtVisitorData(): string {
  return sessionVisitorData ?? '';
}
export function resetYtSession(): void {
  sessionVisitorData = null;
  sessionVisitorAt = 0;
}

// ── kill switch (YT bar 6: breakage can never degrade the core app) ──

const SOFT_DISABLE_MS = 60 * 60 * 1000;
const FAILURE_LIMIT = 3;
const ytState = { failures: 0, disabledUntil: 0 };

export function ytAvailable(now: number = Date.now()): boolean {
  return now >= ytState.disabledUntil;
}
export function noteYtFailure(now: number = Date.now()): void {
  ytState.failures += 1;
  if (ytState.failures >= FAILURE_LIMIT) {
    ytState.disabledUntil = now + SOFT_DISABLE_MS;
    ytState.failures = 0;
  }
}
export function noteYtSuccess(): void {
  ytState.failures = 0;
  ytState.disabledUntil = 0;
}
export function resetYtKillSwitch(): void {
  ytState.failures = 0;
  ytState.disabledUntil = 0;
}

// ── innertube plumbing ──

interface PlayerAudio {
  url: string;
  itag: number;
  bitrate: number;
  mime: string;
  expiresAt: number;
}

async function innertube(endpoint: string, client: YtClient, body: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  const visitor = await ensureSession();
  const context: any = {
    client: {
      clientName: client.clientName,
      clientVersion: client.clientVersion,
      hl: HL,
      gl: GL,
      ...(visitor ? { visitorData: visitor } : {}),
      ...(client.extraContext ?? {}),
    },
  };
  if (client.needsPoToken && poTokenProvider) {
    try {
      const pair = await poTokenProvider();
      if (pair) {
        if (pair.visitorData) context.client.visitorData = pair.visitorData;
        // the PLAYER pot is videoId-bound (web GVS policy); the session
        // (visitor-bound) pot covers search/att surfaces
        const playerPot = body.videoId ? await pair.mintPlayerPot(String(body.videoId)).catch(() => null) : null;
        const pot = playerPot ?? pair.webPot;
        if (pot) {
          context.client.poToken = pot;
          (body as any).serviceIntegrityDimensions = { poToken: pot };
        }
      }
    } catch {
      /* token is best-effort — the ladder handles rejection downstream */
    }
  }
  const host = client.musicOrigin ? 'https://music.youtube.com/youtubei/v1' : YTI;
  const keyQ = client.apiKey ? `key=${client.apiKey}&` : '';
  const res = await ytFetch(`${host}/${endpoint}?${keyQ}prettyPrint=false`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': client.userAgent,
      'X-Goog-Api-Format-Version': '2',
      ...(client.musicOrigin ? { Origin: 'https://music.youtube.com', Referer: 'https://music.youtube.com/' } : {}),
      'X-YouTube-Client-Name': clientNameIndex(client.clientName),
      'X-YouTube-Client-Version': client.clientVersion,
      ...(client.headers ?? {}),
    },
    body: JSON.stringify({ context, ...body }),
    signal,
  });
  if (!res.ok) throw new Error(`yt ${client.name} http ${res.status}`);
  return res.json();
}

function clientNameIndex(name: string): string {
  // InnerTube's X-YouTube-Client-Name numeric ids (youtubei.js reference)
  const map: Record<string, string> = {
    WEB: '1', MWEB: '2', ANDROID: '3', IOS: '5', TVHTML5: '7',
    WEB_REMIX: '67', ANDROID_VR: '28', ANDROID_TESTSUITE: '30',
    VISIONOS: '101',
  };
  return map[name] ?? '1';
}

// ── search v2 (R8-P2/P3: the songs-filter catalog, like YouTube Music) ──
//
// Ground truth (scripts/probe_yt_search_v2.ts, live WEB_REMIX probes):
//   • The GENERAL search's "top result" card (musicCardShelfRenderer)
//     carries lo-fi mixes / remixes / lyric videos for fuzzy queries —
//     "tu chaiye" put "TU CHAHIYE (Lo-Fi Mix): DJ Moody" at rank 1.
//     The old walker collected those rows first and toTrack's
//     kind-detection defaulted every unprefixed row to "song", so the
//     lo-fi mix outranked the real song. The card is now SKIPPED.
//   • The SONGS-FILTER search (the `params` YouTube Music itself sends
//     when the user taps the "Songs" chip) returns YouTube Music's
//     ranked catalog list — official recording first, 20 rows/page,
//     with a continuation token for page 2+. That list is the primary
//     result; the general search only supplements (videos, albums,
//     spell corrections, and the rotation-proof chip params).

/** Params for the Songs filter (ytmusicapi's pinned value, proven live
 *  2026-08 in the probe). If YouTube ever rotates it, the chip-params
 *  harvest below re-derives the current value from the response. */
const SONGS_FILTER_PARAMS = 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D';

/** Subtitle shapes WEB_REMIX emits (probe-verified):
 *   general rows : "Song • Pritam, Atif Aslam & Amitabh Bhattacharya • 3:51"
 *                  "Video • LYRICAL BAM HINDI • 6.2M views • 4:28"
 *   filtered rows: "Pritam, Atif Aslam & Amitabh Bhattacharya • Bajrangi Bhaijaan • 4:25"
 *                  (NO kind prefix — the first segment IS the artist) */
const KIND_WORDS = new Set([
  'song', 'video', 'album', 'single', 'ep', 'artist', 'playlist',
  'episode', 'podcast', 'profile', 'movie', 'radio',
]);
const VIDEO_KIND_WORDS = new Set(['video', 'episode', 'podcast', 'movie', 'radio']);

function parseDuration(text: string | undefined): number {
  if (!text) return 0;
  const parts = text.split(':').map((p) => parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p))) return 0;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

/** Parse a humanized count segment into a real number.
 *  "6.2M views" → 6_200_000 · "93K plays" → 93_000 · "943 views" → 943
 *  Indian-locale units too: "1.2 Cr" → 12_000_000 · "4.5 L" → 450_000.
 *  (The old `replace(/[^0-9.]/g,'')` turned "6.2M" into 6 — the rank
 *  engine's authority signal was reading thousandths of the truth.) */
export function parseHumanCount(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = text.replace(/,/g, '').match(/([\d.]+)\s*(lakh|crore|cr|k|m|b|l)?/i);
  if (!m || m[1] === '' || m[1] === '.') return undefined;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = (m[2] ?? '').toLowerCase();
  const mult =
    unit === 'k' ? 1e3 :
    unit === 'm' ? 1e6 :
    unit === 'b' ? 1e9 :
    unit === 'l' || unit === 'lakh' ? 1e5 :
    unit === 'cr' || unit === 'crore' ? 1e7 : 1;
  return Math.round(n * mult);
}

function firstVideoId(item: any): string | null {
  const text = JSON.stringify(item);
  const m = text.match(/"watchEndpoint":\{"videoId":"([\w-]{11})"/);
  return m ? m[1] : null;
}

function thumbFrom(renderer: any): string {
  const thumbs =
    renderer?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ??
    renderer?.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails ??
    [];
  const best = thumbs[thumbs.length - 1]?.url;
  return best ? best.replace(/^\/\//, 'https://') : '';
}

/** Map one YT-Music list item to a Track. Handles BOTH subtitle shapes:
 *  kind-prefixed (general search) and artist-first (songs filter). */
function toTrack(item: any): Track | null {
  const r = item?.musicResponsiveListItemRenderer;
  if (!r) return null;
  const runs = (col: number) =>
    r.flexColumns?.[col]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs ?? [];
  const title = runs(0)[0]?.text;
  const videoId = firstVideoId(r) ?? runs(0)[0]?.navigationEndpoint?.watchEndpoint?.videoId;
  if (!title || !videoId) return null;
  const subtitle = runs(1)
    .map((x: any) => x.text ?? '')
    .join('');
  const segs = subtitle.split('•').map((s: string) => s.trim());
  const firstSeg = segs[0] ?? '';
  const kindPrefixed = KIND_WORDS.has(firstSeg.toLowerCase());
  const kindWord = kindPrefixed ? firstSeg.toLowerCase() : '';
  const ytKind: 'song' | 'video' = VIDEO_KIND_WORDS.has(kindWord) ? 'video' : 'song';
  // kind-prefixed: "Song • ARTIST • duration" — artist is seg 1
  // artist-first  : "ARTIST • ALBUM • duration" — artist is seg 0
  const artistSeg = kindPrefixed ? (segs[1] ?? '') : firstSeg;
  // CRITIC P3-3: only the artist-first (filtered shelf) rows carry a real
  // ALBUM segment — kind-prefixed general rows are "Song • Artist • 3:51"
  // (seg 2 is the DURATION) or "Video • Channel • 6.2M views • 4:28"
  // (views) — writing those into track.album showed "Artist • 3:51".
  const albumSeg = !kindPrefixed ? segs[1] ?? '' : '';
  const durationSeg = [...segs].reverse().find((s: string) => /^\d{1,2}:\d{2}(:\d{2})?$/.test(s));
  const playsSeg = segs.find((s: string) => /views|plays/i.test(s));
  return {
    id: `yt-${videoId}`,
    youtubeId: videoId,
    ytKind,
    title,
    artist: artistSeg || 'YouTube',
    artistsFull: artistSeg
      ? artistSeg.split(/,|&/).map((a: string) => a.trim()).filter(Boolean)
      : undefined,
    album: albumSeg || undefined,
    artwork: thumbFrom(r),
    duration: parseDuration(durationSeg),
    source: 'youtube',
    previewOnly: false,
    playCount: playsSeg ? parseHumanCount(playsSeg) : undefined,
  } as unknown as Track;
}

/** Harvest the CURRENT filter-chip params from a general search response
 *  (rotation-proof: whatever YouTube serves today IS the right value). */
function chipParamsFor(data: any, labelRe: RegExp): string | undefined {
  const walk = (node: any): string | undefined => {
    if (!node || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) {
      for (const x of node) {
        const hit = walk(x);
        if (hit) return hit;
      }
      return undefined;
    }
    if (node.chipCloudRenderer) {
      for (const c of node.chipCloudRenderer.chips ?? []) {
        const cr = c?.chipCloudChipRenderer;
        const label = cr?.text?.runs?.[0]?.text ?? '';
        if (labelRe.test(label)) {
          const params = cr?.navigationEndpoint?.searchEndpoint?.params;
          if (typeof params === 'string') return params;
        }
      }
      return undefined;
    }
    for (const k of Object.keys(node)) {
      if (k === 'musicResponsiveListItemRenderer') continue;
      const hit = walk(node[k]);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(data);
}

/** YouTube's spell corrections:
 *  showingResultsFor → already applied to these results
 *  didYouMean        → NOT applied; surfaced for a "did you mean" note */
function spellCorrections(data: any): { correctedTo?: string; didYouMean?: string } {
  const out: { correctedTo?: string; didYouMean?: string } = {};
  const runs = (x: any) => (x?.runs ?? []).map((r: any) => r.text).join('');
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.showingResultsForRenderer) {
      out.correctedTo = runs(node.showingResultsForRenderer.correctedQuery) || out.correctedTo;
    }
    if (node.didYouMeanRenderer) {
      out.didYouMean = runs(node.didYouMeanRenderer.correctedQuery) || out.didYouMean;
    }
    for (const k of Object.keys(node)) walk(node[k]);
  };
  walk(data);
  return out;
}

/** Continuation token of the songs shelf (page 2+ of the filtered list). */
function songsContinuation(data: any): string | undefined {
  let token: string | undefined;
  const walk = (node: any) => {
    if (!node || typeof node !== 'object' || token) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.musicShelfRenderer) {
      for (const c of node.musicShelfRenderer.continuations ?? []) {
        const t = c?.nextContinuationData?.continuation;
        if (typeof t === 'string') {
          token = t;
          return;
        }
      }
    }
    for (const k of Object.keys(node)) walk(node[k]);
  };
  walk(data);
  return token;
}

/** Collect musicResponsiveListItemRenderer rows EXCLUDING the top-result
 *  card (musicCardShelfRenderer) — the card is the lo-fi/remix polluter
 *  on fuzzy queries, and every usable card row also appears in the
 *  songs/videos shelves (probe-verified). Returns raw rows. */
function collectRows(root: any): any[] {
  const rows: any[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    if (node.musicCardShelfRenderer) return; // skip the lo-fi polluter (R8-P2)
    if (node.musicResponsiveListItemRenderer) {
      rows.push(node);
      return;
    }
    for (const k of Object.keys(node)) walk(node[k]);
  };
  walk(root);
  return rows;
}

export interface YtSearchResult {
  tracks: Track[];
  albums: Array<{ title: string; browseId?: string; artist?: string }>;
  latencyMs: number;
  /** Continuation for `ytSearchMusicMore` — absent when the catalog is
   *  exhausted. Presence = the list can keep scrolling (R8-P3). */
  continuation?: string;
  /** YouTube already searched for this spelling ("showing results for"). */
  correctedTo?: string;
  /** YouTube suggests this spelling but did not use it ("did you mean"). */
  didYouMean?: string;
}

/** Parse a WEB_REMIX search response into tracks + albums. */
function parseSearchRows(data: any): { tracks: Track[]; albums: YtSearchResult['albums'] } {
  const tracks: Track[] = [];
  const albums: YtSearchResult['albums'] = [];
  const shelves =
    data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content
      ?.sectionListRenderer?.contents ?? [];
  const rows = shelves.length ? shelves.flatMap(collectRows) : collectRows(data);
  for (const row of rows) {
    const t = toTrack(row);
    if (t) tracks.push(t);
    const r = row.musicResponsiveListItemRenderer;
    const kind = (r?.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text ?? '')
      .split('•')[0]
      .trim()
      .toLowerCase();
    if (kind.startsWith('album') || kind.startsWith('single')) {
      const browse = r?.navigationEndpoint?.browseEndpoint?.browseId;
      if (browse) {
        albums.push({
          title:
            r?.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text ?? '',
          browseId: browse,
        });
      }
    }
  }
  return { tracks, albums };
}

/** YT-Music catalog search — the songs-filter list first (YouTube Music's
 *  own ranked answer: official recording at rank 1), the general search's
 *  videos after, albums surfaced separately. Recording-level dedup keeps
 *  one row per performance ("Tum Hi Ho • Aashiqui 2" absorbs the
 *  "Greatest Hits 3" re-list). Kill-switch gated (P1-3): a soft-disabled
 *  source answers empty immediately — no requests, honest fast degradation.
 *
 *  Both probes fire in PARALLEL (one round-trip of latency). If the pinned
 *  songs-filter params ever rot (0 rows) but the general response carries
 *  current chip params, one rotation retry re-fires with those. */
export async function ytSearchMusic(query: string, limit = 30, signal?: AbortSignal): Promise<YtSearchResult> {
  const t0 = Date.now();
  if (!ytAvailable()) return { tracks: [], albums: [], latencyMs: 0 };
  const remix = YT_CLIENTS.find((c) => c.name === 'WEB_REMIX')!;

  const [songsProbe, generalProbe] = await Promise.allSettled([
    innertube('search', remix, { query, params: SONGS_FILTER_PARAMS }, signal),
    innertube('search', remix, { query }, signal),
  ]);
  let songsData = songsProbe.status === 'fulfilled' ? songsProbe.value : null;
  const generalData = generalProbe.status === 'fulfilled' ? generalProbe.value : null;
  if (!songsData && !generalData) {
    return { tracks: [], albums: [], latencyMs: Date.now() - t0 };
  }

  // parse the songs probe ONCE (critic P3-2: no double full-JSON walk)
  let songsParsed = songsData ? parseSearchRows(songsData) : { tracks: [], albums: [] };

  // rotation guard (critic P3-1): the pinned params are dead when the
  // probe answers 0 rows OR rejects outright (HTTP 400 on rotation) — in
  // both cases the general response's chip params re-derive the current
  // value and one retry re-fires with those.
  if ((!songsData || songsParsed.tracks.length === 0) && generalData) {
    const chipParams = chipParamsFor(generalData, /^songs$/i);
    if (chipParams && chipParams !== SONGS_FILTER_PARAMS) {
      try {
        songsData = await innertube('search', remix, { query, params: chipParams }, signal);
        songsParsed = parseSearchRows(songsData);
      } catch {
        /* general-only is still a valid answer */
      }
    }
  }

  // primary: the ranked songs-filter list (continuation carries page 2+)
  const continuation = songsData ? songsContinuation(songsData) : undefined;

  // supplement: general search's videos + albums + corrections
  const generalParsed = generalData ? parseSearchRows(generalData) : { tracks: [], albums: [] };
  const corrections = generalData ? spellCorrections(generalData) : {};

  // songs first (YouTube Music's order — the official recording leads),
  // then the general search's videos (≤ 15 min, parseable duration)
  const songs = songsParsed.tracks.filter((t) => t.ytKind === 'song');
  const generalSongs = generalParsed.tracks.filter(
    (t) => t.ytKind === 'song' && (t.duration ?? 0) > 0 && (t.duration ?? 0) <= 15 * 60,
  );
  const videos = generalParsed.tracks.filter(
    (t) => t.ytKind !== 'song' && (t.duration ?? 0) > 0 && (t.duration ?? 0) <= 15 * 60,
  );

  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  const merged: Track[] = [];
  for (const t of [...songs, ...generalSongs, ...videos]) {
    const id = t.youtubeId!;
    if (seenIds.has(id)) continue;
    const key = recordingKey(t);
    if (seenKeys.has(key)) continue; // same performance, other catalog entity
    seenIds.add(id);
    seenKeys.add(key);
    merged.push(t);
  }
  // R8-P4b: catalog rows re-credit the same recording with a nested
  // credit list — "Kesariya | Arijit Singh, Pritam" vs "Kesariya |
  // Pritam, Arijit Singh, Amitabh Bhattacharya" (composer-first).
  // Nested-set reconciliation absorbs multi-artist flips/truncations;
  // singleton-vs-larger pairs collapse only when the lone artist leads
  // the larger row (the featured-artist guard — see recording.ts).
  const reconciled = reconcileRecordings(merged);

  const tracks = reconciled.slice(0, limit);
  // CRITIC P1-1: the continuation belongs to the SONGS SHELF, not to the
  // post-dedup merged length — key-dedup legitimately trims merged below
  // 20 ("tum hi ho" collapsed 2 catalog re-lists → 19 rows with a live
  // continuation). A FULL shelf page (18+) carrying a token means the
  // catalog goes deeper; the deep list must not silently die.
  const keepContinuation =
    !!continuation &&
    (songsParsed.tracks.length >= 18 || merged.length >= Math.min(limit, 20));
  return {
    tracks,
    albums: generalParsed.albums.slice(0, 6),
    latencyMs: Date.now() - t0,
    ...(keepContinuation ? { continuation } : {}),
    ...(corrections.correctedTo ? { correctedTo: corrections.correctedTo } : {}),
    ...(corrections.didYouMean ? { didYouMean: corrections.didYouMean } : {}),
  };
}

/** Page 2+ of a songs-filter search — the continuation the first call
 *  returned. Returns fresh rows (id + recording deduped within the page)
 *  and the next continuation when the catalog goes deeper. `error: true`
 *  marks a TRANSPORT failure (the caller keeps its token and retries —
 *  a network blip is not end-of-catalog, R8 gauntlet P1-1). */
export async function ytSearchMusicMore(
  continuation: string,
  limit = 30,
  signal?: AbortSignal,
): Promise<{ tracks: Track[]; continuation?: string; latencyMs: number; error?: boolean }> {
  const t0 = Date.now();
  if (!ytAvailable()) return { tracks: [], latencyMs: 0, error: true };
  const remix = YT_CLIENTS.find((c) => c.name === 'WEB_REMIX')!;
  let data: any;
  try {
    data = await innertube('search', remix, { continuation }, signal);
  } catch {
    // transport failure — the CALLER's token stays valid; report, don't lie
    return { tracks: [], latencyMs: Date.now() - t0, error: true };
  }
  // continuation responses omit the tabbed wrapper — rows sit directly
  // in continuationItems; the walker handles both shapes.
  const parsed = parseSearchRows(data);
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  const tracks: Track[] = [];
  for (const t of parsed.tracks) {
    const id = t.youtubeId!;
    if (seenIds.has(id)) continue;
    const key = recordingKey(t);
    if (seenKeys.has(key)) continue;
    seenIds.add(id);
    seenKeys.add(key);
    tracks.push(t);
  }
  const next = songsContinuation(data);
  return {
    tracks: tracks.slice(0, limit),
    ...(next ? { continuation: next } : {}),
    latencyMs: Date.now() - t0,
  };
}
// ── stream resolution (client ladder + health + diagnostics) ──

const streamCache = new Map<string, PlayerAudio>();
const STREAM_CACHE_MAX = 100;

function pickAudio(formats: any[]): PlayerAudio | null {
  const audios = formats
    .filter((f) => typeof f?.mimeType === 'string' && f.mimeType.startsWith('audio/') && typeof f?.url === 'string')
    .map((f) => ({
      url: f.url as string,
      itag: Number(f.itag) || 0,
      bitrate: Number(f.bitrate) || 0,
      mime: (f.mimeType as string).split(';')[0],
      expiresAt: Date.now() + 5.5 * 60 * 60 * 1000, // googlevideo expire ≈ 6h; refresh early
    }));
  if (audios.length === 0) return null;
  // prefer AAC m4a itag 140 (universal RNTP compat), then any m4a, then
  // webm/opus 251 (ExoPlayer decodes it), then highest bitrate of anything
  const m4a140 = audios.find((a) => a.itag === 140);
  if (m4a140) return m4a140;
  const m4a = audios.filter((a) => a.mime === 'audio/mp4').sort((a, b) => b.bitrate - a.bitrate);
  if (m4a[0]) return m4a[0];
  const opus = audios.filter((a) => a.mime === 'audio/webm').sort((a, b) => b.bitrate - a.bitrate);
  if (opus[0]) return opus[0];
  return audios.sort((a, b) => b.bitrate - a.bitrate)[0] ?? null;
}

export interface ResolveOutcome {
  ok: boolean;
  reason?: 'disabled' | 'bot-walled' | 'no-audio' | 'network';
  audio?: PlayerAudio;
  /** per-rung trail for the honest error surface + lab diagnostics */
  trail?: string[];
}

// per-client health: a client answered LOGIN_REQUIRED/UNPLAYABLE →
// skip it for a while (innertubex-style DisabledStreamClients)
const CLIENT_COOLDOWN_MS = 10 * 60 * 1000;
const clientHealth = new Map<string, { cooldownUntil: number; lastStatus: string }>();

// rolling diagnostics of the LAST resolution attempt (lab G1 evidence)
let lastTrail: string[] = [];
export function ytLastDiagnostics(): string[] {
  return lastTrail;
}

// ── signatureCipher deciphering (WEB_REMIX family returns obfuscated urls) ──

let decipherCache: { jsPath: string; fn: (s: string) => string } | null = null;

function balancedFrom(src: string, openIdx: number): string | null {
  let depth = 0, inStr = false, q = '', esc = false;
  for (let i = openIdx; i < src.length; i += 1) {
    const c = src[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (inStr) { if (c === q) inStr = false; continue; }
    if (c === "'" || c === '"') { inStr = true; q = c; continue; }
    if (c === '{' || c === '[' || c === '(') depth += 1;
    else if (c === '}' || c === ']' || c === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return null;
}

/** Build the decipher fn from the player JS (classic youtube-dl technique:
 *  the `X=function(a){a=a.split("")...}` fn + its helper object).
 *  P1-1 fix: assemble from the FULL source span (match-start → balanced
 *  body end) — the old `fnMatch[0] + fnSrc.slice(1)` concatenation ended
 *  the match fragment mid-statement and restarted the same statement from
 *  the body, producing `...a=a.split("")a=a.split("")...` → SyntaxError
 *  on EVERY invocation (the rung was silently dead code). */
async function getDecipherer(jsPath: string): Promise<(s: string) => string> {
  if (decipherCache && decipherCache.jsPath === jsPath) return decipherCache.fn;
  const res = await ytFetch(`https://www.youtube.com${jsPath}`);
  if (!res.ok) throw new Error(`player js http ${res.status}`);
  const js = await res.text();
  const fnMatch = js.match(/([\w$]{1,8})\s*=\s*function\(\s*([\w$]+)\s*\)\s*\{\s*\2\s*=\s*\2\.split\(\s*["']{2}\s*\)/);
  if (!fnMatch || fnMatch.index === undefined) throw new Error('decipher fn not found');
  const fnName = fnMatch[1];
  const param = fnMatch[2];
  const bodyStart = js.indexOf('{', fnMatch.index);
  const fnBody = balancedFrom(js, bodyStart);
  if (!fnBody) throw new Error('decipher fn body not found');
  const fullFn = js.slice(fnMatch.index, bodyStart + fnBody.length);
  // helper object referenced inside the fn body (first OBJ.member( usage
  // where OBJ is neither the param (`a.split(`) nor the fn itself)
  let objSrc = '';
  for (const ref of fnBody.matchAll(/([\w$]+)\.[\w$]+\s*\(/g)) {
    const objName = ref[1];
    if (objName === param || objName === fnName) continue;
    const declPatterns = [
      `var ${objName}=`,
      `,${objName}=`,
      `;${objName}=`,
      ` ${objName}=`,
      `let ${objName}=`,
      `const ${objName}=`,
    ];
    for (const pat of declPatterns) {
      const at = js.indexOf(pat);
      if (at >= 0) {
        const objOpen = js.indexOf('{', at + pat.length - 1);
        const objBody = objOpen >= 0 ? balancedFrom(js, objOpen) : null;
        if (objBody) {
          objSrc = `var ${objName}=${objBody};`;
          break;
        }
      }
    }
    if (objSrc) break;
  }
  // assemble: helper object decl + the fn VERBATIM from the source, then call it
  const fn = new Function('s', `${objSrc}${fullFn}; return ${fnName}(s);`) as (s: string) => string;
  decipherCache = { jsPath, fn };
  return fn;
}

/** Resolve signatureCipher entries to plain urls (WEB_REMIX family). */
async function resolveCipherFormats(player: any): Promise<any[]> {
  const formats = player?.streamingData?.adaptiveFormats ?? [];
  if (formats.some((f: any) => typeof f?.url === 'string' && f.url)) return formats;
  const jsPath: string | undefined = player?.assets?.js;
  if (!jsPath) return formats;
  try {
    const decipher = await getDecipherer(jsPath);
    return formats.map((f: any) => {
      const cipher = f.signatureCipher ?? f.cipher;
      if (!cipher || f.url) return f;
      const params = new URLSearchParams(cipher);
      const s = params.get('s');
      const sp = params.get('sp') ?? 'signature';
      const base = params.get('url');
      if (!s || !base) return f;
      return { ...f, url: `${base}&${sp}=${decipher(s)}` };
    });
  } catch {
    return formats;
  }
}

/** Resolve a playable audio URL for a video id (ladder + cache + health). */
export async function ytResolveStream(videoId: string, signal?: AbortSignal): Promise<ResolveOutcome> {
  if (!ytAvailable()) return { ok: false, reason: 'disabled' };
  const hit = streamCache.get(videoId);
  if (hit && Date.now() < hit.expiresAt) {
    streamCache.delete(videoId);
    streamCache.set(videoId, hit); // refresh recency
    return { ok: true, audio: hit };
  }
  const trail: string[] = [`resolve ${videoId} @${new Date().toISOString()}`];
  lastTrail = trail;
  const now = Date.now();
  // P1-3: failure accounting is class-aware — a per-video UNPLAYABLE or an
  // OK-but-no-audio verdict says the SOURCE is fine and this VIDEO is bad;
  // only systemic verdicts (LOGIN_REQUIRED walls / every client throwing)
  // count toward the global kill switch.
  let wallCount = 0;
  let videoVerdict = 0;
  let threwCount = 0;
  // clients skipped for cooldown — their lastStatus tells us WHICH failure
  // class put them there (a wall cooldown ≠ a per-video cooldown)
  const cooldownStatuses: string[] = [];
  const order = YT_CLIENTS.filter((c) => {
    const h = clientHealth.get(c.name);
    if (h && now < h.cooldownUntil) {
      trail.push(`${c.name}: SKIP (cooldown after ${h.lastStatus})`);
      cooldownStatuses.push(h.lastStatus);
      return false;
    }
    return true;
  });
  for (const client of order) {
    try {
      const player = await innertube(
        'player',
        client,
        { videoId, contentCheckOk: true, racyCheckOk: true },
        signal,
      );
      const status = player?.playabilityStatus?.status;
      trail.push(`${client.name}: ${status ?? 'no-status'}${player?.playabilityStatus?.reason ? ` (${player.playabilityStatus.reason})` : ''}`);
      if (status && status !== 'OK') {
        if (status === 'LOGIN_REQUIRED' || status === 'UNPLAYABLE') {
          clientHealth.set(client.name, { cooldownUntil: Date.now() + CLIENT_COOLDOWN_MS, lastStatus: status });
        }
        if (status === 'LOGIN_REQUIRED') wallCount += 1;
        else videoVerdict += 1; // UNPLAYABLE / ERROR …: this video, not the source
        continue; // bot-wall / unplayable → next rung
      }
      const formatsRaw = player?.streamingData?.adaptiveFormats ?? [];
      const formats = client.needsPoToken ? await resolveCipherFormats(player) : formatsRaw;
      const audio = pickAudio(formats);
      if (!audio) {
        trail.push(`${client.name}: OK but 0 direct audio urls`);
        videoVerdict += 1;
        continue;
      }
      trail.push(`${client.name}: RESOLVED itag ${audio.itag} ${audio.mime} ${audio.bitrate}bps`);
      streamCache.set(videoId, audio);
      if (streamCache.size > STREAM_CACHE_MAX) {
        const oldest = streamCache.keys().next().value;
        if (oldest !== undefined) streamCache.delete(oldest);
      }
      noteYtSuccess();
      return { ok: true, audio, trail };
    } catch (e) {
      threwCount += 1;
      trail.push(`${client.name}: threw ${String((e as Error)?.message ?? e).slice(0, 60)}`);
      // network/shape failure — try the next rung
    }
  }
  // P1-3: honest reason + class-aware kill switch.
  if (wallCount > 0 && videoVerdict === 0) {
    noteYtFailure(); // systemic bot-wall — the source is dead for us right now
    return { ok: false, reason: 'bot-walled', trail };
  }
  if (threwCount > 0 && wallCount === 0 && videoVerdict === 0) {
    noteYtFailure(); // every client threw (offline / shape break) — count it
    return { ok: false, reason: 'network', trail };
  }
  // every client still cooling down from a recent WALL: the wall persists
  // (rapid retries must count toward the switch, not erase the streak)
  if (order.length === 0 && cooldownStatuses.length > 0 && cooldownStatuses.every((s) => s === 'LOGIN_REQUIRED')) {
    noteYtFailure();
    return { ok: false, reason: 'bot-walled', trail };
  }
  if (videoVerdict > 0) {
    // live video-specific verdicts: the source is healthy, THIS row is bad
    noteYtSuccess();
    return { ok: false, reason: 'no-audio', trail };
  }
  // only per-video cooldowns remain — neutral: keep the streak, don't count
  return { ok: false, reason: 'no-audio', trail };
}

/** Stale-URL recovery for the background service (PlaybackError branch). */
export async function ytRefreshStream(track: Track): Promise<string | null> {
  const id = track.youtubeId ?? track.id.replace(/^yt-/, '');
  if (!id) return null;
  streamCache.delete(id);
  const out = await ytResolveStream(id).catch(() => ({ ok: false } as ResolveOutcome));
  return out.ok ? out.audio!.url : null;
}

/** Build a playable URL for an RN queue (PlayerProvider seam). */
export async function ytStreamUrlForTrack(track: Track): Promise<string | null> {
  const id = track.youtubeId ?? track.id.replace(/^yt-/, '');
  if (!id) return null;
  const out = await ytResolveStream(id).catch(() => ({ ok: false } as ResolveOutcome));
  return out.ok ? out.audio!.url : null;
}

/** Test hook — drain the in-memory caches between cases. */
export function clearYtCaches(): void {
  streamCache.clear();
  clientHealth.clear();
  lastTrail = [];
}
