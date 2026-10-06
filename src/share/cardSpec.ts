/**
 * Share card — the PURE spec. The card image is rendered by ShareCard
 * and captured by share.ts; everything judgeable (sizes, sanitizing,
 * platform mode) lives here so locks can pin it without a device.
 *
 * Bar: Spotify's share card (gauntlet/WAVE6-BARS.md §6a) — artwork
 * dominant, legible in a chat thread, one brand mark. Our edge: the
 * exact synced-lyric line being sung right now.
 */

export type SharePlatform = 'web' | 'native';
export type ShareMode = 'card' | 'text';

/**
 * Native → capture the card into a real image and hand it to the share
 * sheet. Web → text share, deterministically: foreignObject capture
 * cannot be trusted with remote (CORS-tainting) artwork, and a blank
 * card in a share sheet is worse than an honest text line.
 */
export function shareMode(platform: SharePlatform): ShareMode {
  return platform === 'native' ? 'card' : 'text';
}

/** Archivo Black display size that survives 2 lines for any title length. */
export function fitTitleSize(title: string): number {
  const n = (title ?? '').trim().length;
  if (n <= 18) return 44;
  if (n <= 30) return 36;
  if (n <= 44) return 28;
  return 24;
}

/**
 * A synced-lyric line safe to print on the card: LRC stamps
 * ([ar:..] [00:12.34]) stripped, whitespace collapsed, instrumental
 * gaps (no letters — digits/punct only) → null, 96-char hard cap.
 */
export function sanitizeLyricLine(line?: string | null): string | null {
  if (!line) return null;
  let s = line.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  // letters only — Latin, Latin-extended, Devanagari (Hindi lines)
  if (!/[A-Za-z\u00C0-\u024F\u0900-\u097F]/.test(s)) return null;
  if (s.length > 96) s = `${s.slice(0, 93).trimEnd()}…`;
  return s;
}

/** The exact text-share message (v4.0.5 contract — never changed). */
export function shareText(title: string, artist: string): string {
  return `${title} — ${artist}\nPlaying on TSF Music`;
}

/* ── THE TEN · F6 — the Local Rewind cards (pure spec, lockable) ────── */

import type { WrappedSummary } from '../ai/wrapped';

export interface WrappedCardSpec {
  kicker: string;
  title: string;
  sub: string;
}

/**
 * The card sequence — a CLOSED set with truth-conditioned copy: a card
 * with no data says so honestly ("nothing filed") instead of vanishing
 * or faking numbers. The rewind itself is null below the stream floor,
 * so these cards only render when something TRUE can be said.
 */
export function wrappedCardLines(s: WrappedSummary): WrappedCardSpec[] {
  const n = (x: number): string => x.toLocaleString('en-US');
  return [
    {
      kicker: 'THE HEADLINER',
      title: s.topArtist?.artist ?? '—',
      sub: s.topArtist ? `${n(s.topArtist.plays)} streams this month` : 'nothing filed yet',
    },
    {
      kicker: 'ON REPEAT',
      title: s.topTrack?.title ?? '—',
      sub: s.topTrack ? `${s.topTrack.artist} · ${n(s.topTrack.plays)} streams` : 'nothing filed yet',
    },
    {
      kicker: 'MIDNIGHT OBSESSION',
      title: s.midnight?.title ?? 'SLEEP IS SACRED',
      sub: s.midnight ? `${s.midnight.artist} · played after midnight` : 'no 12–4am listening on file',
    },
    {
      kicker: 'YOUR AURA',
      title: s.aura?.label.replace('_', ' ') ?? '—',
      sub: `energy ${Math.round((s.aura?.energy ?? 0) * 100)}% · warmth ${Math.round((s.aura?.valence ?? 0) * 100)}%`,
    },
    {
      kicker: 'THE LEDGER',
      title: `${n(s.streams)} STREAMS`,
      // the streak is anchored at its last ACTIVE day — when it ended
      // before today the card says so (no unqualified streak claims)
      sub:
        s.streakDays > 0 && s.streakEndTs != null
          ? `${n(s.minutes)} minutes · ${s.streakDays}-day streak thru ${new Date(s.streakEndTs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
          : `${n(s.minutes)} minutes · no active-day streak`,
    },
  ];
}

/** The rewind's text-share fallback (deterministic, honest numbers). */
export function wrappedShareText(s: WrappedSummary): string {
  const bits: string[] = ['MY MONTH IN MUSIC · TSF REWIND'];
  if (s.topArtist) bits.push(`Top artist: ${s.topArtist.artist} (${s.topArtist.plays} streams)`);
  if (s.topTrack) bits.push(`On repeat: ${s.topTrack.title}`);
  if (s.aura) bits.push(`Aura: ${s.aura.label.replace('_', ' ')}`);
  const streak = s.streakDays > 0 && s.streakEndTs != null
    ? `${s.streakDays}-day streak thru ${new Date(s.streakEndTs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    : 'no active-day streak';
  bits.push(`${s.streams} streams · ${s.minutes} min · ${streak}`);
  return bits.join('\n');
}
