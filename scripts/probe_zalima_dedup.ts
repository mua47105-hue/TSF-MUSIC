/** LIVE PROBE (P4b) — same-title rows that survived key-dedup must now
 *  reconcile; genuinely different same-title songs must survive. */
import { searchSaavn, dedupeRecordings, mergeUniqueTracks } from '../src/api/saavn';
import { recordingKey, reconcileRecordings } from '../src/api/recording';

function norm(s: string) { return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

async function probe(q: string, pages: number) {
  const raw: any[] = [];
  for (let p = 1; p <= pages; p++) raw.push(...((await searchSaavn(q, undefined, undefined, p)) as any[]));
  const d = dedupeRecordings(raw);
  console.log(`\n"${q}": raw=${raw.length} → deduped=${d.length} (${raw.length - d.length} collapsed)`);
  const byTitle = new Map<string, any[]>();
  for (const t of d) {
    const k = norm((t.title ?? '').replace(/\s*[([][^)\]]*[)\]]/g, ''));
    byTitle.set(k, [...(byTitle.get(k) ?? []), t]);
  }
  let resid = 0;
  for (const [k, rows] of byTitle) {
    if (rows.length < 2) continue;
    // would the OLD key-only dedup have left these? (they passed both passes now)
    const keys = new Set(rows.map((t: any) => recordingKey(t)));
    resid += 1;
    console.log(`  still ${rows.length}x "${rows[0].title.slice(0, 38)}" (${keys.size} distinct keys — different artists):`);
    rows.forEach((t: any) => console.log(`      - ${t.artist}`));
  }
  console.log(`  same-title clusters remaining: ${resid} (must be disjoint-credit rows only)`);
}

async function main() {
  await probe('top songs', 3);
  await probe('tum hi ho', 2);
  await probe('trending songs', 2);
  // pagination merge check
  const p1 = await searchSaavn('top songs', undefined, undefined, 1);
  const p2 = await searchSaavn('top songs', undefined, undefined, 2);
  const m = mergeUniqueTracks(p1, p2);
  console.log(`\nmergeUniqueTracks page1(${p1.length}) + page2(${p2.length}) → ${m.length}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
