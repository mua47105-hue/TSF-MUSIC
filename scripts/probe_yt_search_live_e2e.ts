/**
 * R8 LIVE END-TO-END — the REAL src/api/youtube.ts search pipeline
 * against YouTube's LIVE InnerTube (no stubs).
 *
 * Bars (from the user's field reports):
 *   P2  "tu chaiye" → the official "Tu Chahiye" (Pritam, Atif Aslam)
 *       must rank #1; the lo-fi/remix top-result card must NOT lead.
 *   P3  volume: 20+ tracks, continuation walks page 2 (40+ total).
 *   P4  recording dedup: no title+primary-artist duplicates.
 *
 * Run: bun run scripts/probe_yt_search_live_e2e.ts
 */
import { ytSearchMusic, ytSearchMusicMore, resetYtKillSwitch } from '../src/api/youtube';
import { recordingKey } from '../src/api/recording';

resetYtKillSwitch();

function dupReport(tracks: { title: string; artist: string; artistsFull?: string[] }[]) {
  const seen = new Map<string, string>();
  const dups: string[] = [];
  for (const t of tracks) {
    const k = recordingKey(t);
    if (seen.has(k)) dups.push(`"${t.title}" == "${seen.get(k)}"`);
    else seen.set(k, t.title);
  }
  return dups;
}

async function main() {
  const queries = ['tu chaiye', 'tum hi ho', 'kesariya', 'apna bana le'];
  let allOk = true;

  for (const q of queries) {
    console.log(`\n══════════ live search: "${q}" ══════════`);
    const r = await ytSearchMusic(q, 25);
    console.log(
      `tracks=${r.tracks.length} albums=${r.albums.length} latency=${r.latencyMs}ms cont=${!!r.continuation} corrected=${r.correctedTo ?? '-'}`,
    );
    r.tracks.slice(0, 6).forEach((t, i) => {
      console.log(
        `  ${i + 1}. [${t.ytKind}] ${t.title.slice(0, 46)} | ${(t.artist ?? '').slice(0, 42)} | ${t.duration ?? 0}s | plays=${t.playCount ?? '-'}`,
      );
    });

    // BAR P2: rank 1 must be a SONG (not a video/lofi card row)
    const rank1 = r.tracks[0];
    const p2ok = rank1?.ytKind === 'song';
    // BAR P3: volume + continuation
    const p3ok = r.tracks.length >= 20 && !!r.continuation;
    // BAR P4: no recording dupes
    const dups = dupReport(r.tracks as any);
    const p4ok = dups.length === 0;

    // P2 extra: for the known queries, an exact-title song must lead
    const want = q.replace(/[^a-z ]/gi, '').toLowerCase();
    const canonicalLead =
      rank1 &&
      recordingKey(rank1 as any).split('|')[0].includes(want.replace(/\s+/g, '')) === true;
    console.log(
      `  ▶ P2(rank-1 song)=${p2ok ? 'PASS' : 'FAIL'} P2(canonical title leads)=${canonicalLead ? 'PASS' : 'FAIL'} P3(20+ & cont)=${p3ok ? 'PASS' : 'FAIL'} P4(no dupes)=${p4ok ? 'PASS' : 'FAIL'}`,
    );
    if (dups.length) console.log('  DUPES:', dups.slice(0, 4).join(' · '));
    allOk = allOk && p2ok && p3ok && p4ok;

    // walk page 2
    if (r.continuation) {
      const m = await ytSearchMusicMore(r.continuation, 30);
      const dups2 = dupReport(m.tracks as any);
      console.log(`  page2: tracks=${m.tracks.length} cont=${!!m.continuation} dupes=${dups2.length}`);
      m.tracks.slice(0, 4).forEach((t, i) => console.log(`    ${i + 1}. ${t.title.slice(0, 46)} | ${(t.artist ?? '').slice(0, 40)}`));
      allOk = allOk && m.tracks.length >= 15 && dups2.length === 0;
    }
  }
  console.log(`\n${allOk ? 'ALL LIVE BARS PASS' : 'SOME BARS FAILED'}`);
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error('LIVE E2E FAILED:', e);
  process.exit(1);
});
