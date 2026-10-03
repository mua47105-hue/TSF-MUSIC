/**
 * WAVE 6a — THE SHARE CARD LOCKS (bar: Spotify's share card).
 *
 * Bars pinned (gauntlet/WAVE6-BARS.md §6a):
 *   • platform mode: native captures a card, web stays deterministic text
 *   • the lyric line printed on the card can never leak LRC stamps,
 *     metadata tags, or instrumental gaps
 *   • title type steps down so ANY title survives 2 lines
 *   • the text fallback is byte-identical to the v4.0.5 contract
 *     (the button can never regress below it)
 *
 * The capture → share-sheet handoff itself is device territory
 * (view-shot/expo-sharing) — covered by the native E2E lab + the web
 * walkthrough asserts the off-screen card mounts without errors.
 */

import { describe, expect, test } from 'bun:test';
import { fitTitleSize, sanitizeLyricLine, shareMode, shareText } from '../../src/share/cardSpec';

describe('W6a — platform mode', () => {
  test('native → card; web → text (deterministic, no CORS roulette)', () => {
    expect(shareMode('native')).toBe('card');
    expect(shareMode('web')).toBe('text');
  });
});

describe('W6a — sanitizeLyricLine (the card can never lie)', () => {
  test('strips LRC timestamps + metadata tags', () => {
    expect(sanitizeLyricLine('[00:12.34] Teri Aankhon Mein')).toBe('Teri Aankhon Mein');
    expect(sanitizeLyricLine('[ar:Arijit Singh][00:05.00] Kesariya')).toBe('Kesariya');
  });

  test('multi-stamp chorus lines collapse cleanly', () => {
    expect(sanitizeLyricLine('[00:10.00][01:40.00][03:02.50] Chorus line')).toBe('Chorus line');
  });

  test('instrumental gaps and bare stamps → null (nothing to sing)', () => {
    expect(sanitizeLyricLine('[00:12.34]')).toBeNull();
    expect(sanitizeLyricLine('[instrumental]')).toBeNull();
    expect(sanitizeLyricLine('12345')).toBeNull();
    expect(sanitizeLyricLine('...')).toBeNull();
    expect(sanitizeLyricLine('')).toBeNull();
    expect(sanitizeLyricLine(null)).toBeNull();
    expect(sanitizeLyricLine(undefined)).toBeNull();
  });

  test('whitespace collapses; Devanagari lines survive', () => {
    expect(sanitizeLyricLine('  [00:01.00]   हिंदी    गीत  ')).toBe('हिंदी गीत');
  });

  test('96-char hard cap with ellipsis', () => {
    const long = 'a'.repeat(120);
    const out = sanitizeLyricLine(long);
    expect(out!.length).toBeLessThanOrEqual(96);
    expect(out!.endsWith('…')).toBe(true);
  });
});

describe('W6a — fitTitleSize (any title survives 2 lines)', () => {
  test('steps down monotonically with length', () => {
    const sizes = ['', 'x'.repeat(18), 'x'.repeat(19), 'x'.repeat(30), 'x'.repeat(31), 'x'.repeat(44), 'x'.repeat(45)].map(
      (t) => fitTitleSize(t),
    );
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]!).toBeLessThanOrEqual(sizes[i - 1]!);
  });

  test('boundaries', () => {
    expect(fitTitleSize('Kesariya')).toBe(44);
    expect(fitTitleSize('x'.repeat(30))).toBe(36);
    expect(fitTitleSize('x'.repeat(44))).toBe(28);
    expect(fitTitleSize('x'.repeat(80))).toBe(24);
  });
});

describe('W6a — the v4.0.5 text contract never changed', () => {
  test('byte-identical fallback message', () => {
    expect(shareText('Kesariya', 'Arijit Singh')).toBe('Kesariya — Arijit Singh\nPlaying on TSF Music');
  });
});
