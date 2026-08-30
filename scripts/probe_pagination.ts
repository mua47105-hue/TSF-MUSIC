/**
 * Gauntlet R4 pre-build probe: does JioSaavn actually paginate?
 *
 * Bars that depend on this probe:
 *   F1 (infinite search) needs search.getResults p=2,3 to return
 *       DISTINCT rows (not the same page echoed back).
 *   F2 (infinite home)  needs the same for feed queries, plus a volume
 *       check on content.getHomepageData.
 *
 * Run: bun run scripts/probe_pagination.ts
 */
const API = 'https://www.jiosaavn.com/api.php';
const HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
  Accept: 'application/json, text/plain, */*',
};

async function saavnGet(params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams({
    _format: 'json',
    _marker: '0',
    api_version: '4',
    ctx: 'web6dot0',
    ...params,
  });
  const res = await fetch(`${API}?${qs.toString()}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`saavn ${res.status}`);
  const text = await res.text();
  const start = text.indexOf('{');
  const arr = text.indexOf('[');
  const from = start === -1 ? arr : arr === -1 ? start : Math.min(start, arr);
  if (from === -1) throw new Error('no json');
  return JSON.parse(text.slice(from));
}

async function probeSearchPages(query: string) {
  console.log(`\n=== search.getResults "${query}" pages 1..4 ===`);
  const idsPerPage: string[][] = [];
  for (const p of [1, 2, 3, 4]) {
    const data = await saavnGet({ __call: 'search.getResults', q: query, p: String(p), n: '30' });
    const results = Array.isArray(data?.results) ? data.results : [];
    const ids = results.map((r: any) => String(r.id));
    idsPerPage.push(ids);
    console.log(`p=${p}: ${results.length} rows, first=${results[0]?.title?.slice(0, 40)}`);
  }
  // distinctness
  const all = idsPerPage.flat();
  const unique = new Set(all);
  console.log(`total rows=${all.length} unique ids=${unique.size}`);
  for (let i = 1; i < idsPerPage.length; i++) {
    const prev = new Set(idsPerPage.slice(0, i).flat());
    const fresh = idsPerPage[i].filter((id: string) => !prev.has(id));
    console.log(`p=${i + 1}: ${fresh.length}/${idsPerPage[i].length} rows are NEW vs pages 1..${i}`);
  }
  return unique.size;
}

async function probeAlbumPages(query: string) {
  console.log(`\n=== search.getAlbumResults "${query}" pages 1..3 ===`);
  for (const p of [1, 2, 3]) {
    const data = await saavnGet({ __call: 'search.getAlbumResults', q: query, p: String(p), n: '20' });
    const results = Array.isArray(data?.results) ? data.results : [];
    console.log(
      `p=${p}: ${results.length} albums, first=${results[0]?.title?.slice(0, 40)}`,
    );
  }
}

async function probePlaylistSearch() {
  console.log('\n=== playlist search surface probe ===');
  for (const call of ['search.getPlaylists', 'playlist.search']) {
    try {
      const data = await saavnGet({ __call: call, q: 'love', p: '1', n: '10' });
      const keys = Object.keys(data ?? {});
      console.log(`${call}: keys=${keys.join(',').slice(0, 120)}`);
    } catch (e) {
      console.log(`${call}: FAILED ${(e as Error).message}`);
    }
  }
}

async function probeHomepageVolume() {
  console.log('\n=== content.getHomepageData volume ===');
  const data = await saavnGet({ __call: 'content.getHomepageData' });
  console.log(`new_albums=${Array.isArray(data?.new_albums) ? data.new_albums.length : 0}`);
  console.log(
    `featured_playlists=${Array.isArray(data?.featured_playlists) ? data.featured_playlists.length : 0}`,
  );
  const otherKeys = Object.keys(data ?? {}).filter(
    (k) => k !== 'new_albums' && k !== 'featured_playlists' && k !== 'status_txt' && k !== 'version',
  );
  console.log(`other keys: ${otherKeys.join(', ').slice(0, 200)}`);
  // peek one other module shape
  for (const k of otherKeys.slice(0, 6)) {
    const v = (data as any)[k];
    if (Array.isArray(v) && v.length) {
      console.log(`  ${k}: ${v.length} rows, first title=${v[0]?.title ?? v[0]?.listname ?? '?'}`);
    }
  }
}

async function main() {
  await probeSearchPages('arijit singh');
  await probeSearchPages('top songs');
  await probeAlbumPages('romantic');
  await probePlaylistSearch();
  await probeHomepageVolume();
}
main().catch((e) => {
  console.error('PROBE FAILED', e);
  process.exit(1);
});
