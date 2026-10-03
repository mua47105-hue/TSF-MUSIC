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
