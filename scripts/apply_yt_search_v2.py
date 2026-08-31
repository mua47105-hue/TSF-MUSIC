#!/usr/bin/env python3
"""Replace the search section (lines 267..413) of src/api/youtube.ts
with the R8-P2/P3 search v2 implementation."""
import io

PATH = '/home/z/my-project/src/api/youtube.ts'
with io.open(PATH, encoding='utf-8') as f:
    lines = f.readlines()

NEW = r'''// ── search v2 (R8-P2/P3: the songs-filter catalog, like YouTube Music) ──
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
  const albumSeg = kindPrefixed ? (segs[2] ?? '') : (segs[1] ?? '');
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

  // rotation guard: pinned params dead but the response carries current ones
  if (songsData && parseSearchRows(songsData).tracks.length === 0 && generalData) {
    const chipParams = chipParamsFor(generalData, /^songs$/i);
    if (chipParams && chipParams !== SONGS_FILTER_PARAMS) {
      try {
        songsData = await innertube('search', remix, { query, params: chipParams }, signal);
      } catch {
        /* general-only is still a valid answer */
      }
    }
  }

  // primary: the ranked songs-filter list (continuation carries page 2+)
  const songsParsed = songsData ? parseSearchRows(songsData) : { tracks: [], albums: [] };
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

  const tracks = merged.slice(0, limit);
  // if the limit already consumed everything AND the catalog has more
  // pages, keep the continuation so "load more" walks the deep list
  return {
    tracks,
    albums: generalParsed.albums.slice(0, 6),
    latencyMs: Date.now() - t0,
    ...(continuation && merged.length >= Math.min(limit, 20) ? { continuation } : {}),
    ...(corrections.correctedTo ? { correctedTo: corrections.correctedTo } : {}),
    ...(corrections.didYouMean ? { didYouMean: corrections.didYouMean } : {}),
  };
}

/** Page 2+ of a songs-filter search — the continuation the first call
 *  returned. Returns fresh rows (id + recording deduped within the page)
 *  and the next continuation when the catalog goes deeper. */
export async function ytSearchMusicMore(
  continuation: string,
  limit = 30,
  signal?: AbortSignal,
): Promise<{ tracks: Track[]; continuation?: string; latencyMs: number }> {
  const t0 = Date.now();
  if (!ytAvailable()) return { tracks: [], latencyMs: 0 };
  const remix = YT_CLIENTS.find((c) => c.name === 'WEB_REMIX')!;
  let data: any;
  try {
    data = await innertube('search', remix, { continuation }, signal);
  } catch {
    return { tracks: [], latencyMs: Date.now() - t0 };
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
'''

# replace lines 267..413 (1-indexed inclusive)
out = lines[:266] + [NEW] + lines[413:]
with io.open(PATH, 'w', encoding='utf-8') as f:
    f.writelines(out)
print('replaced. new length:', len(out))
