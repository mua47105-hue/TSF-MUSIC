/**
 * Probe: full field shape of search.getAlbumResults rows (need artwork +
 * subtitle for Collection cards) and confirm n-param behaves.
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
  const text = await res.text();
  const start = text.indexOf('{');
  const arr = text.indexOf('[');
  const from = start === -1 ? arr : arr === -1 ? start : Math.min(start, arr);
  return JSON.parse(text.slice(from));
}

async function main() {
  const data = await saavnGet({ __call: 'search.getAlbumResults', q: 'hits', p: '1', n: '6' });
  const rows = Array.isArray(data?.results) ? data.results : [];
  console.log(`rows=${rows.length}`);
  for (const r of rows.slice(0, 3)) {
    console.log(JSON.stringify({
      id: r.id,
      title: r.title,
      subtitle: r.subtitle,
      music: r.music,
      image: r.image,
      year: r.year,
      language: r.language,
      song_count: r.song_count ?? r.more_info?.song_count,
      artistKeys: r.more_info ? Object.keys(r.more_info) : undefined,
    }, null, 1).slice(0, 500));
  }
  // n=40 sanity
  const d2 = await saavnGet({ __call: 'search.getAlbumResults', q: 'hits', p: '2', n: '40' });
  console.log(`p2 n40 rows=${Array.isArray(d2?.results) ? d2.results.length : 0}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
