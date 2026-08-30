/**
 * LIVE ENGINE PROBE — the real searchMusicV2 against live JioSaavn/YT/iTunes.
 * Datacenter IP: YT player is expected to be bot-walled (documented); search works.
 */
import { mock } from 'bun:test';

mock.module('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
  Platform: { OS: 'android', select: (o: any) => o.android },
  NativeModules: {},
}));
mock.module('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined, multiRemove: async () => undefined },
}));

import { registerArtistLexicon } from '../src/search/plan';
import { ytSearchMusic, ytResolveStream, ytLastDiagnostics, resetYtKillSwitch, clearYtCaches } from '../src/api/youtube';

registerArtistLexicon(['Atif Aslam', 'Arijit Singh', 'Pritam', 'A.R. Rahman', 'Shreya Ghoshal']);

// ── probe 1: the flagship title-only query through the real engine ──
const { searchMusicV2 } = await import('../src/api/music');
const t0 = Date.now();
const res = await searchMusicV2('tu chaiye');
console.log('=== searchMusicV2("tu chaiye") —', `${Date.now() - t0}ms`, '===');
console.log('sigState:', res.sigState);
console.log('top 5:');
for (const t of res.tracks.slice(0, 5)) {
  console.log(`  [${(t as any).rescueRung ?? (t as any).reasonCode ?? t.source}] ${t.title} — ${t.artist}${t.source === 'youtube' ? (t as any).streamUrl ? ' (stream resolved)' : ' (no stream)' : ''}`);
}

// ── probe 2: the artist+title query ──
const t1 = Date.now();
const res2 = await searchMusicV2('tu chaiye of atif aslam');
console.log('\n=== searchMusicV2("tu chaiye of atif aslam") —', `${Date.now() - t1}ms`, '===');
console.log('sigState:', res2.sigState);
for (const t of res2.tracks.slice(0, 4)) {
  console.log(`  [${(t as any).rescueRung ?? (t as any).reasonCode ?? t.source}] ${t.title} — ${t.artist}`);
}
if (res2.partialArtists?.length) console.log('partialArtists:', res2.partialArtists.slice(0, 4));

// ── probe 3: live YT Music search ──
resetYtKillSwitch();
clearYtCaches();
const ytr = await ytSearchMusic('tu chahiye atif aslam', 10);
console.log('\n=== ytSearchMusic("tu chahiye atif aslam") —', `${ytr.latencyMs}ms`, '===');
console.log('tracks:', ytr.tracks.length, '| albums:', ytr.albums.length);
for (const t of ytr.tracks.slice(0, 5)) {
  console.log(`  [${t.ytKind}] ${t.title} — ${t.artist} · ${t.duration ?? '?'}s · plays=${t.playCount ?? '?'}`);
}

// ── probe 4: the player ladder from a datacenter IP (expect bot-walls) ──
const canonical = ytr.tracks.find((t) => /tu chahiye/i.test(t.title));
if (canonical?.youtubeId) {
  const out = await ytResolveStream(canonical.youtubeId);
  console.log('\n=== ytResolveStream — datacenter probe ===');
  console.log('ok:', out.ok, '| reason:', out.reason);
  for (const line of ytLastDiagnostics()) console.log('  ', line);
} else {
  console.log('\n(no canonical video id found for player probe)');
}
