/**
 * HYGIENE BEHAVIORAL LOCKS — v4.3.1 (the auditor's BAR 1).
 *
 * An adversarial auditor ran 12 mutations against v4.3.0 and 6 SURVIVED.
 * The worst class: deleting `filterClean()` from the blend and focus
 * paths kept the suite green, because the old "locks" only grepped
 * mindbeat.ts for the string `filterClean(reconcileRecordings(rows))` —
 * a string that exists at MULTIPLE call sites (focus, blend, soundAlike).
 * A source grep cannot tell WHO the string belongs to.
 *
 * These locks drive the REAL mindbeat facade and watch the OUTPUT:
 *   · buildBlendPlaylist — a friend's DNA code resolves a real playlist;
 *     an explicit-flagged row and a blocklisted title are injected as the
 *     FIRST catalog rows and must never land in the saved playlist
 *     (persistence read back through the real store, not a mock capture).
 *   · focusPicks — the seed's catalog rows include an explicit row that
 *     is ALSO a real baked low-energy song (e = 0.42 ≤ FOCUS.maxEnergy),
 *     so the ONLY thing standing between it and the queue is the
 *     hygiene gate. Deleting filterClean makes the test RED — proven.
 *
 * THE NETWORK SEAM: the catalog is mocked at the api/saavn MODULE — but
 * with real-delegation: every export except getArtistTracks is the REAL
 * function (spread from the module itself), so other test files in this
 * process keep testing the real code. getArtistTracks is overridden with
 * an injected fixture array because the REAL one already ends in
 * filterClean(pool) (the wave-6 critic fix) — routing fixtures through
 * it would pre-clean them and make mindbeat's own law-⑨ gate
 * UNMUTATABLE (the exact survivor the first harness run caught: the
 * gate can be deleted with zero behavioral change when rows arrive
 * pre-filtered). The fixtures below therefore land at mindbeat's gate
 * UNFILTERED, which is the seam the law actually governs.
 *
 * Facade boot in the lab: expo-sqlite throws ⇒ init() degrades honestly
 * (ledger null). The focus lock then injects a minimal fake ledger into
 * the PUBLIC field AFTER ready() (init's failure path would clobber an
 * earlier injection with null) — focusPicks only needs the gate to pass.
 */

import { describe, expect, test, mock } from 'bun:test';

// bun hoists static imports above runtime mocks → dynamic imports below.

const memStore = new Map<string, string>();
mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => memStore.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      memStore.set(k, v);
    },
    removeItem: async (k: string) => {
      memStore.delete(k);
    },
    multiRemove: async (ks: string[]) => {
      for (const k of ks) memStore.delete(k);
    },
  },
}));
mock.module('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: 'active' },
  Platform: { OS: 'android', select: (o: any) => o.android },
  NativeModules: {},
}));
mock.module('expo-sqlite', () => ({
  openDatabaseAsync: async () => {
    throw new Error('bun lab: no sqlite');
  },
  openDatabaseSync: () => {
    throw new Error('bun lab: no sqlite');
  },
}));
mock.module('react-native-track-player', () => ({
  default: { setVolume: async () => undefined, setRate: async () => undefined },
}));

// ── the fixture catalog, injected at the catalog seam ───────────────────
// Real baked rows (assets/baked_features.json) keep the focus path's
// baked gate honest: 'bad guy' e=0.42, 'happier than ever' e=0.23,
// 'everything i wanted' e=0.23 — all ≤ FOCUS.maxEnergy (0.45).

interface FixtureRow {
  id: string;
  title: string;
  artist: string;
  duration: number;
  explicit?: boolean;
}
const fixture = (id: string, title: string, artist: string, over: Partial<FixtureRow> = {}): FixtureRow => ({
  id,
  title,
  artist,
  duration: 200,
  ...over,
});

const ARCTIC_PROFANE = fixture('hyg-fx-fakepath', 'fake path (fuck version)', 'arctic monkeys'); // blocklist drop
const ARCTIC_CLEAN = fixture('hyg-fx-bodypaint', 'body paint', 'arctic monkeys');
const BILLIE_EXPLICIT = fixture('hyg-fx-badguy', 'bad guy', 'billie eilish', { explicit: true }); // provider-flag drop
const BILLIE_CLEAN = fixture('hyg-fx-happier', 'happier than ever', 'billie eilish');
const BILLIE_CLEAN2 = fixture('hyg-fx-everything', 'everything i wanted', 'billie eilish');

const ARTIST_ROWS: Record<string, FixtureRow[]> = {
  'arctic monkeys': [ARCTIC_PROFANE, ARCTIC_CLEAN], // profane FIRST — filterClean must skip it
  'billie eilish': [BILLIE_EXPLICIT, BILLIE_CLEAN, BILLIE_CLEAN2], // explicit FIRST
};

// Real-delegation mock: only getArtistTracks is overridden (with
// UNFILTERED fixtures — see the seam note above); every other export is
// the real function, so nothing leaks to the files that follow.
const realSaavn = await import('../../src/api/saavn');
mock.module('../../src/api/saavn', () => ({
  ...realSaavn,
  getArtistTracks: async (artistName: string) =>
    ARTIST_ROWS[artistName] ?? realSaavn.getArtistTracks(artistName),
}));

const { loadFeatureTable } = await import('../../src/ai/core/featureTable');
await loadFeatureTable(); // the baked gate is REAL — 7MB parse, ~130ms in the lab

const { mindbeat } = await import('../../src/ai/mindbeat');
const { encodeTasteDna } = await import('../../src/ai/tasteDna');
const { getPlaylists } = await import('../../src/storage/store');

// The boot degrades honestly (no sqlite in the lab) — one shared ready().
await mindbeat.ready();

const FRIEND_DNA = {
  v: 1,
  artists: [
    { n: 'arctic monkeys', w: 2 },
    { n: 'billie eilish', w: 2 },
  ],
  genres: [{ n: 'pop', w: 1 }],
  energy: 0.4,
  valence: 0.5,
  at: 1_760_000_000_000,
};

describe('v4.3.1 · auditor BAR 1 — buildBlendPlaylist hygiene is BEHAVIORAL', () => {
  test('an explicit row and a blocklisted title NEVER land in the saved playlist', async () => {
    const code = encodeTasteDna(FRIEND_DNA);
    expect(code).toBeTruthy();

    const result = await mindbeat.buildBlendPlaylist(code!);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    // the blend resolved BOTH artists (bridge path — the lab profile is empty)
    expect(result.bridge).toBe(2);
    expect(result.added).toBe(3); // 5 catalog rows − 2 hygiene drops (explicit + profane)

    // the RETURNED playlist is clean, in resolution order
    const pl = await getPlaylists();
    const saved = pl.find((x) => x.name === result.name);
    expect(saved).toBeTruthy();
    const ids = saved!.tracks.map((t) => t.id);
    expect(ids).toEqual([
      'hyg-fx-bodypaint', // arctic first (name-asc tie), the profane row BEFORE it never arrives
      'hyg-fx-happier', // billie rows in catalog order, the explicit 'bad guy' first row never arrives
      'hyg-fx-everything',
    ]);
  });
});

describe('v4.3.1 · auditor BAR 1 — focusPicks hygiene is BEHAVIORAL', () => {
  test('an explicit BAKED-LOW-ENERGY row never queues (only the hygiene gate stands between)', async () => {
    // post-boot injection: init()'s failure path sets ledger = null, so an
    // earlier assignment would be clobbered — focusPicks only needs the gate.
    mindbeat.ledger = { getListens: async () => [] } as unknown as (typeof mindbeat).ledger;

    const seed = {
      id: 'hyg-seed',
      title: 'happier than ever',
      artist: 'billie eilish',
      artwork: '',
      duration: 299,
      source: 'saavn',
      previewOnly: false,
    };
    const picks = await mindbeat.focusPicks(seed);

    const ids = picks.map((t) => t.id);
    // the explicit row is a REAL baked row (e=0.42 ≤ 0.45): the baked gate
    // would ADMIT it — filterClean is the only thing that drops it.
    expect(ids).toEqual(['hyg-fx-happier', 'hyg-fx-everything']);
  });
});
