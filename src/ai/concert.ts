/**
 * CONCERT MODE (MAGNUM OPUS · F18) — serverless shared listening.
 *
 * "I start the song at 8:00, you start the same song at 8:00" — the
 * playlist + a synchronized start timestamp travel as ONE code. No
 * server, no accounts, no room service: the code IS the room (the
 * TasteDNA codec pattern: pure-JS UTF-8 → base64url, zero new
 * dependencies, lossless round-trip, decode is tolerant — corrupt
 * bytes / wrong version / oversized payload ⇒ null, an honest failure
 * the UI toasts, never a crash, never a fabricated room).
 *
 * HONEST LIMITS (stated on the tin):
 *  - The ±500ms clock drift (CONCERT.clockDriftMs) is REAL: two phones
 *    set their start timestamps from their own clocks, so the "same
 *    moment" can be half a second apart. No NTP sync exists in a
 *    standalone app — the payload carries the sender's startAt and the
 *    receiver plays from `now + leadIn`, so drift is bounded by the
 *    two devices' clock difference, disclosed here and in the toast.
 *  - streamUrl can NEVER enter the payload (type-level: the ConcertTrack
 *    shape has no field for it, and the encoder strips inputs through
 *    pickConcertTrack) — a concert code carries WHAT to play, never a
 *    playback handle.
 */

import { CONCERT } from './core/constants';
import { utf8Bytes, bytesToUtf8, bytesToB64url, b64urlToBytes } from './tasteDna';
import type { Track } from '../types';

export interface ConcertTrack {
  id: string;
  title: string;
  artist: string;
  artwork?: string;
  duration?: number;
  /** The row's PROVIDER (an IDENTIFIER, not a stream handle — the law
   *  bans streamUrl/encryptedUrl/previewUrl, never the catalog address).
   *  A 'saavn' row is rescueable by id at play time via the EXISTING
   *  saavnRescue ladder — the same rung the smart crates use. */
  source?: 'saavn' | 'itunes' | 'youtube';
  saavnId?: string;
}

export interface ConcertPayload {
  /** the codec version — decode rejects anything it does not speak */
  v: number;
  /** the sender's intended synchronized start (epoch ms) */
  startAt: number;
  /** encode time (day precision — nothing more granular ships) */
  at: number;
  tracks: ConcertTrack[];
}

/** THE STRIPPER: a ConcertTrack is built field-by-field — a streamUrl
 *  on the input has no path into the output (the type makes the leak
 *  unrepresentable, and the locks assert the encoder's output too).
 *  Identifiers (source/saavnId) ride along deliberately: without them
 *  the receiver could never RESOLVE a row (blind-critic P0-2) — a code
 *  that plays nothing is a fake room. */
const CONCERT_SOURCES = ['saavn', 'itunes', 'youtube'] as const;

export function pickConcertTrack(t: {
  id: string;
  title?: string;
  artist?: string;
  artwork?: string;
  duration?: number;
  source?: string;
  saavnId?: string;
}): ConcertTrack | null {
  if (!t?.id || !t.title || !t.artist) return null; // a concert row must be nameable
  const source = CONCERT_SOURCES.includes(t.source as (typeof CONCERT_SOURCES)[number])
    ? (t.source as ConcertTrack['source'])
    : undefined;
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    ...(t.artwork ? { artwork: t.artwork } : {}),
    ...(typeof t.duration === 'number' && t.duration > 0 ? { duration: Math.round(t.duration) } : {}),
    ...(source ? { source } : {}),
    ...(source === 'saavn' && typeof t.saavnId === 'string' && t.saavnId ? { saavnId: t.saavnId } : {}),
  };
}

/** THE RESOLVABLE MAP (pure): ConcertTrack → the Track shape the player
 *  queues, explicitly field-by-field (NEVER an `as Track[]` cast —
 *  blind-critic P0-2). A saavn row arrives rescue-ready (source set,
 *  saavnId carried — the EXISTING by-id rung picks it up at play time);
 *  absent source defaults to the app's saavn spine, and the join toast
 *  reports the REAL resolved count either way. No stream handle is ever
 *  produced here: no streamUrl, no encryptedUrl, no previewUrl. */
export function concertRowToTrack(t: ConcertTrack): Track {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    artwork: t.artwork ?? '',
    duration: typeof t.duration === 'number' && t.duration > 0 ? t.duration : 0,
    source: t.source ?? 'saavn',
    previewOnly: false, // unresolved rows carry no preview claim — resolution decides at play time
    ...(t.source === 'saavn' && t.saavnId ? { saavnId: t.saavnId } : {}),
  };
}

/** THE ENCODER (pure): first maxTracks rows, stripped, versioned. */
export function encodeConcert(
  playlist: Array<Parameters<typeof pickConcertTrack>[0]>,
  startAt: number,
  now: number = new Date().setHours(0, 0, 0, 0),
): string | null {
  const tracks: ConcertTrack[] = [];
  for (const t of playlist) {
    if (tracks.length >= CONCERT.maxTracks) break;
    const picked = pickConcertTrack(t);
    if (picked) tracks.push(picked);
  }
  if (!tracks.length) return null; // an empty room is not a concert
  const payload: ConcertPayload = { v: CONCERT.version, startAt, at: now, tracks };
  return bytesToB64url(utf8Bytes(JSON.stringify(payload)));
}

/** THE DECODER (pure, tolerant): any corruption ⇒ null. */
export function decodeConcert(code: string | null | undefined): ConcertPayload | null {
  if (!code || typeof code !== 'string') return null;
  try {
    const json = bytesToUtf8(b64urlToBytes(code));
    const p = JSON.parse(json) as ConcertPayload;
    if (!p || typeof p !== 'object') return null;
    if (p.v !== CONCERT.version) return null; // wrong version — we don't fake-comprehend
    if (typeof p.startAt !== 'number' || !Number.isFinite(p.startAt)) return null;
    if (!Array.isArray(p.tracks) || !p.tracks.length || p.tracks.length > CONCERT.maxTracks) return null;
    const tracks: ConcertTrack[] = [];
    for (const t of p.tracks) {
      if (!t || typeof t.id !== 'string' || !t.id) return null;
      if (typeof t.title !== 'string' || !t.title) return null;
      if (typeof t.artist !== 'string' || !t.artist) return null;
      if ('streamUrl' in t) return null; // a forged handle-poisoned payload is REJECTED
      if ('encryptedUrl' in t || 'previewUrl' in t) return null; // no handle under any name
      if (t.source !== undefined && !CONCERT_SOURCES.includes(t.source)) return null;
      if (t.saavnId !== undefined && typeof t.saavnId !== 'string') return null;
      tracks.push(pickConcertTrack(t)!);
    }
    return { v: p.v, startAt: p.startAt, at: typeof p.at === 'number' ? p.at : 0, tracks };
  } catch {
    return null; // bad base64 / bad json — the honest null
  }
}

/**
 * The receiver's synchronized start (pure): the sender said "start at
 * startAt"; the receiver starts at max(now, startAt) — if the code
 * arrives late the concert is already playing (join in progress, the
 * UI says so); if it arrives early, the lead-in is the wait. Clock
 * drift ±CONCERT.clockDriftMs is disclosed, never hidden.
 */
export function concertStartPlan(payload: ConcertPayload, now: number): { delayMs: number; late: boolean } {
  const delayMs = payload.startAt - now;
  return { delayMs: Math.max(0, delayMs), late: delayMs < -CONCERT.clockDriftMs };
}
