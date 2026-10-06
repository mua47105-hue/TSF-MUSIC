/**
 * TASTE DNA BLEND (THE TEN · FEATURE 7) — Spotify Blend without servers.
 * Friend A exports a Taste DNA code, Friend B imports it, the app
 * computes the intersection + bridge LOCALLY and builds the playlist.
 *
 * STANDALONE CONTRACT: this is a local encode/decode of taste
 * AGGREGATES — the payload carries top artists/genres and the
 * energy/valence preference center. NEVER raw ledger events, never
 * track-level history, never timestamps beyond the build date. Anything
 * more would betray the privacy story on the tin.
 *
 * ENCODING: pure-JS UTF-8 → base64url (no btoa on Hermes, zero new
 * dependencies). Round-trips LOSSLESSLY; decode is tolerant (whitespace,
 * wrong versions, corrupt bytes ⇒ null — an honest failure, never a
 * crash, never a fabricated blend).
 *
 * DETERMINISM: computeBlend is pure — same two DNAs ⇒ the same blend,
 * always (weight desc, name asc; zero Math.random).
 */

import { TASTE_DNA } from './core/constants';
import type { TasteProfile } from './core/types';

/** Cross-device deterministic string compare (UTF-16 code units). */
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface TasteDna {
  v: number;
  /** Top artists: normalized name + weight. */
  artists: Array<{ n: string; w: number }>;
  /** Top genres (internal __mood buckets excluded). */
  genres: Array<{ n: string; w: number }>;
  /** The preference center (profile.proxy means). */
  energy: number;
  valence: number;
  /** Build date (day precision — nothing more granular ships). */
  at: number;
}

/** The DNA built from the local profile — aggregates only, bounded. */
export function buildTasteDna(profile: TasteProfile): TasteDna {
  const artists = Object.entries(profile.artists)
    .sort((a, b) => b[1].w - a[1].w || cmpStr(a[0], b[0]))
    .slice(0, TASTE_DNA.artistCount)
    .map(([n, e]) => ({ n, w: Math.round(e.w * 100) / 100 }));
  const genres = Object.entries(profile.genres)
    .filter(([g]) => !g.startsWith('__')) // internal buckets make terrible DNA
    .sort((a, b) => b[1].w - a[1].w || cmpStr(a[0], b[0]))
    .slice(0, TASTE_DNA.genreCount)
    .map(([n, e]) => ({ n, w: Math.round(e.w * 100) / 100 }));
  return {
    v: TASTE_DNA.version,
    artists,
    genres,
    energy: Math.round((profile.proxy?.energyPref?.mean ?? 0.5) * 100) / 100,
    valence: Math.round((profile.proxy?.valencePref?.mean ?? 0.5) * 100) / 100,
    // Day precision — the payload must not leak listening habits' timing.
    at: new Date().setHours(0, 0, 0, 0),
  };
}

// ── base64url over manual UTF-8 (Hermes has no btoa/TextEncoder) ────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
        i += 1;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

function bytesToUtf8(bytes: number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
    } else if (b < 0xe0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 63));
      i += 2;
    } else if (b < 0xf0) {
      out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63));
      i += 3;
    } else {
      const cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63);
      const hi = 0xd800 + ((cp - 0x10000) >> 10);
      const lo = 0xdc00 + ((cp - 0x10000) & 0x3ff);
      out += String.fromCharCode(hi, lo);
      i += 4;
    }
  }
  return out;
}

function bytesToB64url(bytes: number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += B64[b2 & 63];
  }
  return out;
}

function b64urlToBytes(s: string): number[] {
  // Strip whitespace ONLY — '-' is a live base64url digit (value 62),
  // not noise (the round-trip lock caught exactly this bug).
  const clean = s.replace(/\s+/g, '');
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const cs = clean.slice(i, i + 4).split('').map((c) => B64.indexOf(c));
    if (cs.some((c) => c < 0)) throw new Error('bad base64');
    const b0 = (cs[0]! << 2) | (cs[1]! >> 4);
    out.push(b0);
    if (cs[2] === undefined || cs[2] === -1) break;
    out.push(((cs[1]! & 15) << 4) | (cs[2]! >> 2));
    if (cs[3] === undefined || cs[3] === -1) break;
    out.push(((cs[2]! & 3) << 6) | cs[3]!);
  }
  return out;
}

/** Encode to a clipboard/share-safe base64url string (no padding). */
export function encodeTasteDna(dna: TasteDna): string {
  return bytesToB64url(utf8Bytes(JSON.stringify(dna)));
}

/**
 * Decode a shared code. Tolerant of copy/paste noise (whitespace, line
 * breaks); REFUSES wrong versions and malformed payloads with NULL —
 * the caller shows an honest toast, the app never crashes and never
 * invents a blend from garbage.
 */
export function decodeTasteDna(code: string): TasteDna | null {
  try {
    if (typeof code !== 'string' || !code.trim()) return null;
    const dna = JSON.parse(bytesToUtf8(b64urlToBytes(code))) as TasteDna;
    if (!dna || dna.v !== TASTE_DNA.version) return null;
    if (!Array.isArray(dna.artists) || !Array.isArray(dna.genres)) return null;
    const okName = (n: unknown): n is string => typeof n === 'string' && n.length > 0 && n.length <= 80;
    const okW = (w: unknown): w is number => typeof w === 'number' && Number.isFinite(w) && w >= 0;
    const cleanArtists = dna.artists
      .filter((a) => a && okName(a.n) && okW(a.w))
      .slice(0, TASTE_DNA.artistCount)
      .map((a) => ({ n: a.n, w: a.w }));
    const cleanGenres = dna.genres
      .filter((g) => g && okName(g.n) && okW(g.w) && !String(g.n).startsWith('__'))
      .slice(0, TASTE_DNA.genreCount)
      .map((g) => ({ n: g.n, w: g.w }));
    return {
      v: TASTE_DNA.version,
      artists: cleanArtists,
      genres: cleanGenres,
      // hostile/garbage centers are clamped into the honest [0,1] range
      energy: typeof dna.energy === 'number' && Number.isFinite(dna.energy) ? Math.min(1, Math.max(0, dna.energy)) : 0.5,
      valence: typeof dna.valence === 'number' && Number.isFinite(dna.valence) ? Math.min(1, Math.max(0, dna.valence)) : 0.5,
      at: typeof dna.at === 'number' && Number.isFinite(dna.at) ? dna.at : 0,
    };
  } catch {
    return null;
  }
}

export interface TasteBlend {
  /** Artists BOTH listeners have in their DNA (the intersection). */
  shared: Array<{ n: string; w: number }>;
  /**
   * The bridge: each side's strongest artists the other does NOT know,
   * interleaved by weight — the meeting-ground seeds the playlist is
   * built from. TRUTH CONDITION: membership = present in exactly one
   * DNA's artist list; rank = that side's own weight. Nothing is
   * inferred beyond the two payloads.
   */
  bridge: Array<{ n: string; w: number; from: 'mine' | 'theirs' }>;
  /** The blend's energy/valence center (the mean of the two DNAs'). */
  energy: number;
  valence: number;
}

/** Pure + deterministic: same two DNAs ⇒ the same blend, always. */
export function computeBlend(mine: TasteDna, theirs: TasteDna): TasteBlend {
  const key = (n: string) => n.trim().toLowerCase();
  const mineKeys = new Map(mine.artists.map((a) => [key(a.n), a]));
  const theirsKeys = new Map(theirs.artists.map((a) => [key(a.n), a]));

  const shared: Array<{ n: string; w: number }> = [];
  for (const [k, a] of mineKeys) {
    const b = theirsKeys.get(k);
    if (b) shared.push({ n: a.n, w: Math.round(((a.w + b.w) / 2) * 100) / 100 });
  }
  shared.sort((x, y) => y.w - x.w || cmpStr(x.n, y.n));

  const bridgeMine = mine.artists
    .filter((a) => !theirsKeys.has(key(a.n)))
    .sort((x, y) => y.w - x.w || cmpStr(x.n, y.n))
    .slice(0, TASTE_DNA.bridgePerSide)
    .map((a) => ({ n: a.n, w: a.w, from: 'mine' as const }));
  const bridgeTheirs = theirs.artists
    .filter((a) => !mineKeys.has(key(a.n)))
    .sort((x, y) => y.w - x.w || cmpStr(x.n, y.n))
    .slice(0, TASTE_DNA.bridgePerSide)
    .map((a) => ({ n: a.n, w: a.w, from: 'theirs' as const }));
  // Interleave by weight desc, then name asc — deterministic, fair to both.
  const bridge = [...bridgeMine, ...bridgeTheirs].sort(
    (x, y) => y.w - x.w || cmpStr(x.n, y.n) || (x.from === 'mine' ? -1 : 1),
  );

  return {
    shared,
    bridge,
    energy: Math.round(((mine.energy + theirs.energy) / 2) * 100) / 100,
    valence: Math.round(((mine.valence + theirs.valence) / 2) * 100) / 100,
  };
}
