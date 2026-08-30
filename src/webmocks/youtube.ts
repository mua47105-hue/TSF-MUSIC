/**
 * WEB MOCK of src/api/youtube.ts — fixture-backed, same export surface.
 * Metro redirects this only for platform=web (screenshot harness).
 *
 * Why a mock here: the InnerTube endpoints ship no CORS headers, so a
 * browser page can never call them — live YT in the harness would always
 * degrade to empty. The REAL module is exercised by the bun suites
 * (tests/ai/youtube.test.ts + search_yt_locks.test.ts) and the live
 * probes (scripts/live_probe_v34.ts); the harness only needs deterministic
 * rows to render and a resolvable stream so the player path works.
 */

import type { Track } from '../types';
import { YT_TRACKS, ytSearchFixtures } from './fixtures';

export interface YtSearchResult {
  tracks: Track[];
  albums: Array<{ title: string; browseId?: string; artist?: string }>;
  latencyMs: number;
}

export interface ResolveOutcome {
  ok: boolean;
  reason?: 'disabled' | 'bot-walled' | 'no-audio' | 'network';
  audio?: { url: string; itag: number; bitrate: number; mime: string; expiresAt: number };
  trail?: string[];
}

export interface YtPoTokenPair {
  visitorData: string;
  webPot: string;
  mintPlayerPot: (videoId: string) => Promise<string | null>;
}

// ── kill switch (parity with the real module's semantics) ──

const ytState = { failures: 0, disabledUntil: 0 };
const SOFT_DISABLE_MS = 60 * 60 * 1000;
const FAILURE_LIMIT = 3;

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

// ── test hooks that exist on the real module (kept for surface parity) ──

export function setYtFetch(): void {
  /* no-op on the harness */
}
export function resetYtSession(): void {
  /* no-op */
}
export function peekYtVisitorData(): string {
  return 'mock-visitor';
}
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
let lastTrail: string[] = [];
export function ytLastDiagnostics(): string[] {
  return lastTrail;
}
export function clearYtCaches(): void {
  lastTrail = [];
}

// ── PO-token provider seam (the bridge stays inert on web) ──

export function setPoTokenProvider(): void {
  /* no-op on the harness — WEB_REMIX rung is unnecessary here */
}

// ── search ──

export async function ytSearchMusic(
  query: string,
  limit = 20,
  _signal?: AbortSignal,
): Promise<YtSearchResult> {
  const t0 = Date.now();
  if (!ytAvailable()) return { tracks: [], albums: [], latencyMs: 0 };
  await new Promise((r) => setTimeout(r, 220));
  const tracks = ytSearchFixtures(query, limit);
  const albums =
    /chahiye|chaiye/i.test(query)
      ? [
          { title: 'Bajrangi Bhaijaan', browseId: 'MPREb_alb1' },
          { title: 'Singles', browseId: 'MPREb_alb2' },
        ]
      : [];
  return { tracks, albums, latencyMs: Date.now() - t0 };
}

// ── stream resolution: always resolvable in the harness ──

export async function ytResolveStream(videoId: string): Promise<ResolveOutcome> {
  lastTrail = [`resolve ${videoId} @${new Date().toISOString()}`, 'WEBMOCK: RESOLVED itag 140 audio/mp4 129703bps'];
  noteYtSuccess();
  return {
    ok: true,
    audio: {
      url: `mock://yt/${videoId}/audio140.m4a`,
      itag: 140,
      bitrate: 129703,
      mime: 'audio/mp4',
      expiresAt: Date.now() + 5.5 * 60 * 60 * 1000,
    },
    trail: lastTrail,
  };
}

export async function ytRefreshStream(track: Track): Promise<string | null> {
  const id = track.youtubeId ?? track.id.replace(/^yt-/, '');
  const out = await ytResolveStream(id);
  return out.ok ? out.audio!.url : null;
}

export async function ytStreamUrlForTrack(track: Track): Promise<string | null> {
  const id = track.youtubeId ?? track.id.replace(/^yt-/, '');
  const out = await ytResolveStream(id);
  return out.ok ? out.audio!.url : null;
}

export type { Track };
export { YT_TRACKS };
