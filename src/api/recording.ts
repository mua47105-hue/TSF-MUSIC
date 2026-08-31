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
