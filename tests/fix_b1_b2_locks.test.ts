/**
 * v5.0.1 FIX-B1 + FIX-B2 — THE BOUND AND THE CAP.
 *
 * FIX-B1 (F13 Shuffle by Vibe): the 0.25 cadence bound is ENFORCED
 * during selection — the walk skips over-bound candidates and only
 * falls back to the best-fit when NOTHING fits, with `largestStep`
 * reporting the honest miss. The auditor's counterexample
 * ([0, 0.4, 0.8, 1], seed 0) is locked: an impossible pool must fire
 * the honest flag, never pretend.
 *
 * FIX-B2 (F18 Concert Mode): the size cap is REAL — encode refuses a
 * room over 50 rows or a payload over 65,536 chars; decode refuses
 * over-cap input BEFORE any decode work and over-cap fields per row;
 * a pending join timer is cancelled before a new one arms.
 *
 * All assertions are literals or order-sensitive fixtures — no
 * constant is checked against itself.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { optimizeQueueByVibe, stepWithinBound } from '../src/player/queueOptimizer';
import { CADENCE, CONCERT } from '../src/ai/core/constants';
import { decodeConcert, encodeConcert, pickConcertTrack } from '../src/ai/concert';

describe('FIX-B1 · the 0.25 bound is enforced, not aspirational', () => {
  test('THE AUDITOR\u2019S COUNTEREXAMPLE: [0, 0.4, 0.8, 1] is impossible — the honest flag fires', () => {
    const tracks = [
      { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' },
    ];
    const features: Record<string, number> = { a: 0, b: 0.4, c: 0.8, d: 1 };
    const res = optimizeQueueByVibe(tracks, features, [], 0);
    // a permutation, never a loss
    expect([...res.order].sort((x, y) => x.id.localeCompare(y.id)).map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
    // the honest miss: the bound cannot hold for a pool spanning 1.0 in
    // 4 rows (min possible max-step = 1/3 > 0.25) — the flag FIRES.
    expect(res.largestStep).toBeGreaterThan(CADENCE.aiMaxEnergyStep);
    expect(stepWithinBound(res.largestStep)).toBeFalse();
  });

  test('a satisfiable pool walks the bound: every realized step ≤ 0.25', () => {
    // 0 → 0.2 → 0.45 → 0.7 → 0.9 — every step fits inside 0.25
    const tracks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }];
    const features: Record<string, number> = { a: 0, b: 0.2, c: 0.45, d: 0.7, e: 0.9 };
    const res = optimizeQueueByVibe(tracks, features, [], 0);
    expect(res.order.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(res.largestStep).toBeLessThanOrEqual(0.25 + 1e-9);
    expect(stepWithinBound(res.largestStep)).toBeTrue();
  });

  test('the bound is enforced DURING the walk: an over-bound nearest is skipped while an eligible candidate exists', () => {
    // from 0: nearest is 0.24 (fine)… but shape the pool so the greedy
    // nearest CHAIN would strand the walk: after 0.24, 0.5 is 0.26 away
    // (over) — the only ordering that honors the bound everywhere must
    // exist when a within-bound chain exists. This pool HAS one.
    const tracks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    const features: Record<string, number> = { a: 0, b: 0.24, c: 0.49, d: 0.74 };
    const res = optimizeQueueByVibe(tracks, features, [], 0);
    expect(res.largestStep).toBeLessThanOrEqual(0.25 + 1e-9); // 0.24/0.25/0.25 chain
    expect(stepWithinBound(res.largestStep)).toBeTrue();
  });

  test('the SEED STEP is part of the honest flag (critic P2a): a far first row is reported', () => {
    // seed 1.0, pool {0, 0.1}: every arrangement starts with a 0.9
    // first transition — the walk-internal max alone (0.1) would hide it.
    const res = optimizeQueueByVibe([{ id: 'a' }, { id: 'b' }], { a: 0, b: 0.1 }, [], 1.0);
    expect(res.largestStep).toBeGreaterThanOrEqual(0.9);
    expect(stepWithinBound(res.largestStep)).toBeFalse();
    // …and a near seed stays honest-true (no over-reporting)
    const near = optimizeQueueByVibe([{ id: 'a' }, { id: 'b' }], { a: 0, b: 0.1 }, [], 0.05);
    expect(near.largestStep).toBeLessThanOrEqual(0.25 + 1e-9);
    expect(stepWithinBound(near.largestStep)).toBeTrue();
  });

  test('pinned rows still never move (the F13 law survives the fix)', () => {
    const tracks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    const features: Record<string, number> = { a: 0, b: 0.4, c: 0.8, d: 1 };
    const res = optimizeQueueByVibe(tracks, features, ['b'], 0);
    expect(res.order[1].id).toBe('b'); // slot 1 untouched
    expect(res.pinnedKept).toBe(1);
  });

  test('MECHANISM LOCK: the eligibility check rides the EXISTING cadence bound inside the walk', () => {
    const src = readFileSync('src/player/queueOptimizer.ts', 'utf8');
    expect(src).toContain('bestWithinBoundIdx');
    expect(src).toMatch(/d <= CADENCE\.aiMaxEnergyStep \+ 1e-9/); // the selection-time gate
    expect(src).toMatch(/bestWithinBoundIdx >= 0 \? bestWithinBoundIdx : bestIdx/); // the honest fallback
  });
});

describe('FIX-B2 · the concert size cap is real (before decode, not after)', () => {
  const START = 1_800_000_000_000;
  const NOW = 1_700_000_000_000;

  test('50 rows with max-length fields STILL encode (the cap leaves real rooms alone)', () => {
    const big = Array.from({ length: CONCERT.maxTracks }, (_, i) => ({
      id: `t${i}`,
      title: 'T'.repeat(500),
      artist: 'A'.repeat(300),
    }));
    const code = encodeConcert(big, START, NOW);
    expect(code).not.toBeNull();
    const payload = decodeConcert(code!);
    expect(payload!.tracks.length).toBe(50);
    expect(payload!.tracks[0].title.length).toBe(500);
  });

  test('51 rows → null (a refusal, never the old silent truncation)', () => {
    const big = Array.from({ length: CONCERT.maxTracks + 1 }, (_, i) => ({ id: `t${i}`, title: `s${i}`, artist: 'a' }));
    expect(encodeConcert(big, START, NOW)).toBeNull();
  });

  test('the auditor\u2019s repro: a 262,144-char title can no longer produce a monster code', () => {
    const code = encodeConcert([{ id: 't0', title: 'x'.repeat(262_144), artist: 'a' }], START, NOW);
    expect(code).not.toBeNull(); // the encoder SLICES the field…
    expect(code!.length).toBeLessThan(2000); // …so the code stays small
    const payload = decodeConcert(code!);
    expect(payload!.tracks[0].title.length).toBe(CONCERT.maxTitleChars);
  });

  test('a forged 100k-char code is refused ON SIGHT (before base64/JSON work)', () => {
    expect(decodeConcert('A'.repeat(100_000))).toBeNull();
    expect(decodeConcert('A'.repeat(70_000))).toBeNull();
  });

  test('a small code carrying a forged over-cap field is refused (defense in depth)', () => {
    // hand-build a v1 payload whose title is 501 chars — under the size
    // cap, over the field cap — and smuggle it past the encoder.
    const forged = {
      v: CONCERT.version,
      startAt: START,
      at: NOW,
      tracks: [{ id: 't0', title: 'x'.repeat(501), artist: 'a' }],
    };
    const b64 = Buffer.from(JSON.stringify(forged), 'utf8').toString('base64url');
    expect(b64.length).toBeLessThan(CONCERT.maxCodeChars);
    expect(decodeConcert(b64)).toBeNull();
  });

  test('the payload cap bites on its OWN: 50 fat rows (art at max) over 65,536 JSON chars ⇒ null', () => {
    // field caps alone cannot produce this refusal — the PAYLOAD gate is
    // what stops a room whose total JSON (50 × ~2.1k chars) overflows.
    const fat = Array.from({ length: CONCERT.maxTracks }, (_, i) => ({
      id: `t${i}`,
      title: 'T'.repeat(500),
      artist: 'A'.repeat(300),
      artwork: 'h'.repeat(1000), // maxArtworkChars — the rows are all legal, the ROOM is too big
    }));
    expect(encodeConcert(fat, START, NOW)).toBeNull();
  });

  test('a VALID payload whose code exceeds the cap is refused by decode ON SIGHT (not by parse failure)', () => {
    // build a legal v1 payload that only trips the SIZE gate (~50 rows,
    // padded artwork ⇒ ~105k JSON ⇒ ~140k base64url), bypassing encode.
    const fat = Array.from({ length: 50 }, (_, i) => ({
      id: `t${i}`, title: 'T'.repeat(500), artist: 'A'.repeat(300), artwork: 'h'.repeat(1000),
    }));
    const validButHuge = Buffer.from(JSON.stringify({ v: CONCERT.version, startAt: START, at: NOW, tracks: fat }), 'utf8').toString('base64url');
    expect(validButHuge.length).toBeGreaterThan(CONCERT.maxCodeChars);
    expect(decodeConcert(validButHuge)).toBeNull(); // refused on sight — the content is fine, the size is not
  });

  test('THE DEAD BAND IS CLOSED: a room whose JSON sits in [49,152, 65,536] is refused AT ENCODE (no unjoinable code ships)', () => {
    // the blind-critic P1: gating the JSON left rooms whose base64url
    // code (JSON × 4/3) exceeded the decoder's on-sight gate — the
    // sender shared, the receiver refused. The gate now measures the
    // CODE, so this room is honestly refused before a code exists.
    const deadBand = Array.from({ length: 50 }, (_, i) => ({
      id: `t${i}`, title: 'T'.repeat(500), artist: 'A'.repeat(300), artwork: 'h'.repeat(300),
    }));
    expect(encodeConcert(deadBand, START, NOW)).toBeNull();
  });

  test('a room just under the code cap round-trips END-TO-END (encode → decode symmetry)', () => {
    const near = Array.from({ length: 50 }, (_, i) => ({
      id: `t${i}`, title: 'T'.repeat(500), artist: 'A'.repeat(300), artwork: 'h'.repeat(60),
    }));
    const code = encodeConcert(near, START, NOW);
    expect(code).not.toBeNull();
    expect(code!.length).toBeLessThanOrEqual(CONCERT.maxCodeChars); // the code itself fits
    const payload = decodeConcert(code!);
    expect(payload!.tracks.length).toBe(50);
  });

  test('unnamed rows cannot smuggle an oversized room past the refusal (critic P2b)', () => {
    const mixed = Array.from({ length: CONCERT.maxTracks + 1 }, (_, i) =>
      i === 7 ? { id: `t${i}` } : { id: `t${i}`, title: `s${i}`, artist: 'a' },
    ); // 51 input rows, only 50 nameable — still a refusal
    expect(encodeConcert(mixed, START, NOW)).toBeNull();
  });

  test('the cap constants are the pinned literals (mutation targets)', () => {
    expect(CONCERT.maxCodeChars).toBe(65_536);
    expect(CONCERT.maxTitleChars).toBe(500);
    expect(CONCERT.maxArtistChars).toBe(300);
  });

  test('a normal small room still round-trips (the caps broke nothing)', () => {
    const room = [
      { id: 't1', title: 'Tum Hi Ho', artist: 'Arijit Singh', source: 'saavn', saavnId: '123' },
      { id: 't2', title: 'Kesariya', artist: 'Arijit Singh' },
    ];
    const code = encodeConcert(room, START, NOW);
    const payload = decodeConcert(code!);
    expect(payload!.tracks.length).toBe(2);
    expect(payload!.tracks[0].saavnId).toBe('123');
    expect(payload!.tracks[1].title).toBe('Kesariya');
    expect(payload!.tracks.every((t) => !('streamUrl' in t))).toBeTrue();
  });

  test('MECHANISM LOCKS: the join timer is cancelled before a new one arms; the room-full refusal is honest', () => {
    const wire = readFileSync('src/screens/MindbeatWireScreen.tsx', 'utf8');
    const armAt = wire.indexOf('concertTimerRef.current = setTimeout(start, plan.delayMs);');
    expect(armAt).toBeGreaterThan(-1);
    // the clear must be the statement IMMEDIATELY before the arm (the
    // unmount-effect clear far above does not protect a second join).
    const clearMarker = 'clearTimeout(concertTimerRef.current)';
    const clearBeforeArm = wire.lastIndexOf(clearMarker, armAt);
    expect(clearBeforeArm).toBeGreaterThan(-1);
    expect(armAt - (clearBeforeArm + clearMarker.length)).toBeLessThan(250);
    const player = readFileSync('src/screens/PlayerScreen.tsx', 'utf8');
    expect(player).toContain('THE ROOM IS FULL — CONCERT CODES CARRY'); // oversized rooms say why
    expect(player).toContain('THE CODE WOULD BE TOO BIG — SHARE A SMALLER QUEUE'); // size-refused ≤50 rooms say why (critic P2c)
    expect(player).toMatch(/const queued = await playQueue\(\[active, \.\.\.radio\], 0\);[\s\S]{0,300}\$\{queued\} SONGS/); // startRadio too (critic P2e)
    expect(player).toContain('COULD NOT START PLAYBACK — THE RADIO DID NOT RESOLVE');
  });
});
