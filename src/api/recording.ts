/**
 * RECORDING IDENTITY — the dedup key for "same performance, different row".
 *
 * Providers re-list the SAME recording under many ids: JioSaavn returns
 * "Zalima" from the movie album, from 4 compilations and from 2 regional
 * presses — 5-6 rows with different ids but ONE song. YouTube Music's
 * catalog likewise carries "Tum Hi Ho • Aashiqui 2" and "Tum Hi Ho •
 * Greatest Hits 3" as separate catalog entities.
 *
 * The key = normalized TITLE + normalized PRIMARY ARTIST:
 *   • lowercased, diacritics folded, all non-alphanumerics stripped —
 *     "TU CHAHIYE", "Tu Chahiye" and "tu chahiye." collapse together
 *   • parens/brackets are STRIPPED AS CHARACTERS but their words KEPT —
 *     "Tu Chahiye (Lofi Mix)" ≠ "Tu Chahiye" (different performance,
 *     must stay), while "Zalima" = "Zalima" (same performance, must go)
 *   • primary artist only (first credited) — compilations re-credit the
 *     same lead artist in a different order/separators; the lead is the
 *     stable anchor. Covers by another artist keep their own key.
 */

/** Attribution noise that does NOT change the recording's identity:
 *  movie/show credits ('(From "Raees")') and featured-artist credits
 *  ('(feat. Badshah)'). Versions that ARE different performances —
 *  Lofi Mix, Remix, Live, Slowed, Cover, Dance Mix… — are NOT stripped. */
const ATTRIBUTION_NOISE =
  /\s*[([]\s*(?:from\s+["'"][^)"']{0,60}["'"]|feat\.?\s|ft\.?\s|with\s|original motion picture[^)\]]{0,40}|ost\s)[^)\]]*[)\]]/gi;

function normTitle(s: string): string {
  return s
    .replace(ATTRIBUTION_NOISE, ' ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 80);
}

function normSeg(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 80);
}

/** First credited artist from the full-credit forms providers send. */
export function primaryArtistOf(t: {
  artist?: string;
  artistsFull?: string[];
}): string {
  const src = (t.artistsFull?.length ? t.artistsFull[0] : t.artist) ?? '';
  return src.split(/,|&|\bfeat\.?\b|\bft\.?\b/i)[0]?.trim() ?? '';
}

/** Stable recording key — "zalima|pritam" style. Title-less rows key on
 *  the artist so two different artists never collapse into one. */
export function recordingKey(
  t: { title?: string; artist?: string; artistsFull?: string[] },
  salt = '',
): string {
  const title = normTitle(t.title ?? '');
  const artist = normSeg(primaryArtistOf(t));
  if (!title) return `anon|${artist}${salt ? `|${salt}` : ''}`;
  return `${title}|${artist}`;
}

// ── R8-P4b — credit-order reconciliation (the residual re-list gap) ──
//
// Live-ground-truth (probe, 2026-08): providers ALSO re-list the same
// recording with a RE-ORDERED or TRUNCATED credit list — "Tum Hi Ho |
// Arijit Singh, Mithoon" and "Tum Hi Ho | Mithoon, Arijit Singh" are
// ONE song under two primary-artist keys; "Labon Ko | KK, Pritam,
// Sayeed Quadri" vs "Labon Ko | Pritam, KK" likewise. The primary-
// artist key cannot see those, so key-deduped lists still showed the
// same song twice (the user's "Top Songs" field report).
//
// The reconciliation pass buckets rows by title and collapses rows
// whose CREDIT SETS are equal or nested (one ⊆ the other — a
// truncated re-credit). Genuinely different songs survive: their
// credit sets are disjoint ("Tum Se Hi | Pritam" vs "Tum Se Hi |
// Ankit Tiwari") or their titles differ (every Lofi/Remix/Live/cover
// variant keeps its version words in the title).

/** Normalized FULL credit set of a row (every credited artist, not
 *  just the primary). Empty when the row carries no credits at all. */
export function creditSetOf(t: {
  artist?: string;
  artistsFull?: string[];
}): Set<string> {
  const src = t.artistsFull?.length ? [...t.artistsFull] : t.artist ? [t.artist] : [];
  const out = new Set<string>();
  for (const a of src) {
    for (const seg of a.split(/,|&|\bfeat\.?\b|\bft\.?\b/i)) {
      const n = normSeg(seg.trim());
      if (n) out.add(n);
    }
  }
  return out;
}

/** Title bucket of a row — the normTitle half of recordingKey. */
export function titleKeyOf(t: { title?: string }): string {
  return normTitle(t.title ?? '');
}

/** Plain nesting test: one credit set ⊆ the other (equal counts).
 *  Empty credit sets never match. Shared by the guarded matcher below
 *  and the play-count twin escape. */
export function nestedCredits(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (!big.has(x)) return false;
  return true;
}

/** Two credit sets describe the SAME recording when one nests inside
 *  the other. Empty credit sets never match (nothing to anchor on).
 *
 *  SINGLETON GUARD (gauntlet P2-3): when the smaller set is a single
 *  artist {X}, X must ALSO be the primary credit of the larger row —
 *  a lone credit that is only a SECONDARY credit of the other row is
 *  a DIFFERENT recording (the featured artist's own same-titled
 *  track: "Kar Gayi Chull (feat. Badshah)" by Fazilpuria vs a
 *  "Kar Gayi Chull" by Badshah alone must stay separate).
 *
 *  The guard's blind spot — the lyricist/composer-first FULLER-credit
 *  re-list ("Humnava Mere | Manoj Muntashir, Rocky-Shiv, Jubin
 *  Nautiyal" vs "… | Jubin Nautiyal") — is covered by the play-count
 *  twin escape in the reconciliation passes, not here. */
export function sameCredits(
  a: Set<string>,
  b: Set<string>,
  primaryA?: string,
  primaryB?: string,
): boolean {
  if (!nestedCredits(a, b)) return false;
  if (a.size !== b.size) {
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];
    if (small.size === 1) {
      const lone = [...small][0];
      const primaryBig = a.size <= b.size ? primaryB : primaryA;
      if (primaryBig && normSeg(primaryBig) !== lone) return false;
    }
  }
  return true;
}

/** Play-count twin: two rows whose play counters are near-identical
 *  (Δ ≤ 1000) share the SAME recording's global counter — JioSaavn's
 *  re-lists of one recording carry the one platform-wide count (live
 *  probe: the Humnava Mere pair read 137,044,726 vs 137,044,723). A
 *  cover/remix of the same name sits millions away. Only fires when
 *  BOTH rows carry a LARGE counter (≥ 100,000) — small counters are
 *  noisy (two obscure same-titled recordings can sit within Δ 1000
 *  of each other, round-3 critic NEW-6) — and YouTube filtered rows
 *  carry no counter at all, so the guard alone decides there. */
export function countTwins(a?: number, b?: number): boolean {
  return (
    typeof a === 'number' &&
    typeof b === 'number' &&
    a >= 100000 &&
    b >= 100000 &&
    Math.abs(a - b) <= 1000
  );
}

/** Order-preserving reconciliation: within each title bucket, a row is
 *  dropped when an EARLIER KEPT row carries a nested/equal credit set
 *  (guarded) — or when the rows are play-count twins (the lyricist-first
 *  fuller-credit re-lists the singleton guard correctly blocks on
 *  credits alone). Pure; idempotent. */
export function reconcileRecordings<T extends {
  title?: string;
  artist?: string;
  artistsFull?: string[];
  playCount?: number;
}>(tracks: T[]): T[] {
  const buckets = new Map<string, { credits: Set<string>; primary: string; plays?: number }[]>();
  const out: T[] = [];
  for (const t of tracks) {
    const title = titleKeyOf(t);
    if (!title) {
      out.push(t); // no title → the key pass already anchored on artist
      continue;
    }
    const credits = creditSetOf(t);
    const primary = primaryArtistOf(t);
    let drop = false;
    for (const kept of buckets.get(title) ?? []) {
      if (!nestedCredits(kept.credits, credits)) continue;
      if (sameCredits(kept.credits, credits, kept.primary, primary)) {
        drop = true;
        break;
      }
      if (countTwins(kept.plays, t.playCount)) {
        drop = true; // play-count twin (gauntlet round-2 NEW-6)
        break;
      }
    }
    if (drop) continue;
    let bucket = buckets.get(title);
    if (!bucket) {
      bucket = [];
      buckets.set(title, bucket);
    }
    bucket.push({ credits, primary, plays: t.playCount });
    out.push(t);
  }
  return out;
}
