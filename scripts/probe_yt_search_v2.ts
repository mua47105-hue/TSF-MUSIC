/**
 * Gauntlet R8 probe: how does YouTube Music search ACTUALLY work?
 *
 * Bars that depend on this probe:
 *   - P2 (real songs, not lofi):  what does WEB_REMIX return for a
 *     misspelled query ("tu chaiye")? where do lofi/cover versions rank?
 *     does the response carry spell corrections we should honor?
 *   - P3 (result volume):  does the songs-filter `params` work? how many
 *     rows per page? do continuations paginate deeper (20-40+ songs)?
 *   - dedup keys: do catalog rows repeat across filters?
 *
 * Run: bun run scripts/probe_yt_search_v2.ts
 */

const MUSIC = 'https://music.youtube.com/youtubei/v1';
const KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';
const CTX = {
  client: {
    clientName: 'WEB_REMIX',
    clientVersion: '1.20260707.12.00',
    hl: 'en',
    gl: 'IN',
  },
};

async function warmup(): Promise<string> {
  const res = await fetch('https://www.youtube.com/youtubei/v1/visitor_id?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ context: { client: CTX.client } }),
  });
  const j = await res.json();
  return j?.responseContext?.visitorData ?? '';
}

async function search(body: Record<string, unknown>, visitor: string): Promise<any> {
  const res = await fetch(`${MUSIC}/search?key=${KEY}&prettyPrint=false`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      'X-Goog-Api-Format-Version': '2',
      Origin: 'https://music.youtube.com',
      Referer: 'https://music.youtube.com/',
      'X-YouTube-Client-Name': '67',
      'X-YouTube-Client-Version': '1.20260707.12.00',
    },
    body: JSON.stringify({
      context: { client: { ...CTX.client, visitorData: visitor } },
      ...body,
    }),
  });
  if (!res.ok) throw new Error(`search http ${res.status}`);
  return res.json();
}

// ── shape walkers ─────────────────────────────────────────────────────────

function shelfName(node: any): string | null {
  const t =
    node?.musicShelfRenderer?.title?.runs?.[0]?.text ??
    node?.itemSectionRenderer?.title?.runs?.[0]?.text ?? null;
  return t;
}

/** every musicResponsiveListItemRenderer row, tagged with its shelf path */
function collectRows(root: any): Array<{ shelf: string; r: any }> {
  const out: Array<{ shelf: string; r: any }> = [];
  const walk = (node: any, shelf: string) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x, shelf);
      return;
    }
    let s = shelf;
    if (node.musicShelfRenderer) {
      s = node.musicShelfRenderer.title?.runs?.[0]?.text ?? shelf;
      for (const c of node.musicShelfRenderer.contents ?? []) walk(c, s);
      return;
    }
    if (node.musicCardShelfRenderer) {
      s = node.musicCardShelfRenderer.header?.musicCardShelfHeaderBasicRenderer?.title?.runs?.[0]?.text ?? 'top-result';
      for (const c of node.musicCardShelfRenderer.contents ?? []) walk(c, s);
      const inner = node.musicCardShelfRenderer.content;
      if (inner) walk(inner, s);
      return;
    }
    if (node.chipCloudRenderer) {
      // chips: label → params (filter extraction)
      return;
    }
    if (node.musicResponsiveListItemRenderer) {
      out.push({ shelf, r: node.musicResponsiveListItemRenderer });
      return;
    }
    for (const k of Object.keys(node)) {
      if (k === 'musicResponsiveListItemRenderer') continue;
      walk(node[k], s);
    }
  };
  walk(root, 'root');
  return out;
}

function rowTitle(r: any): string {
  return r?.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text ?? '?';
}
function rowSubtitle(r: any): string {
  return (r?.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs ?? [])
    .map((x: any) => x.text ?? '')
    .join('');
}
function rowVideoId(r: any): string | null {
  const m = JSON.stringify(r).match(/"watchEndpoint":\{"videoId":"([\w-]{11})"/);
  return m ? m[1] : null;
}

/** continuation tokens for music shelves */
function shelfContinuations(root: any): Array<{ shelf: string; token: string }> {
  const out: Array<{ shelf: string; token: string }> = [];
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.musicShelfRenderer) {
      const name = node.musicShelfRenderer.title?.runs?.[0]?.text ?? '?';
      for (const c of node.musicShelfRenderer.continuations ?? []) {
        const tok = c?.nextContinuationData?.continuation;
        if (tok) out.push({ shelf: name, token: tok });
      }
      return;
    }
    for (const k of Object.keys(node)) walk(node[k]);
  };
  walk(root);
  return out;
}

/** chip filter params (rotation-proof source of truth) */
function chips(root: any): Array<{ label: string; params?: string; selected: boolean }> {
  const out: Array<{ label: string; params?: string; selected: boolean }> = [];
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.chipCloudRenderer) {
      for (const c of node.chipCloudRenderer.chips ?? []) {
        const cr = c.chipCloudChipRenderer;
        if (!cr) continue;
        out.push({
          label: cr.text?.runs?.[0]?.text ?? '?',
          params: cr.navigationEndpoint?.searchEndpoint?.params,
          selected: !!cr.isSelected,
        });
      }
    }
    for (const k of Object.keys(node)) walk(node[k]);
  };
  walk(root);
  return out;
}

/** spell corrections */
function corrections(root: any): { didYouMean?: string; showingResultsFor?: string; original?: string } {
  const out: any = {};
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.didYouMeanRenderer) {
      out.didYouMean = node.didYouMeanRenderer.correctedQuery?.runs?.map((x: any) => x.text).join('') ?? out.didYouMean;
    }
    if (node.showingResultsForRenderer) {
      out.showingResultsFor =
        node.showingResultsForRenderer.correctedQuery?.runs?.map((x: any) => x.text).join('') ?? out.showingResultsFor;
      out.original = node.showingResultsForRenderer.originalQuery?.runs?.map((x: any) => x.text).join('') ?? out.original;
    }
    for (const k of Object.keys(node)) walk(node[k]);
  };
  walk(root);
  return out;
}

const SONGS_PARAMS = 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D';
const VIDEOS_PARAMS = 'EgWKAQIQAWoKEAkQChAFEAMQBA%3D%3D';

async function main() {
  const visitor = await warmup();
  console.log(`visitor: ${visitor.slice(0, 30)}...`);

  const queries = ['tu chaiye', 'tum hi ho', 'kesariya'];

  for (const q of queries) {
    console.log(`\n=================== query: "${q}" ===================`);

    // ── 1. general search (what we ship today) ──
    const general = await search({ query: q }, visitor);
    const rowsG = collectRows(general);
    console.log(`\n[general] rows=${rowsG.length}`);
    const corr = corrections(general);
    if (corr.didYouMean || corr.showingResultsFor) console.log(`[general] corrections:`, JSON.stringify(corr));
    const chipsG = chips(general);
    console.log(
      `[general] chips: ${chipsG.map((c) => `${c.label}${c.selected ? '*' : ''}${c.params ? `(${c.params.slice(0, 12)}..)` : ''}`).join(', ')}`,
    );
    rowsG.slice(0, 12).forEach(({ shelf, r }, i) => {
      console.log(
        `  ${String(i + 1).padStart(2)}. [${shelf}] ${rowTitle(r).slice(0, 48)} | ${rowSubtitle(r).slice(0, 60)} | ${rowVideoId(r)}`,
      );
    });
    const contsG = shelfContinuations(general);
    console.log(`[general] continuations: ${contsG.map((c) => `${c.shelf}`).join(', ') || 'NONE'}`);

    // ── 2. songs-filter search (the candidate fix) ──
    const songs = await search({ query: q, params: SONGS_PARAMS }, visitor);
    const rowsS = collectRows(songs);
    console.log(`\n[songs-filter] rows=${rowsS.length}`);
    const contsS = shelfContinuations(songs);
    console.log(`[songs-filter] continuations: ${contsS.map((c) => `${c.shelf}(${c.token.length}ch)`).join(', ') || 'NONE'}`);
    rowsS.slice(0, 15).forEach(({ shelf, r }, i) => {
      console.log(
        `  ${String(i + 1).padStart(2)}. [${shelf}] ${rowTitle(r).slice(0, 48)} | ${rowSubtitle(r).slice(0, 60)}`,
      );
    });

    // ── 3. continuation page 2 of the songs shelf ──
    if (contsS.length) {
      const songsPage2 = await search({ continuation: contsS[0].token }, visitor);
      const rowsP2 = collectRows(songsPage2);
      console.log(`\n[songs-filter page2] rows=${rowsP2.length}`);
      rowsP2.slice(0, 8).forEach(({ shelf, r }, i) => {
        console.log(`  ${String(i + 1).padStart(2)}. [${shelf}] ${rowTitle(r).slice(0, 48)} | ${rowSubtitle(r).slice(0, 55)}`);
      });
      const contsP2 = shelfContinuations(songsPage2);
      console.log(`[songs-filter page2] continuations: ${contsP2.length ? contsP2.map((c) => c.shelf).join(', ') : 'NONE'}`);
    }
  }
}

main().catch((e) => {
  console.error('PROBE FAILED:', e);
  process.exit(1);
});
