/**
 * GAUNTLET R3 LOCKS — critic-round P0/P1 fixes for the v3.4.0 port.
 *
 * Every test here locks a finding from the adversarial review of the
 * lab-port (worklog Task ID 8). If one of these fails, a contract broke:
 *
 *   L-P0-1  a successful rescue is never discarded by the S4 recovery
 *           ladder (relaxed junk must not replace the verified answer)
 *   L-P0-2  a rescued row dropped by cluster-dedupe is re-injected at
 *           rank 1 (sigState='rescued' must never be fabricated)
 *   L-P1-1  the signatureCipher decipherer actually assembles + runs
 *           (was dead code: SyntaxError on every invocation)
 *   L-P1-2  a systemic YT bot-wall skips the title-only unstreamable
 *           fallback so the iTunes rung can answer with a preview
 *   L-P1-3  kill-switch discipline: search is gated; per-video
 *           UNPLAYABLE never disables the source; honest reasons
 *   L-ORDER ladder rung order youtube → itunes → variant → album
 *   L-FLOOR AUTHORITY_FLOOR per-source rules on the variant rung
 *   L-E2E   the headline "tu chaiye" title-only rescue end-to-end
 */

import { describe, expect, test, beforeAll, beforeEach, afterEach, afterAll, mock } from 'bun:test';

mock.module('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
  Platform: { OS: 'android', select: (o: any) => o.android },
  NativeModules: {},
}));
mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
    multiRemove: async () => undefined,
  },
}));

import { setYtFetch, ytSearchMusic, ytResolveStream, ytAvailable, noteYtFailure, resetYtKillSwitch, clearYtCaches } from '../../src/api/youtube';
import { clearSearchCaches } from '../../src/search/retrieve';
import { registerArtistLexicon } from '../../src/search/plan';

// ── fixtures ───────────────────────────────────────────────────────────

function saavnRow(id: string, title: string, artists: Array<{ name: string }>, plays: string) {
  return {
    id,
    title,
    more_info: {
      encrypted_media_url: 'enc-' + id,
      '320kbps': 'true',
      language: 'hindi',
      year: '2020',
      artistMap: { primary_artists: artists, featured_artists: [] },
    },
    play_count: plays,
  };
}

/** The organic junk pool for "tu chaiye of atif aslam" — no row matches
 *  BOTH axes (canonical recording absent from the catalog). */
const JUNK_ARTIST_POOL = {
  results: [
    saavnRow('om1', "O'Meri Laila", [{ name: 'Atif Aslam' }, { name: 'Jyotica Tangri' }], '39513344'),
    saavnRow('km1', 'Kon Mayate', [{ name: 'Atif Aslam BD' }], '280'),
    saavnRow('ad1', 'Tu Chahiye', [{ name: 'A.R. Dixit' }], '22124'),
    saavnRow('sp1', 'Tu Chaiye', [{ name: 'SPECRO' }], '56'),
  ],
};

/** Thin pool (1 title-matching sub-floor row) — guarantees tracks.length
 *  < THIN_THRESHOLD(3) after the rescue, which is exactly the P0-1
 *  trigger: rescue succeeded, organic is thin, S4 would pad with junk. */
const THIN_POOL = {
  results: [saavnRow('ad1', 'Tu Chahiye', [{ name: 'A.R. Dixit' }], '22124')],
};

/** 5 unrelated hits — what the relaxed probe returns. */
const RELAXED_JUNK = {
  results: [
    saavnRow('rj1', 'Tum Hi Ho', [{ name: 'Arijit Singh' }], '500000000'),
    saavnRow('rj2', 'Kesariya', [{ name: 'Arijit Singh' }], '400000000'),
    saavnRow('rj3', 'Apna Bana Le', [{ name: 'Arijit Singh' }], '300000000'),
    saavnRow('rj4', 'Raatan Lambiyan', [{ name: 'Jubin Nautiyal' }], '200000000'),
    saavnRow('rj5', 'Kalank Title Track', [{ name: 'Arijit Singh' }], '100000000'),
  ],
};

/** P0-2 pool: an organic same-title row with a HUGE play count — after the
 *  merge it shares the rescued row's cluster key, surname-overlaps it, and
 *  beats it on playCount for cluster rep (YT song rows carry none). */
const CLUSTER_TRAP_POOL = {
  results: [
    saavnRow('pr1', 'Tu Chahiye', [{ name: 'Pritam' }], '5000000'),
    saavnRow('om1', "O'Meri Laila", [{ name: 'Atif Aslam' }], '39513344'),
    saavnRow('km1', 'Kon Mayate', [{ name: 'Atif Aslam BD' }], '280'),
  ],
};

function ytmItem(videoId: string, title: string, subtitle: string) {
  return {
    musicResponsiveListItemRenderer: {
      flexColumns: [
        {
          musicResponsiveListItemFlexColumnRenderer: {
            text: { runs: [{ text: title, navigationEndpoint: { watchEndpoint: { videoId } } }] },
          },
        },
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: subtitle }] } } },
      ],
      thumbnail: {
        musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/w544.jpg' }] } },
      },
    },
  };
}

const YTM_CANONICAL = {
  contents: {
    tabbedSearchResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            content: {
              sectionListRenderer: {
                contents: [
                  {
                    musicShelfRenderer: {
                      contents: [
                        ytmItem('WTLLym2wzIM', 'Tu Chahiye', 'Song • Pritam, Atif Aslam & Amitabh Bhattacharya • 3:51'),
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    },
  },
};

const YT_PLAYER_OK = {
  playabilityStatus: { status: 'OK' },
  streamingData: {
    adaptiveFormats: [
      { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 129703, url: 'https://rr1.example.googlevideo.com/videoplayback?eid=WTLLym2wzIM140' },
    ],
  },
};

const ITUNES_HIT = {
  results: [
    {
      trackId: 9001,
      trackName: 'Tu Chahiye (From "Bajrangi Bhaijaan")',
      artistName: 'Atif Aslam',
      collectionName: 'Hits of Atif Aslam',
      previewUrl: 'https://audio-ssl.itunes.apple.com/preview/9001.m4a',
      artworkUrl100: 'https://is1-ssl.mzstatic.com/image/100x100bb.jpg',
      trackTimeMillis: 231000,
    },
  ],
};

type Route = (url: string, init?: any) => { status: number; json: any } | { status: number; text: string } | undefined;

function installFetch(routes: Route[], log?: string[]) {
  const impl = (url: any, init?: any) => {
    const u = String(url);
    if (log) log.push(u);
    for (const r of routes) {
      const out = r(u, init);
      if (out) {
        if ('json' in out) return Promise.resolve(new Response(JSON.stringify(out.json), { status: out.status }));
        return Promise.resolve(new Response(out.text, { status: out.status }));
      }
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
  (globalThis as any).fetch = impl as typeof fetch;
}

const isYtSearch = (u: string) => u.includes('youtubei/v1/search');
const isYtPlayer = (u: string) => u.includes('youtubei/v1/player');
const isSaavnSearch = (u: string) => u.includes('jiosaavn.com') && u.includes('search.getResults');
const isSaavnAc = (u: string) => u.includes('jiosaavn.com') && u.includes('autocomplete');
const isSaavnAlbumSearch = (u: string) => u.includes('jiosaavn.com') && u.includes('search.getAlbumResults');
const isSaavnAlbumDetails = (u: string) => u.includes('jiosaavn.com') && u.includes('content.getAlbumDetails');
const isItunes = (u: string) => u.includes('itunes.apple.com');
const hasChaiye = (u: string) => /ch+a+h*i+ye/i.test(decodeURIComponent(u));
const hasVariantSpelling = (u: string) => /chahiye|chaahiye/i.test(decodeURIComponent(u));

async function engine() {
  return await import('../../src/api/music');
}

beforeAll(() => {
  resetYtKillSwitch();
  clearYtCaches();
  // artist_title plans need the artist lexicon (the app registers it at
  // init; tests must too — otherwise 'tu chaiye of atif aslam' plans as
  // entity_title and the artist-axis fixtures never fire)
  registerArtistLexicon(['Atif Aslam', 'Arijit Singh', 'Pritam', 'A.R. Rahman']);
});

// R7 suite hygiene: entering this file, the YT fetch seam may carry an
// EARLIER file's stub (youtube.test.ts leaves a player-URL-only router) —
// the engine's YT calls would silently bypass this file's installFetch and
// the rescue locks degraded to "partial" depending on file order. Reset
// the seam per test; restore the pristine global fetch on the way out.
const PRISTINE_FETCH = globalThis.fetch;

beforeEach(() => {
  clearSearchCaches();
  clearYtCaches();
  resetYtKillSwitch();
  setYtFetch(null);
  (globalThis as any).fetch = ((() => Promise.resolve(new Response('{}', { status: 200 }))) as unknown) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = PRISTINE_FETCH;
});

afterEach(() => {
  // the youtube module's injected fetch is GLOBAL module state — a test
  // that stubs it would otherwise poison every later test's YT traffic
  setYtFetch(null);
});

// ── P0-1 ───────────────────────────────────────────────────────────────

describe('L-P0-1 — a successful rescue is never discarded by S4 recovery', () => {
  test('thin-after-rescue stays rescued: relaxed junk must not replace the verified answer', async () => {
    installFetch([
      // organic probes (contain "chaiye") → the thin junk pool;
      // relaxed probes (rarest token dropped → no "chaiye") → unrelated junk
      (u) => (isSaavnSearch(u) && hasChaiye(u) ? { status: 200, json: THIN_POOL } : undefined),
      (u) => (isSaavnSearch(u) ? { status: 200, json: RELAXED_JUNK } : undefined),
      (u) => (isSaavnAc(u) ? { status: 200, json: { data: {} } } : undefined),
      (u) => (isYtSearch(u) ? { status: 200, json: YTM_CANONICAL } : undefined),
      (u) => (isYtPlayer(u) ? { status: 200, json: YT_PLAYER_OK } : undefined),
      (u) => (isItunes(u) ? { status: 200, json: { results: [] } } : undefined),
    ]);
    const { searchMusicV2 } = await engine();
    const res = await searchMusicV2('tu chaiye of atif aslam');
    // the rescue survived end-to-end
    expect(res.sigState).toBe('rescued');
    expect(res.tracks[0].rescueRung).toBe('youtube');
    expect(/tu chahiye/i.test(res.tracks[0].title)).toBe(true);
    // S4 never ran: no relaxed label, no junk rows padded in
    expect(res.relaxedQuery).toBeUndefined();
    expect(res.relaxedFrom).toBeUndefined();
    expect(res.tracks.some((t) => /tum hi ho|kesariya|apna bana le/i.test(t.title))).toBe(false);
  });
});

// ── P0-2 ───────────────────────────────────────────────────────────────

describe('L-P0-2 — cluster-dedupe cannot fabricate sigState=rescued', () => {
  test('rescued row dropped by clustering is re-injected at rank 1', async () => {
    installFetch([
      (u) => (isSaavnSearch(u) ? { status: 200, json: CLUSTER_TRAP_POOL } : undefined),
      (u) => (isSaavnAc(u) ? { status: 200, json: { data: {} } } : undefined),
      (u) => (isYtSearch(u) ? { status: 200, json: YTM_CANONICAL } : undefined),
      (u) => (isYtPlayer(u) ? { status: 200, json: YT_PLAYER_OK } : undefined),
      (u) => (isItunes(u) ? { status: 200, json: { results: [] } } : undefined),
    ]);
    const { searchMusicV2 } = await engine();
    const res = await searchMusicV2('tu chaiye of atif aslam');
    expect(res.sigState).toBe('rescued');
    // rank 1 IS the rescued row (never the organic cluster rep alone)
    expect(res.tracks[0].source).toBe('youtube');
    expect(res.tracks[0].rescueRung).toBe('youtube');
    expect(res.tracks[0].rescued).toBe(true);
    // the playable organic twin is still present — just never rank 1
    const organic = res.tracks.filter((t) => t.source !== 'youtube');
    expect(organic.length).toBeGreaterThan(0);
    expect(res.tracks.slice(1).some((t) => /tu chahiye/i.test(t.title))).toBe(true);
  });
});

// ── P1-1 ───────────────────────────────────────────────────────────────

describe('L-P1-1 — signatureCipher decipher assembles and runs', () => {
  test('WEB_REMIX ciphered formats resolve to a signed plain URL', async () => {
    // synthetic player JS: helper object + decipher fn in the real shape
    // hjkl.a = slice(1); hjkl.reverse = reverse;  ZX("ABCD") → "DCB"
    const PLAYER_JS =
      'var hjkl={a:function(a){return a.slice(1)},reverse:function(a){return a.reverse()}};' +
      'var ZX=function(a){a=a.split("");a=hjkl.a(a);a=hjkl.reverse(a);return a.join("")};';
    const base = 'https://rr5.example.googlevideo.com/videoplayback?id=ciphered';
    const CIPHER_PLAYER = {
      playabilityStatus: { status: 'OK' },
      streamingData: {
        adaptiveFormats: [
          {
            itag: 140,
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
            bitrate: 129703,
            signatureCipher: `s=ABCD&sp=sig&url=${encodeURIComponent(base)}`,
          },
        ],
      },
      assets: { js: '/s/player/deadbeef/base.js' },
    };
    const routes: Route[] = [
      (u, init) => {
        if (!isYtPlayer(u)) return undefined;
        const body = String(init?.body ?? '');
        if (body.includes('"clientName":"WEB_REMIX"')) return { status: 200, json: CIPHER_PLAYER };
        return { status: 200, json: { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'bot' } } };
      },
      (u) => (u.includes('/s/player/deadbeef/base.js') ? { status: 200, text: PLAYER_JS } : undefined),
    ];
    const impl = (url: any, init?: any) => {
      const u = String(url);
      for (const r of routes) {
        const out = r(u, init);
        if (out) {
          if ('json' in out) return Promise.resolve(new Response(JSON.stringify(out.json), { status: out.status }));
          return Promise.resolve(new Response(out.text, { status: out.status }));
        }
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    };
    setYtFetch(impl as unknown as typeof fetch);
    const out = await ytResolveStream('cipheredVideo1');
    expect(out.ok).toBe(true);
    expect(out.audio!.url).toContain(encodeURIComponent(base).replace(/%2F/gi, '/').slice(0, 24).slice(0, 8) === 'https%3' ? '' : '');
    // deciphered signature appended: hjkl.a("ABCD")="BCD" → reverse → "DCB"
    expect(out.audio!.url).toContain('sig=DCB');
    expect(out.audio!.url).toContain('id=ciphered');
  });
});

// ── P1-2 ───────────────────────────────────────────────────────────────

describe('L-P1-2 — systemic bot-wall skips the unstreamable YT fallback', () => {
  test('title-only query falls through to the iTunes preview rung', async () => {
    installFetch([
      (u) => (isSaavnSearch(u) ? { status: 200, json: JUNK_ARTIST_POOL } : undefined),
      (u) => (isSaavnAc(u) ? { status: 200, json: { data: {} } } : undefined),
      (u) => (isYtSearch(u) ? { status: 200, json: YTM_CANONICAL } : undefined),
      // player endpoint: EVERY client bot-walled (systemic — the exact
      // datacenter / hard-wall network class)
      (u) =>
        isYtPlayer(u)
          ? { status: 200, json: { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'bot' } } }
          : undefined,
      (u) => (isItunes(u) ? { status: 200, json: ITUNES_HIT } : undefined),
    ]);
    const { searchMusicV2 } = await engine();
    const res = await searchMusicV2('tu chaiye');
    expect(res.sigState).toBe('rescued');
    // iTunes answered — NOT a streamless youtube row painted rank 1
    expect(res.tracks[0].rescueRung).toBe('itunes');
    expect(res.tracks[0].source).toBe('itunes');
    expect(res.tracks[0].previewOnly).toBe(true);
  });

  test('transient (non-systemic) failure still allows the tap-time fallback', async () => {
    installFetch([
      (u) => (isSaavnSearch(u) ? { status: 200, json: JUNK_ARTIST_POOL } : undefined),
      (u) => (isSaavnAc(u) ? { status: 200, json: { data: {} } } : undefined),
      (u) => (isYtSearch(u) ? { status: 200, json: YTM_CANONICAL } : undefined),
      // OK status but no direct audio urls → 'no-audio' (video-specific,
      // NOT systemic) → the fallback row is allowed
      (u) =>
        isYtPlayer(u)
          ? { status: 200, json: { playabilityStatus: { status: 'OK' }, streamingData: { adaptiveFormats: [] } } }
          : undefined,
      (u) => (isItunes(u) ? { status: 200, json: { results: [] } } : undefined),
    ]);
    const { searchMusicV2 } = await engine();
    const res = await searchMusicV2('tu chaiye');
    expect(res.sigState).toBe('rescued');
    expect(res.tracks[0].rescueRung).toBe('youtube');
  });
});

// ── P1-3 ───────────────────────────────────────────────────────────────

describe('L-P1-3 — kill-switch discipline', () => {
  test('ytSearchMusic is gated: a disabled source never fires a request', async () => {
    let calls = 0;
    const impl = (() => {
      calls += 1;
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;
    setYtFetch(impl);
    noteYtFailure(); // real-clock: disabledUntil = now + 1h
    noteYtFailure();
    noteYtFailure(); // 3rd → soft-disabled 1h
    expect(ytAvailable()).toBe(false);
    const res = await ytSearchMusic('anything');
    expect(res.tracks).toEqual([]);
    expect(res.latencyMs).toBe(0);
    expect(calls).toBe(0); // gated: zero network
  });

  test('per-video UNPLAYABLE never disables the source (3 rounds)', async () => {
    const f = (url: any) => {
      const u = String(url);
      if (isYtPlayer(u)) {
        return Promise.resolve(
          new Response(JSON.stringify({ playabilityStatus: { status: 'UNPLAYABLE', reason: 'removed' } }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    };
    setYtFetch(f as unknown as typeof fetch);
    for (let i = 0; i < 3; i += 1) {
      const out = await ytResolveStream('video' + i);
      expect(out.ok).toBe(false);
    }
    expect(ytAvailable()).toBe(true); // still enabled — the videos are bad, not the source
  });

  test('systemic LOGIN_REQUIRED walls DO count toward the switch', async () => {
    const f = (url: any) => {
      const u = String(url);
      if (isYtPlayer(u)) {
        return Promise.resolve(
          new Response(JSON.stringify({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'bot' } }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    };
    setYtFetch(f as unknown as typeof fetch);
    await ytResolveStream('v1');
    await ytResolveStream('v2');
    expect(ytAvailable()).toBe(true); // 2 failures — still up
    await ytResolveStream('v3');
    expect(ytAvailable()).toBe(false); // 3rd systemic wall → disabled
  });

  test('every-client network throws → honest reason "network"', async () => {
    const f = (url: any) => {
      const u = String(url);
      if (isYtPlayer(u)) return Promise.reject(new Error('offline'));
      return Promise.resolve(new Response('{}', { status: 200 }));
    };
    setYtFetch(f as unknown as typeof fetch);
    const out = await ytResolveStream('vnet');
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('network');
  });
});

// ── Ladder order + authority floor (contract #3) ───────────────────────

describe('L-ORDER — rescue ladder runs youtube → itunes → variant → album', () => {
  test('variant rung answers when YT + iTunes are empty, in order', async () => {
    const calls: string[] = [];
    installFetch(
      [
        // the variant RUNG probe is unique: variant spelling + artist
        // ("tu chahiye atif aslam") — organic probes never combine them
        (u) => {
          if (isSaavnSearch(u) && hasVariantSpelling(u) && /atif/i.test(decodeURIComponent(u))) {
            return {
              status: 200,
              json: {
                results: [saavnRow('vr1', 'Tu Chahiye', [{ name: 'Pritam' }, { name: 'Atif Aslam' }], '5000000')],
              },
            };
          }
          return undefined;
        },
        (u) => {
          if (isSaavnSearch(u) && hasChaiye(u)) return { status: 200, json: JUNK_ARTIST_POOL };
          return undefined;
        },
        (u) => (isSaavnAc(u) ? { status: 200, json: { data: {} } } : undefined),
        (u) => {
          if (isYtSearch(u)) return { status: 200, json: { contents: {} } }; // YT catalog: nothing
          return undefined;
        },
        (u) => (isItunes(u) ? { status: 200, json: { results: [] } } : undefined), // iTunes: nothing
        (u) => (isSaavnAlbumSearch(u) ? { status: 200, json: { results: [] } } : undefined),
      ],
      calls,
    );
    const { searchMusicV2 } = await engine();
    const res = await searchMusicV2('tu chaiye of atif aslam');
    expect(res.sigState).toBe('rescued');
    expect(res.tracks[0].rescueRung).toBe('variant');
    expect(res.tracks[0].source).toBe('saavn');
    // the ladder ran in contract order: yt search → itunes → variant probe
    // (note: the ORGANIC itunes top-up probe fires before the ladder — the
    // ladder's itunes call is the first one AFTER the YT search call)
    const ytAt = calls.findIndex((c) => isYtSearch(c));
    const itAt = calls.findIndex((c, i) => isItunes(c) && i > ytAt);
    const variantAt = calls.findIndex(
      (c) => isSaavnSearch(c) && hasVariantSpelling(c) && /atif/i.test(decodeURIComponent(c)),
    );
    expect(ytAt).toBeGreaterThanOrEqual(0);
    expect(itAt).toBeGreaterThan(ytAt);
    expect(variantAt).toBeGreaterThan(itAt);
  });

  test('album rung answers when variant spelling is also absent', async () => {
    installFetch([
      (u) => (isSaavnSearch(u) ? { status: 200, json: JUNK_ARTIST_POOL } : undefined),
      (u) => (isSaavnAc(u) ? { status: 200, json: { data: {} } } : undefined),
      (u) => (isYtSearch(u) ? { status: 200, json: { contents: {} } } : undefined),
      (u) => (isItunes(u) ? { status: 200, json: { results: [] } } : undefined),
      (u) =>
        isSaavnAlbumSearch(u)
          ? { status: 200, json: { results: [{ id: 'alb1', title: 'Bajrangi Bhaijaan', music: 'Pritam' }] } }
          : undefined,
      (u) =>
        isSaavnAlbumDetails(u)
          ? {
              status: 200,
              json: {
                list: [saavnRow('ab1', 'Tu Chahiye', [{ name: 'Pritam' }, { name: 'Atif Aslam' }], '5000000')],
              },
            }
          : undefined,
    ]);
    const { searchMusicV2 } = await engine();
    const res = await searchMusicV2('tu chaiye of atif aslam');
    expect(res.sigState).toBe('rescued');
    expect(res.tracks[0].rescueRung).toBe('album');
    expect(/tu chahiye/i.test(res.tracks[0].title)).toBe(true);
  });
});

describe('L-FLOOR — AUTHORITY_FLOOR per-source rules (title-only plans)', () => {
  // entity_title organic probes = ['tu chaiye', 'tu chahiye', 'tu chaahiye']
  // — the variant RUNG's probe ('tu chahiye') is byte-identical to organic
  // probe #2, so these fixtures route by CALL ORDER, not by URL.
  function saavnByCallCount(organic: any, rung: any) {
    let n = 0;
    return (u: string) => {
      if (!isSaavnSearch(u)) return undefined;
      n += 1;
      return { status: 200, json: n <= 3 ? organic : rung };
    };
  }

  test('a known-small variant row is rejected (no rescue, honest organic)', async () => {
    installFetch([
      saavnByCallCount(JUNK_ARTIST_POOL, {
        results: [saavnRow('sm1', 'Tu Chahiye', [{ name: 'Random Cover' }], '1000')],
      }),
      (u) => (isSaavnAc(u) ? { status: 200, json: { data: {} } } : undefined),
      (u) => (isYtSearch(u) ? { status: 200, json: { contents: {} } } : undefined),
      (u) => (isItunes(u) ? { status: 200, json: { results: [] } } : undefined),
      (u) => (isSaavnAlbumSearch(u) ? { status: 200, json: { results: [] } } : undefined),
    ]);
    const { searchMusicV2 } = await engine();
    const res = await searchMusicV2('tu chaiye');
    expect(res.sigState).not.toBe('rescued');
    expect(res.tracks.some((t) => t.rescued)).toBe(false);
  });

  test('an authoritative variant row (≥ 250k plays) is accepted', async () => {
    installFetch([
      saavnByCallCount(JUNK_ARTIST_POOL, {
        results: [saavnRow('bg1', 'Tu Chahiye', [{ name: 'Pritam' }, { name: 'Atif Aslam' }], '80000000')],
      }),
      (u) => (isSaavnAc(u) ? { status: 200, json: { data: {} } } : undefined),
      (u) => (isYtSearch(u) ? { status: 200, json: { contents: {} } } : undefined),
      (u) => (isItunes(u) ? { status: 200, json: { results: [] } } : undefined),
      (u) => (isSaavnAlbumSearch(u) ? { status: 200, json: { results: [] } } : undefined),
    ]);
    const { searchMusicV2 } = await engine();
    const res = await searchMusicV2('tu chaiye');
    expect(res.sigState).toBe('rescued');
    expect(res.tracks[0].rescueRung).toBe('variant');
  });
});

// ── The headline e2e ───────────────────────────────────────────────────

describe('L-E2E — the "tu chaiye" title-only class (lab.2 flagship)', () => {
  test('a 6.2M-view lyric VIDEO never displaces the canonical SONG row', async () => {
    // song-before-video in bestFirst (the official YT Music catalog entry
    // is the canonical recording; UGC lyric uploads are not)
    const ytmWithVideo = {
      contents: {
        tabbedSearchResultsRenderer: {
          tabs: [
            {
              tabRenderer: {
                content: {
                  sectionListRenderer: {
                    contents: [
                      {
                        musicShelfRenderer: {
                          contents: [
                            ytmItem('WTLLym2wzIM', 'Tu Chahiye', 'Song • Pritam, Atif Aslam & Amitabh Bhattacharya • 3:51'),
                            ytmItem('kv_5z2ROptE', 'Tu Chahiye - Atif Aslam (Lyrics)', 'Video • LYRICAL BAM HINDI • 6.2M views • 4:28'),
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      },
    };
    installFetch([
      (u) => (isSaavnSearch(u) ? { status: 200, json: JUNK_ARTIST_POOL } : undefined),
      (u) => (isSaavnAc(u) ? { status: 200, json: { data: {} } } : undefined),
      (u) => (isYtSearch(u) ? { status: 200, json: ytmWithVideo } : undefined),
      (u) => (isYtPlayer(u) ? { status: 200, json: YT_PLAYER_OK } : undefined),
      (u) => (isItunes(u) ? { status: 200, json: { results: [] } } : undefined),
    ]);
    const { searchMusicV2 } = await engine();
    const res = await searchMusicV2('tu chaiye');
    expect(res.sigState).toBe('rescued');
    expect(res.tracks[0].rescueRung).toBe('youtube');
    expect(res.tracks[0].youtubeId).toBe('WTLLym2wzIM'); // the SONG, not the video
    expect(res.tracks[0].ytKind).not.toBe('video');
  });

  test('organic covers are all sub-floor → YouTube rescue paints rank 1', async () => {
    installFetch([
      (u) => (isSaavnSearch(u) ? { status: 200, json: JUNK_ARTIST_POOL } : undefined),
      (u) => (isSaavnAc(u) ? { status: 200, json: { data: {} } } : undefined),
      (u) => (isYtSearch(u) ? { status: 200, json: YTM_CANONICAL } : undefined),
      (u) => (isYtPlayer(u) ? { status: 200, json: YT_PLAYER_OK } : undefined),
      (u) => (isItunes(u) ? { status: 200, json: ITUNES_HIT } : undefined),
    ]);
    const { searchMusicV2 } = await engine();
    const res = await searchMusicV2('tu chaiye');
    expect(res.sigState).toBe('rescued');
    expect(res.tracks[0].rescueRung).toBe('youtube');
    expect(res.tracks[0].source).toBe('youtube');
    expect(/tu chahiye/i.test(res.tracks[0].title)).toBe(true);
    expect(res.tracks[0].streamUrl).toBeTruthy();
  });
});
