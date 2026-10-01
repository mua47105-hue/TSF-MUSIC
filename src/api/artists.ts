/**
 * Artist domain — REAL artist photos everywhere (v3.2 fix).
 *
 * JioSaavn's artist SEARCH returns placeholder art, but two endpoints carry
 * genuine artist photography:
 *   1. song search → more_info.artistMap.primary_artists[0].image
 *   2. artist.getArtistPageDetails → image (c.saavncdn.com/artists/…)
 *
 * This module exposes:
 *   - ARTIST_SEEDS       48 A-listers w/ verified photo URLs (harvested from
 *                        the live API; stable CDN paths) → instant first
 *                        screen, zero extra round-trips.
 *   - ARTIST_CATEGORIES  live pool queries (Bollywood, Punjabi, Indie, …).
 *   - searchSaavnArtists() artist search w/ real photos + ids.
 *   - getArtistPhoto()    per-id photo lookup (cached).
 *   - lookupArtistPhoto() by-name photo (seeds → id lookup), cached.
 *
 * sanitizeArtistImage() is the gate: only c.saavncdn.com/artists/ photos pass
 * (upgraded to 500x500); placeholders, share-images and album-art that
 * masquerades as artist art are rejected — callers fall back to initials.
 */

import { saavnGet } from './saavn';

export interface ArtistInfo {
  name: string;
  id?: string;
  image?: string;
}

/** Accept only genuine artist photography; upgrade to 500x500. */
export function sanitizeArtistImage(url?: string): string {
  if (!url) return '';
  if (!url.includes('/artists/')) return ''; // placeholder / album art / share image
  if (url.includes('artist-default') || url.includes('share-image')) return '';
  return url.replace('150x150', '500x500').replace('50x50', '500x500');
}

/**
 * Curated A-listers with verified JioSaavn photos (harvested 2026-08-29 —
 * every URL below returned HTTP 200 with a real artist portrait).
 * Order = display order: the first 15 land on screen one, mixed across
 * eras/regions so every user sees someone they know immediately.
 */
export const ARTIST_SEEDS: ArtistInfo[] = [
  { name: 'Arijit Singh', id: '459320', image: 'https://c.saavncdn.com/artists/Arijit_Singh_004_20241118063717_500x500.jpg' },
  { name: 'Diljit Dosanjh', id: '468245', image: 'https://c.saavncdn.com/artists/Diljit_Dosanjh_005_20231025073054_500x500.jpg' },
  { name: 'AP Dhillon', id: '681966', image: 'https://c.saavncdn.com/artists/AP_Dhillon_004_20251023102150_500x500.jpg' },
  { name: 'Shreya Ghoshal', id: '455130', image: 'https://c.saavncdn.com/artists/Shreya_Ghoshal_007_20241101074144_500x500.jpg' },
  { name: 'Pritam', id: '456323', image: 'https://c.saavncdn.com/artists/Pritam_Chakraborty-20170711073326_500x500.jpg' },
  { name: 'Badshah', id: '456863', image: 'https://c.saavncdn.com/artists/Badshah_006_20241118064015_500x500.jpg' },
  { name: 'A.R. Rahman', id: '456269', image: 'https://c.saavncdn.com/artists/AR_Rahman_002_20210120084455_500x500.jpg' },
  { name: 'Karan Aujla', id: '697691', image: 'https://c.saavncdn.com/artists/Karan_Aujla_004_20260810121947_500x500.jpg' },
  { name: 'Sonu Nigam', id: '455125', image: 'https://c.saavncdn.com/artists/Sonu_Nigam_003_20260813182013_500x500.jpg' },
  { name: 'Neha Kakkar', id: '464932', image: 'https://c.saavncdn.com/artists/Neha_Kakkar_007_20241212115832_500x500.jpg' },
  { name: 'Shubh', id: '14087974', image: 'https://c.saavncdn.com/artists/Shubh_000_20220921112507_500x500.jpg' },
  { name: 'DIVINE', id: '653605', image: 'https://c.saavncdn.com/artists/DIVINE_006_20250911071442_500x500.jpg' },
  { name: 'Tanishk Bagchi', id: '1595701', image: 'https://c.saavncdn.com/artists/Tanishk_Bagchi_003_20260106115039_500x500.jpg' },
  { name: 'Jubin Nautiyal', id: '881158', image: 'https://c.saavncdn.com/artists/Jubin_Nautiyal_003_20231130204020_500x500.jpg' },
  { name: 'KK', id: '455782', image: 'https://c.saavncdn.com/artists/KK_500x500.jpg' },
  { name: 'Sidhu Moose Wala', id: '3319750', image: 'https://c.saavncdn.com/artists/Sidhu_Moose_Wala_004_20250617183705_500x500.jpg' },
  { name: 'Guru Randhawa', id: '712878', image: 'https://c.saavncdn.com/artists/Guru_Randhawa_004_20250701125845_500x500.jpg' },
  { name: 'Yo Yo Honey Singh', id: '485956', image: 'https://c.saavncdn.com/artists/Yo_Yo_Honey_Singh_004_20260811095253_500x500.jpg' },
  { name: 'Raftaar', id: '458918', image: 'https://c.saavncdn.com/artists/Raftaar_009_20230223100912_500x500.jpg' },
  { name: 'Mohit Chauhan', id: '455124', image: 'https://c.saavncdn.com/artists/Mohit_Chauhan_500x500.jpg' },
  { name: 'Armaan Malik', id: '464656', image: 'https://c.saavncdn.com/artists/Armaan_Malik_006_20260813132832_500x500.jpg' },
  { name: 'Darshan Raval', id: '888127', image: 'https://c.saavncdn.com/artists/Darshan_Raval_006_20250807060352_500x500.jpg' },
  { name: 'Amit Trivedi', id: '457422', image: 'https://c.saavncdn.com/artists/Amit_Trivedi_007_20241118063149_500x500.jpg' },
  { name: 'Anuv Jain', id: '4878402', image: 'https://c.saavncdn.com/artists/Anuv_Jain_001_20231206073013_500x500.jpg' },
  { name: 'Prateek Kuhad', id: '1546334', image: 'https://c.saavncdn.com/artists/Prateek_Kuhad_006_20260515064251_500x500.jpg' },
  { name: 'Ritviz', id: '1970745', image: 'https://c.saavncdn.com/artists/Ritviz_500x500.jpg' },
  { name: 'Jasleen Royal', id: '742789', image: 'https://c.saavncdn.com/artists/Jasleen_Royal_002_20230615091108_500x500.jpg' },
  { name: 'B Praak', id: '788130', image: 'https://c.saavncdn.com/artists/B_Praak_001_20191118112005_500x500.jpg' },
  { name: 'Sachet-Parampara', id: '3623112', image: 'https://c.saavncdn.com/artists/Sachet-Parampara_20190221095720_500x500.jpg' },
  { name: 'Vishal & Shekhar', id: '459880', image: 'https://c.saavncdn.com/artists/Vishal-Shekhar_20191130071357_500x500.jpg' },
  { name: 'Shankar Mahadevan', id: '455275', image: 'https://c.saavncdn.com/artists/Shankar_Mahadevan_500x500.jpg' },
  { name: 'Udit Narayan', id: '455127', image: 'https://c.saavncdn.com/artists/Udit_Narayan_004_20241029065120_500x500.jpg' },
  { name: 'Kishore Kumar', id: '455144', image: 'https://c.saavncdn.com/artists/Kishore_Kumar_500x500.jpg' },
  { name: 'Lata Mangeshkar', id: '455109', image: 'https://c.saavncdn.com/artists/Lata_Mangeshkar_004_20230623105323_500x500.jpg' },
  { name: 'Asha Bhosle', id: '455166', image: 'https://c.saavncdn.com/artists/Asha_Bhosle_002_20200212082318_500x500.jpg' },
  { name: 'Alka Yagnik', id: '455120', image: 'https://c.saavncdn.com/artists/Alka_Yagnik_002_20220314192930_500x500.jpg' },
  { name: 'Kumar Sanu', id: '455142', image: 'https://c.saavncdn.com/artists/Kumar_Sanu_500x500.jpg' },
  { name: 'Hariharan', id: '455162', image: 'https://c.saavncdn.com/artists/Hariharan_500x500.jpg' },
  { name: 'Sunidhi Chauhan', id: '455129', image: 'https://c.saavncdn.com/artists/Sunidhi_Chauhan_005_20250515061617_500x500.jpg' },
  { name: 'Mithoon', id: '702592', image: 'https://c.saavncdn.com/artists/Mithoon_002_20200908073735_500x500.jpg' },
  { name: 'Pawan Singh', id: '456857', image: 'https://c.saavncdn.com/artists/Pawan_Singh_003_20241119074737_500x500.jpg' },
  { name: 'Neeti Mohan', id: '531639', image: 'https://c.saavncdn.com/artists/Neeti_Mohan_009_20260821092757_500x500.jpg' },
  { name: 'Shankar-Ehsaan-Loy', id: '455280', image: 'https://c.saavncdn.com/artists/Shankar_Ehsaan_Loy_002_20231107064353_500x500.jpg' },
  { name: 'Anu Malik', id: '456338', image: 'https://c.saavncdn.com/artists/Anu_Malik_500x500.jpg' },
  { name: 'Amaal Mallik', id: '743637', image: 'https://c.saavncdn.com/artists/Amaal_Mallik_004_20260224065851_500x500.jpg' },
  { name: 'Ravi Basrur', id: '697634', image: 'https://c.saavncdn.com/artists/Ravi_Basrur_002_20221011072518_500x500.jpg' },
  { name: 'Shreyas Puranik', id: '820935', image: 'https://c.saavncdn.com/artists/Shreyas_Puranik_000_20211202121951_500x500.jpg' },
].filter((a) => sanitizeArtistImage(a.image).length > 0) as ArtistInfo[];

/** Live-pool categories — the "More {label}" cycle (genuine Spotify pattern). */
export const ARTIST_CATEGORIES: Array<{ key: string; label: string; query: string }> = [
  { key: 'bollywood', label: 'Bollywood', query: 'top hindi hits' },
  { key: 'punjabi', label: 'Punjabi', query: 'punjabi hits' },
  { key: 'hiphop', label: 'Hip-Hop', query: 'hindi rap gana' },
  { key: 'romance', label: 'Romance', query: 'romantic hindi songs' },
  { key: 'indie', label: 'Indie', query: 'indie india songs' },
  { key: 'sufi', label: 'Sufi', query: 'sufi songs' },
  { key: 'retro', label: 'Retro', query: 'old hindi songs' },
  { key: 'pop', label: 'Pop', query: 'indian pop hits' },
];

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** A clean solo-artist name (no feat chains, no giant collabs). */
export function cleanArtistName(raw: string): string {
  const a = decodeEntities(raw)
    .split(' feat')[0]!
    .split(' ft.')[0]!
    .split(',')[0]!
    .trim();
  if (!a || a === 'Unknown artist' || a.length > 26) return '';
  return a;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Artist search with REAL photos — reads primary_artists from song results
 * (the only JioSaavn surface that carries genuine artist imagery inline).
 * Never throws; returns [] on failure.
 */
export async function searchSaavnArtists(query: string, limit = 24): Promise<ArtistInfo[]> {
  const out: ArtistInfo[] = [];
  const seen = new Set<string>();
  try {
    const data = await saavnGet({ __call: 'search.getResults', q: query, p: '1', n: String(Math.max(limit * 3, 40)) });
    const results = Array.isArray(data?.results) ? data.results : [];
    for (const raw of results) {
      const am = raw?.more_info?.artistMap ?? raw?.artistMap;
      const pa = am?.primary_artists?.[0];
      const name = pa ? cleanArtistName(String(pa.name ?? '')) : cleanArtistName(String(raw?.subtitle ?? ''));
      if (!name) continue;
      const k = norm(name);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({
        name,
        id: pa?.id ? String(pa.id) : undefined,
        image: sanitizeArtistImage(pa?.image) || undefined,
      });
      if (out.length >= limit) break;
    }
  } catch {
    /* offline → caller falls back to seeds */
  }
  return out;
}

const photoCache = new Map<string, string>();

/** Artist photo by JioSaavn artistId (cached; '' when unavailable). */
export async function getArtistPhoto(artistId?: string): Promise<string> {
  if (!artistId) return '';
  const cached = photoCache.get(artistId);
  if (cached !== undefined) return cached;
  let url = '';
  try {
    const data = await saavnGet({ __call: 'artist.getArtistPageDetails', artistId, n_song: '1' });
    url = sanitizeArtistImage(data?.image);
  } catch {
    /* keep '' */
  }
  photoCache.set(artistId, url);
  return url;
}

const nameToSeed = new Map<string, ArtistInfo>(ARTIST_SEEDS.map((a) => [norm(a.name), a]));

/**
 * Photo by artist NAME — seeds first (instant), then a live id lookup
 * (cached across calls). Used by Home's "Popular artists" rail and any
 * surface that knows a name from the listening profile.
 *
 * v4.0.1: joined credits ("A, B") resolve against the PRIMARY name only
 * (a search for the full joined string returns a different artist), and
 * the live hit must match the requested name EXACTLY — the old first-
 * result fallback could put a stranger's face on the hero.
 */
export async function lookupArtistPhoto(name: string): Promise<string> {
  if (!name.trim()) return '';
  const primary = name.split(',')[0]!.trim();
  const seed = nameToSeed.get(norm(primary));
  if (seed?.image) return seed.image;
  const found = await searchSaavnArtists(primary, 5);
  const hit = found.find((a) => norm(a.name) === norm(primary));
  if (hit?.image) return hit.image;
  if (hit?.id) return getArtistPhoto(hit.id);
  return '';
}
