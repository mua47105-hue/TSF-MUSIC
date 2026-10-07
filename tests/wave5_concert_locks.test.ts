/**
 * MAGNUM OPUS WAVE 5 · F18 — CONCERT MODE LOCKS.
 *
 * The bar: encode/decode LOSSLESS round-trip; corrupt/wrong-version/
 * oversized ⇒ null (an honest failure, never a fabricated room); NO
 * streamUrl can ever survive into the payload (stripped at the type
 * level AND asserted on the decoder's output AND on a forged
 * handle-poisoned payload); determinism (same input ⇒ same code, zero
 * Math.random); the ±500ms clock-drift plan math is the documented
 * literal. The share/join wiring is source-locked to the EXISTING
 * expo-sharing / paste surfaces (no new dependency, no server).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  encodeConcert,
  decodeConcert,
  concertStartPlan,
  concertRowToTrack,
  pickConcertTrack,
  type ConcertPayload,
} from '../src/ai/concert';

const NOW = 1_756_400_000_000; // a fixed encode-time day
const START = NOW + 30_000; // the sender wants a start 30s out

const FIXTURE = [
  { id: 'a1', title: 'Tum Hi Ho', artist: 'Arijit Singh', streamUrl: 'http://x/leak-me', duration: 261.2 },
  { id: 'b2', title: 'Apna Bana Le', artist: 'Sachin-Jigar' },
  { id: 'c3', title: 'कल हो ना हो', artist: 'Sonu Nigam', artwork: 'http://art/c3' },
];

describe('F18 · the codec round-trip (lossless)', () => {
  test('encode → decode returns the same tracks, in order, with the same startAt', () => {
    const code = encodeConcert(FIXTURE, START, NOW);
    expect(typeof code).toBe('string');
    const payload = decodeConcert(code);
    expect(payload).not.toBeNull();
    expect(payload!.v).toBe(1); // the literal codec version
    expect(payload!.startAt).toBe(START);
    expect(payload!.at).toBe(NOW);
    expect(payload!.tracks.map((t) => t.id)).toEqual(['a1', 'b2', 'c3']);
    expect(payload!.tracks[0].title).toBe('Tum Hi Ho');
    expect(payload!.tracks[0].artist).toBe('Arijit Singh');
    expect(payload!.tracks[2].title).toBe('कल हो ना हो'); // UTF-8 survives
    expect(payload!.tracks[2].artwork).toBe('http://art/c3');
  });

  test('duration is rounded to an integer ms-safe number; absent optionals stay absent', () => {
    const payload = decodeConcert(encodeConcert(FIXTURE, START, NOW))!;
    expect(payload!.tracks[0].duration).toBe(261);
    expect('artwork' in payload!.tracks[1]).toBeFalse();
    expect('duration' in payload!.tracks[1]).toBeFalse();
  });

  test('determinism: the same room encodes to the SAME code, byte for byte', () => {
    const a = encodeConcert(FIXTURE, START, NOW);
    const b = encodeConcert(FIXTURE, START, NOW);
    expect(a).toBe(b);
  });

  test('the strip is real: the input\'s streamUrl exists, the decoded output has no such key anywhere', () => {
    expect(FIXTURE[0].streamUrl).toBeTruthy(); // the leak is offered on the way in
    const payload = decodeConcert(encodeConcert(FIXTURE, START, NOW))!;
    for (const t of payload.tracks) {
      expect('streamUrl' in t).toBeFalse();
      expect(JSON.stringify(t)).not.toContain('leak-me');
    }
    expect(JSON.stringify(payload)).not.toContain('leak-me');
  });
});

describe('F18 · the decoder is tolerant, never fabricating', () => {
  test('garbage base64 / garbage json / non-string ⇒ null', () => {
    expect(decodeConcert('!!!not-base64url!!!')).toBeNull();
    expect(decodeConcert('aGVsbG8=')).toBeNull(); // decodes to "hello" — not an object
    expect(decodeConcert('')).toBeNull();
    expect(decodeConcert(null)).toBeNull();
    expect(decodeConcert(undefined)).toBeNull();
    expect(decodeConcert(42 as unknown as string)).toBeNull();
  });

  test('wrong version ⇒ null (we never fake-comprehend a future format)', () => {
    const future = Buffer.from(JSON.stringify({ v: 999, startAt: START, at: NOW, tracks: [{ id: 'x', title: 't', artist: 'a' }] }), 'utf8');
    const b64url = future.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeConcert(b64url)).toBeNull();
  });

  test('a handle-poisoned payload under ANY name (previewUrl/encryptedUrl) is REJECTED', () => {
    for (const handle of ['previewUrl', 'encryptedUrl']) {
      const forged = Buffer.from(JSON.stringify({ v: 1, startAt: START, at: NOW, tracks: [{ id: 'x', title: 't', artist: 'a', [handle]: 'http://x/handle' }] }), 'utf8');
      const b64url = forged.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      expect(decodeConcert(b64url)).toBeNull();
    }
  });

  test('an unknown provider source is rejected — identifiers we cannot rescue are not laundered', () => {
    const forged = Buffer.from(JSON.stringify({ v: 1, startAt: START, at: NOW, tracks: [{ id: 'x', title: 't', artist: 'a', source: 'napster' }] }), 'utf8');
    const b64url = forged.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeConcert(b64url)).toBeNull();
  });

  test('a handle-poisoned payload (streamUrl inside a track) is REJECTED, not laundered', () => {
    const forged = Buffer.from(JSON.stringify({ v: 1, startAt: START, at: NOW, tracks: [{ id: 'x', title: 't', artist: 'a', streamUrl: 'http://x/handle' }] }), 'utf8');
    const b64url = forged.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeConcert(b64url)).toBeNull();
  });

  test('oversized rooms (>50 rows), empty rooms, and unnamed rows ⇒ null', () => {
    const big = Array.from({ length: 51 }, (_, i) => ({ id: `t${i}`, title: `s${i}`, artist: 'a' }));
    expect(encodeConcert(big, START, NOW)).not.toBeNull(); // the ENCODER caps silently at 50
    const encoded50 = encodeConcert(big, START, NOW)!;
    expect(decodeConcert(encoded50)!.tracks.length).toBe(50); // the literal cap
    // but a FORGED 51-row payload is rejected
    const forged = Buffer.from(JSON.stringify({ v: 1, startAt: START, at: NOW, tracks: big }), 'utf8');
    const b64url = forged.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeConcert(b64url)).toBeNull();
    // empty room
    expect(encodeConcert([], START, NOW)).toBeNull();
    expect(decodeConcert(encodeConcert([{ id: 'x', title: 't', artist: 'a' }], START, NOW))).not.toBeNull();
  });

  test('pickConcertTrack refuses rows without a nameable title/artist', () => {
    expect(pickConcertTrack({ id: 'x' })).toBeNull();
    expect(pickConcertTrack({ id: 'x', title: 't' })).toBeNull();
    expect(pickConcertTrack({ id: 'x', title: 't', artist: 'a' })).toEqual({ id: 'x', title: 't', artist: 'a' });
    expect(pickConcertTrack({ id: 'x', title: 't', artist: 'a', duration: 0 })).toEqual({ id: 'x', title: 't', artist: 'a' });
  });
});

describe('F18 · concertStartPlan — the ±500ms honesty math', () => {
  const payload: ConcertPayload = { v: 1, startAt: NOW + 30_000, at: NOW, tracks: [{ id: 'x', title: 't', artist: 'a' }] };

  test('an early arrival waits the exact lead-in', () => {
    const plan = concertStartPlan(payload, NOW);
    expect(plan.delayMs).toBe(30_000);
    expect(plan.late).toBeFalse();
  });

  test('inside the drift window (≤500ms past) it is NOT late — the join is still "on time"', () => {
    expect(concertStartPlan(payload, NOW + 30_000).late).toBeFalse();
    expect(concertStartPlan(payload, NOW + 30_000 + 500).late).toBeFalse(); // exactly the drift bound
  });

  test('beyond the drift window (>500ms past) it honestly says LATE', () => {
    const plan = concertStartPlan(payload, NOW + 30_000 + 501);
    expect(plan.late).toBeTrue();
    expect(plan.delayMs).toBe(0); // never a negative wait
  });
});

describe('F18 · the resolvable map (blind-critic P0-2 — a code must PLAY, not just parse)', () => {
  test('concertRowToTrack: explicit Track with the rescue-ready identifiers, NO handle ever', () => {
    const resolved = concertRowToTrack({ id: 'saavn-abc', title: 'T', artist: 'A', source: 'saavn', saavnId: 'abc' });
    expect(resolved.id).toBe('saavn-abc');
    expect(resolved.source).toBe('saavn');
    expect(resolved.saavnId).toBe('abc');
    expect(resolved.previewOnly).toBe(false);
    expect('streamUrl' in resolved).toBeFalse();
    expect('encryptedUrl' in resolved).toBeFalse();
    expect('previewUrl' in resolved).toBeFalse();
  });

  test('absent source defaults to the app\'s saavn spine; the join toast reports the REAL count', () => {
    const legacy = concertRowToTrack({ id: 'x', title: 'T', artist: 'A' });
    expect(legacy.source).toBe('saavn');
    expect('saavnId' in legacy).toBeFalse(); // no fabricated ids either
  });

  test('the ENCODER carries identifiers (rescue-ready) but still never a handle', () => {
    const payload = decodeConcert(encodeConcert([{ id: 'saavn-abc', title: 'T', artist: 'A', source: 'saavn', saavnId: 'abc', streamUrl: 'http://leak' }], START, NOW))!;
    expect(payload.tracks[0].source).toBe('saavn');
    expect(payload.tracks[0].saavnId).toBe('abc');
    expect(JSON.stringify(payload)).not.toContain('leak');
  });

  test('source law: the join flow maps EXPLICITLY, awaits the REAL queue count, and toasts silence honestly', () => {
    const wire = readFileSync('src/screens/MindbeatWireScreen.tsx', 'utf8');
    expect(wire).toMatch(/payload\.tracks\.map\(concertRowToTrack\)/); // never an `as Track[]` cast
    expect(wire).not.toMatch(/as Track\[\]/);
    expect(wire).toMatch(/const queued = await playQueue\(rows, 0\)/); // the honest count
    expect(wire).toContain('THE ROOM DID NOT RESOLVE'); // the honest empty toast
    expect(wire).toMatch(/CONCERT\.clockDriftMs/); // the drift copy is the documented number
    expect(wire).toMatch(/KEEP THE APP OPEN/); // the scheduled-start disclosure
    // the scheduled start is cancellable on unmount (critic P1-5)
    expect(wire).toMatch(/concertTimerRef\.current = setTimeout\(start, plan\.delayMs\)/);
    expect(wire).toMatch(/clearTimeout\(concertTimerRef\.current\)/);
  });

  test('source law: playQueue reports its outcome (Promise<number>) on EVERY path', () => {
    const provider = readFileSync('src/player/PlayerProvider.tsx', 'utf8');
    expect(provider).toMatch(/Promise<number> \{/); // the signature
    expect(provider).toMatch(/return 0;/); // the honest-failure paths
    expect(provider).toMatch(/return playable\.length;/); // the success path
  });
});

describe('F18 · source laws (the wiring is real, the dependencies are not)', () => {
  test('share path: PlayerScreen hosts the concert-share button on the EXISTING Share.share pipeline', () => {
    const player = readFileSync('src/screens/PlayerScreen.tsx', 'utf8');
    expect(player).toContain('testID="concert-share-btn"');
    expect(player).toMatch(/encodeConcert\(queue/);
    expect(player).toMatch(/Share\.share\(/);
    expect(player).toContain('CONCERT.clockDriftMs'); // the drift is disclosed in the share copy
  });

  test('join path: the paste/import card decodes, toasts the honest null, and schedules the start', () => {
    const wire = readFileSync('src/screens/MindbeatWireScreen.tsx', 'utf8');
    expect(wire).toContain('testID="concert-import-card"');
    expect(wire).toContain('testID="concert-import-input"');
    expect(wire).toContain('testID="concert-import-btn"');
    expect(wire).toMatch(/decodeConcert\(concertCode\)/);
    expect(wire).toMatch(/concertStartPlan\(payload, Date\.now\(\)\)/);
    expect(wire).toContain('THAT CODE DID NOT PARSE'); // the honest failure toast
  });

  test('zero new dependencies for the codec (base64url is hand-rolled, as in tasteDna)', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(all).some((k) => /concert/i.test(k))).toBeFalse();
    const concert = readFileSync('src/ai/concert.ts', 'utf8');
    expect(concert).toMatch(/from '\.\/tasteDna'/); // reuses the codec pattern
    expect(concert).toMatch(/from '\.\/core\/constants'/); // and the constants law
  });

  test('the constants bridge: the documented numbers are the behavior above', () => {
    const constants = readFileSync('src/ai/core/constants.ts', 'utf8');
    expect(constants).toMatch(/CONCERT = \{/);
    expect(constants).toMatch(/clockDriftMs: 500/);
    expect(constants).toMatch(/maxTracks: 50/);
    expect(constants).toMatch(/version: 1/);
    expect(constants).toMatch(/shareLeadInMs: 30_000/);
    expect(constants).toMatch(/joinScheduleThresholdMs: 1_500/);
  });
});
