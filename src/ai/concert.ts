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
 *  that plays nothing is a fake room.
 *
 *  v5.0.1 FIX-B2: per-field caps — a 262,144-char title once produced a
 *  349,684-char code that decoded fine (the auditor's repro). Fields
 *  are SLICED to their caps here (the encoder normalizes); decode
 *  REJECTS over-cap fields (a forged payload is not normalized). */
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
    id: t.id.slice(0, CONCERT.maxIdChars),
    title: t.title.slice(0, CONCERT.maxTitleChars),
    artist: t.artist.slice(0, CONCERT.maxArtistChars),
    ...(t.artwork ? { artwork: t.artwork.slice(0, CONCERT.maxArtworkChars) } : {}),
    ...(typeof t.duration === 'number' && t.duration > 0 ? { duration: Math.round(t.duration) } : {}),
    ...(source ? { source } : {}),
    ...(source === 'saavn' && typeof t.saavnId === 'string' && t.saavnId
      ? { saavnId: t.saavnId.slice(0, CONCERT.maxIdChars) }
      : {}),
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

/** THE ENCODER (pure): the rows are stripped and field-capped; a room
 *  larger than CONCERT.maxTracks is a REFUSAL, not a silent truncation
 *  (v5.0.1 FIX-B2 — the old encoder quietly dropped row 51+ and the
 *  shared room was smaller than the sender's queue; the count is the
 *  INPUT's rows — an unnamed row cannot be smuggled past the refusal
 *  either, critic P2b). The size gate runs on the FINISHED base64url
 *  code — the blind-critic round proved that gating the JSON instead
 *  leaves a dead band: base64url inflates ×4/3, so a JSON inside
 *  [49,152, 65,536] chars encoded fine and was then refused ON SIGHT
 *  by the receiver's code-length gate. One gate, on the code, both
 *  sides. null = "this cannot be a code", never a fabricated,
 *  quietly-trimmed, or unjoinable room. */
export function encodeConcert(
  playlist: Array<Parameters<typeof pickConcertTrack>[0]>,
  startAt: number,
  now: number = new Date().setHours(0, 0, 0, 0),
): string | null {
  if (playlist.length > CONCERT.maxTracks) return null; // oversized INPUT — refuse loudly, count it all (critic P2b)
  const tracks: ConcertTrack[] = [];
  for (const t of playlist) {
    const picked = pickConcertTrack(t);
    if (picked) tracks.push(picked);
  }
  if (!tracks.length) return null; // an empty room is not a concert
  const json = JSON.stringify({ v: CONCERT.version, startAt, at: now, tracks } satisfies ConcertPayload);
  const code = bytesToB64url(utf8Bytes(json));
  if (code.length > CONCERT.maxCodeChars) return null; // THE size cap — measured on the code, decode-symmetric
  return code;
}

/** THE DECODER (pure, tolerant): any corruption ⇒ null. v5.0.1 FIX-B2:
 *  the size gate runs BEFORE base64 decode / JSON parse — a 100k-char
 *  string is refused on sight (defense in depth: the encoder caps, but
 *  a FORGED code does not have to have come from it). Field caps are
 *  re-checked per row: a small code carrying one huge field is refused. */
export function decodeConcert(code: string | null | undefined): ConcertPayload | null {
  if (!code || typeof code !== 'string') return null;
  if (code.length > CONCERT.maxCodeChars) return null; // oversized on sight — before any decode
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
      if (t.title.length > CONCERT.maxTitleChars) return null; // forged over-cap field
      if (t.artist.length > CONCERT.maxArtistChars) return null;
      if (t.id.length > CONCERT.maxIdChars) return null;
      if (t.artwork !== undefined && (typeof t.artwork !== 'string' || t.artwork.length > CONCERT.maxArtworkChars)) return null;
      if ('streamUrl' in t) return null; // a forged handle-poisoned payload is REJECTED
      if ('encryptedUrl' in t || 'previewUrl' in t) return null; // no handle under any name
      if (t.source !== undefined && !CONCERT_SOURCES.includes(t.source)) return null;
      if (t.saavnId !== undefined && (typeof t.saavnId !== 'string' || t.saavnId.length > CONCERT.maxIdChars)) return null;
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
