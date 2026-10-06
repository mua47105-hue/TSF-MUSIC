/**
 * FOCUS PICKS CORE (THE TEN · FEATURE 10) — the PURE decision half of
 * the focus playlist. mindbeat.focusPicks() does the catalog IO; these
 * helpers own the judgment, and the locks drive them directly:
 *
 *   • the artist pool is seed-first, profile-second, and MUTED ARTISTS
 *     ARE NEVER POOLED — a muted artist's tracks can never queue as
 *     "focus music" (the bar says respects muted artists; this module
 *     is where that is true);
 *   • row eligibility is explicit: a track by a muted artist is out;
 *     the caller's baked-energy ceiling applies separately.
 *
 * Pure + deterministic. No network, no Date.now, no Math.random.
 */

/** Minimal input shapes (kept structural so locks need no fixtures). */
export interface FocusArtistInput {
  seedArtist?: string | null;
  /** profile top artists, strongest first (already mute-filtered upstream) */
  topArtists: string[];
  /** the user's muted artists (stored lowercase in corrections) */
  mutedArtists: string[];
}

export function primaryArtistOfRow(artist: string): string {
  return artist.split(/,|&/)[0].trim();
}

/** The pool: seed first, then profile artists — deduped, MUTES REMOVED. */
export function buildFocusArtistPool(input: FocusArtistInput): string[] {
  const muted = new Set(input.mutedArtists.map((m) => m.trim().toLowerCase()).filter(Boolean));
  const out: string[] = [];
  const push = (name?: string | null) => {
    const n = (name ?? '').trim();
    if (!n) return;
    if (muted.has(n.toLowerCase())) return; // muted ⇒ never focus music
    if (out.some((x) => x.toLowerCase() === n.toLowerCase())) return;
    out.push(n);
  };
  push(input.seedArtist);
  for (const a of input.topArtists) push(a);
  return out;
}

/** A row is out when its primary artist is muted (case-insensitive). */
export function isMutedRow(artist: string, mutedArtists: string[]): boolean {
  const muted = new Set(mutedArtists.map((m) => m.trim().toLowerCase()).filter(Boolean));
  return muted.has(primaryArtistOfRow(artist).toLowerCase());
}
