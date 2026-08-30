/**
 * Web-harness fixtures — deterministic, realistic JioSaavn-shaped data
 * (real CDN artwork) so the browser screenshot rig renders the app with
 * authentic content. WEB ONLY — never bundled into the Android build
 * (metro.config.js redirects src/api/* → these mocks for platform web).
 */

import type { Track, Collection } from '../types';

export const art = {
  cocktail2: 'https://c.saavncdn.com/689/Cocktail-2-Hindi-2026-20260629161048-500x500.jpg',
  mashooqa: 'https://c.saavncdn.com/465/Mashooqa-From-Cocktail-2-Hindi-2026-20260519130936-500x500.jpg',
  dhurandhar: 'https://c.saavncdn.com/581/Dhurandhar-The-Revenge-Hindi-2026-20260409161002-500x500.jpg',
  toxic: 'https://c.saavncdn.com/355/Toxic-Original-Motion-Picture-Soundtrack-Hindi-2026-20260818072032-500x500.jpg',
  awarapan: 'https://c.saavncdn.com/820/Awarapan-2-Hindi-2026-20260811181221-500x500.jpg',
  boom: 'https://c.saavncdn.com/307/Boom-Shaka-Hindi-2026-20260428064906-500x500.jpg',
  raksha: 'https://c.saavncdn.com/440/Raksha-Bandhan-Hindi-2022-20230212112927-500x500.jpg',
  meera: 'https://c.saavncdn.com/708/Meera-Ke-Krishna-Hindi-2025-20250116102117-500x500.jpg',
  hanuman: 'https://c.saavncdn.com/058/Hanuman-Ansh-Original-Motion-Picture-Soundtrack-Hindi-2026-20260710211303-500x500.jpg',
  trending: 'https://c.saavncdn.com/editorial/NowTrending_20260423085344.jpg',
  lofi: 'https://c.saavncdn.com/editorial/ChillMaaro-LoFiMix_20260403095103.jpg',
  old: 'https://c.saavncdn.com/editorial/OldHindiHits_20250826092719.jpg',
  emraan: 'https://c.saavncdn.com/732/Emraan-Hashmi-Sad-Love-Hits-Hindi-2026-20260604155755-500x500.jpg',
};

export const TRACKS: Track[] = [
  { id: 'w1', title: 'Mashooqa', artist: 'Pritam, Shilpa Rao', album: 'Cocktail 2', albumId: 'a1', artwork: art.mashooqa, duration: 224, source: 'saavn', previewOnly: false, encryptedUrl: 'mock://w1' },
  { id: 'w2', title: 'Dhurandhar', artist: 'G.V. Prakash Kumar', album: 'Dhurandhar The Revenge', albumId: 'a2', artwork: art.dhurandhar, duration: 198, source: 'saavn', previewOnly: false, encryptedUrl: 'mock://w2' },
  { id: 'w3', title: 'Toxic (Title Track)', artist: 'Sachet-Parampara', album: 'Toxic', albumId: 'a3', artwork: art.toxic, duration: 187, source: 'saavn', previewOnly: false, encryptedUrl: 'mock://w3' },
  { id: 'w4', title: 'Awarapan 2 Theme', artist: 'Mithoon', album: 'Awarapan 2', albumId: 'a4', artwork: art.awarapan, duration: 241, source: 'saavn', previewOnly: false, encryptedUrl: 'mock://w4' },
  { id: 'w5', title: 'Boom Shaka', artist: 'Dhanda Nyoliwala, KR$NA', album: 'Boom Shaka', albumId: 'a5', artwork: art.boom, duration: 176, source: 'saavn', previewOnly: false, encryptedUrl: 'mock://w5' },
  { id: 'w6', title: 'Raksha Bandhan (Title Track)', artist: 'Shreya Ghoshal', album: 'Raksha Bandhan', albumId: 'a6', artwork: art.raksha, duration: 210, source: 'saavn', previewOnly: false, encryptedUrl: 'mock://w6' },
  { id: 'w7', title: 'Meera Ke Krishna', artist: 'Jasleen Royal', album: 'Meera Ke Krishna', albumId: 'a7', artwork: art.meera, duration: 232, source: 'saavn', previewOnly: false, encryptedUrl: 'mock://w7' },
  { id: 'w8', title: 'Hanuman Ansh', artist: 'Amit Trivedi', album: 'Hanuman Ansh', albumId: 'a8', artwork: art.hanuman, duration: 205, source: 'saavn', previewOnly: false, encryptedUrl: 'mock://w8' },
  { id: 'w9', title: 'Chill Maaro (Lo-Fi)', artist: 'Lo-Fi Nation', album: 'Chill Maaro: Lo-Fi Mix', albumId: 'a9', artwork: art.lofi, duration: 189, source: 'saavn', previewOnly: false, encryptedUrl: 'mock://w9' },
  { id: 'w10', title: 'Tere Bina (Sad Version)', artist: 'Arijit Singh', album: 'Emraan Hashmi Sad Love Hits', albumId: 'a10', artwork: art.emraan, duration: 268, source: 'saavn', previewOnly: false, encryptedUrl: 'mock://w10' },
  { id: 'w11', title: 'Old Hindi Medley', artist: 'Kishore Kumar', album: 'Old Hindi Hits', albumId: 'a11', artwork: art.old, duration: 254, source: 'saavn', previewOnly: false, encryptedUrl: 'mock://w11' },
  { id: 'w12', title: 'Cocktail Nights', artist: 'Tanishk Bagchi', album: 'Cocktail 2', albumId: 'a1', artwork: art.cocktail2, duration: 203, source: 'saavn', previewOnly: false, encryptedUrl: 'mock://w12' },
];

export const CHARTS: Collection[] = [
  { id: 'chart-1', title: 'Now Trending', subtitle: 'Spotify', artwork: art.trending, kind: 'chart' },
  { id: 'chart-2', title: 'Bollywood Chartbusters', subtitle: 'Spotify', artwork: art.cocktail2, kind: 'chart' },
  { id: 'chart-3', title: 'Punjabi 101', subtitle: 'Spotify', artwork: art.boom, kind: 'chart' },
  { id: 'chart-4', title: 'Lo-Fi Beats', subtitle: 'Spotify', artwork: art.lofi, kind: 'chart' },
  { id: 'chart-5', title: 'Old Hindi Hits', subtitle: 'Spotify', artwork: art.old, kind: 'chart' },
];

/**
 * SEARCH V2 fixture pool — the exact live-probe evidence the plan's
 * gauntlet bars are built on (S1/S2/S5: dupes, cover, Bandhu, lyric
 * snippet). WEB ONLY, merged only into search results.
 */
export const SEARCH_EXTRA: Track[] = [
  {
    id: 'saavn-thh1',
    saavnId: 'thh1',
    title: 'Tum Hi Ho',
    artist: 'Mithoon, Arijit Singh',
    artistsFull: ['Mithoon', 'Arijit Singh'],
    album: 'Aashiqui 2',
    artwork: art.emraan,
    duration: 257,
    source: 'saavn',
    previewOnly: false,
    encryptedUrl: 'mock://thh1',
    year: 2013,
    playCount: 371299372,
    hasLyrics: true,
    lyricsSnippet: 'Tere Bina Kya Wajood Mera',
  },
  {
    id: 'saavn-thh2',
    saavnId: 'thh2',
    title: 'Tum Hi Ho (From "Aashiqui 2")',
    artist: 'Mithoon, Arijit Singh',
    artistsFull: ['Mithoon', 'Arijit Singh'],
    album: 'Aashiqui 2 (Re-release)',
    artwork: art.emraan,
    duration: 257,
    source: 'saavn',
    previewOnly: false,
    encryptedUrl: 'mock://thh2',
    year: 2025,
    playCount: 371300737,
    hasLyrics: true,
    lyricsSnippet: 'Tere Bina Kya Wajood Mera',
  },
  {
    id: 'saavn-thh3',
    saavnId: 'thh3',
    title: 'Tum Hi Ho (From "Aashiqui 2")',
    artist: 'Mithoon, Arijit Singh',
    artistsFull: ['Mithoon', 'Arijit Singh'],
    album: 'Aashiqui 2 (2026 Edition)',
    artwork: art.emraan,
    duration: 257,
    source: 'saavn',
    previewOnly: false,
    encryptedUrl: 'mock://thh3',
    year: 2026,
    playCount: 371300737,
    hasLyrics: true,
    lyricsSnippet: 'Tere Bina Kya Wajood Mera',
  },
  {
    id: 'saavn-thhc',
    saavnId: 'thhc',
    title: 'Tum Hi Ho - Cover',
    artist: 'Shahid Mallya',
    artistsFull: ['Shahid Mallya'],
    album: 'Covers, Vol. 4',
    artwork: art.old,
    duration: 244,
    source: 'saavn',
    previewOnly: false,
    encryptedUrl: 'mock://thhc',
    year: 2019,
    playCount: 1204533,
  },
  {
    id: 'saavn-thhb',
    saavnId: 'thhb',
    title: 'Tum Hi Ho Bandhu',
    artist: 'Pritam, Shreya Ghoshal',
    artistsFull: ['Pritam', 'Shreya Ghoshal'],
    album: 'F.A.L.T.U',
    artwork: art.cocktail2,
    duration: 271,
    source: 'saavn',
    previewOnly: false,
    encryptedUrl: 'mock://thhb',
    year: 2011,
    playCount: 58201994,
  },
  {
    id: 'saavn-arl1',
    saavnId: 'arl1',
    title: 'Apna Bana Le',
    artist: 'Arijit Singh, Sachin-Jigar',
    artistsFull: ['Arijit Singh', 'Sachin-Jigar'],
    album: 'Bhediya',
    artwork: art.mashooqa,
    duration: 263,
    source: 'saavn',
    previewOnly: false,
    encryptedUrl: 'mock://arl1',
    year: 2022,
    playCount: 480293154,
    hasLyrics: true,
    lyricsSnippet: 'Tere Bina Jiya Jaaye Na',
  },
];

/**
 * SIG RESCUE FIXTURE (v3.4.0 harness): the "tu chaiye" class. JioSaavn's
 * catalog holds only a deep-niche same-name cover (sub-AUTHORITY_FLOOR),
 * while the canonical recording lives on YouTube — exactly the
 * title-authority-gap the rescue ladder exists to close.
 */
export const SIG_COVER: Track = {
  id: 'saavn-spc1',
  saavnId: 'spc1',
  title: 'Tu Chaiye',
  artist: 'SPECRO',
  artistsFull: ['SPECRO'],
  album: 'Tu Chaiye - Single',
  artwork: art.boom,
  duration: 209,
  source: 'saavn',
  previewOnly: false,
  encryptedUrl: 'mock://spc1',
  year: 2023,
  playCount: 56,
};

/** YOUTUBE SOURCE fixtures (v3.4.0 harness) — the YT Music catalog side. */
export const YT_TRACKS: Track[] = [
  {
    id: 'yt-WTLLym2wzIM',
    youtubeId: 'WTLLym2wzIM',
    ytKind: 'song',
    title: 'Tu Chahiye',
    artist: 'Pritam, Atif Aslam & Amitabh Bhattacharya',
    artistsFull: ['Pritam', 'Atif Aslam', 'Amitabh Bhattacharya'],
    artwork: art.raksha,
    duration: 231,
    source: 'youtube',
    previewOnly: false,
    year: 2015,
  },
  {
    id: 'yt-sDKLK127GVA',
    youtubeId: 'sDKLK127GVA',
    ytKind: 'song',
    title: 'TU CHAHIYE (Lo-Fi Mix): DJ Moody',
    artist: 'Salman Khan, Kareena Kapoor Khan | Atif Aslam',
    artistsFull: ['DJ Moody', 'Atif Aslam'],
    artwork: art.lofi,
    duration: 309,
    source: 'youtube',
    previewOnly: false,
    playCount: 188000,
    year: 2023,
  },
  {
    id: 'yt-kv5z2ROptE',
    youtubeId: 'kv_5z2ROptE',
    ytKind: 'video',
    title: 'Tu Chahiye - Atif Aslam (Lyrics)',
    artist: 'LYRICAL BAM HINDI',
    artistsFull: ['LYRICAL BAM HINDI'],
    artwork: art.trending,
    duration: 268,
    source: 'youtube',
    previewOnly: false,
    playCount: 6200000,
    year: 2021,
  },
];

/** YT search fixture: title/artist match with the SAME orthographic folds
 *  the real YT catalog applies (chaiye ↔ chahiye ↔ chaahiye) — an exact
 *  substring match would miss the canonical row for "tu chaiye" (the real
 *  InnerTube search is spelling-loose). Songs before videos. */
const foldOrtho = (s: string): string =>
  s.toLowerCase().replace(/ch+a+h*i+ye/g, 'chahiye');

export function ytSearchFixtures(query: string, limit: number): Track[] {
  const q = foldOrtho(query.trim());
  const matched = YT_TRACKS.filter((t) => {
    const hay = foldOrtho(`${t.title} ${t.artist}`);
    return hay.includes(q);
  });
  // parity with the real ytSearchMusic: songs before videos
  const ordered = [...matched.filter((t) => t.ytKind !== 'video'), ...matched.filter((t) => t.ytKind === 'video')];
  if (ordered.length === 0) {
    // token fallback so natural-language probes still hit
    const tokens = q.split(/\s+/).filter((t) => t.length >= 3);
    if (tokens.length >= 1) {
      const loose = YT_TRACKS.filter((t) => {
        const hay = foldOrtho(`${t.title} ${t.artist}`);
        return tokens.some((tk) => hay.includes(tk));
      });
      return [...loose.filter((t) => t.ytKind !== 'video'), ...loose.filter((t) => t.ytKind === 'video')].slice(0, limit);
    }
  }
  return ordered.slice(0, limit);
}

/** Search results: honest matching — a no-match returns [] (S6 fix);
 *  only genuine title/artist/album hits return rows. */
export function searchFixtures(query: string, limit: number): Track[] {
  const q = query.trim().toLowerCase();
  const pool = [...TRACKS, ...SEARCH_EXTRA, SIG_COVER];
  const matched = pool.filter(
    (t) =>
      t.title.toLowerCase().includes(q) ||
      t.artist.toLowerCase().includes(q) ||
      (t.album ?? '').toLowerCase().includes(q) ||
      (t.lyricsSnippet ?? '').toLowerCase().includes(q),
  );
  // relaxation ladder / lyric windows may query fragments — token-match
  // fallback keeps multi-word probes useful (matches ≥2 tokens)
  if (matched.length === 0) {
    const tokens = q.split(/\s+/).filter((t) => t.length >= 3);
    if (tokens.length >= 2) {
      return pool
        .filter((t) => {
          const hay = `${t.title} ${t.artist} ${t.album ?? ''} ${t.lyricsSnippet ?? ''}`.toLowerCase();
          const hits = tokens.filter((tk) => hay.includes(tk)).length;
          return hits >= Math.max(2, tokens.length - 1);
        })
        .slice(0, limit);
    }
  }
  return matched.slice(0, limit);
}

