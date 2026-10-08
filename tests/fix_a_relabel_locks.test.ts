/**
 * v5.0.1 FIX-A2 — THE HONEST RELABEL LOCKS (the auditor's P1).
 *
 * The reproduced bug: the F15 surfaces claimed "≤30% unheard rows" but
 * the mixer caps FRESHLY-ADDED catalog rows — the ≥70% spine is the
 * session's QUEUED queue, which proves nothing about listening. The
 * claim is relabeled everywhere it ships (bulletin, changelog, player
 * toast); the mixer's 30% cap is UNCHANGED and still locked.
 *
 * Copy locks read the shipped source text (the wave1-hermes house
 * pattern): the strings below are the literals users actually see.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mixResumeSession } from '../src/ai/sessionMemory';
import { SESSION_MEMORY } from '../src/ai/core/constants';

describe('FIX-A2 · the copy says "freshly added", never "unheard"', () => {
  test('the What\u2019s-New bulletin never carries the dishonest claim (the shipped bulletin is the v5.0.2 patch note)', () => {
    const src = readFileSync('src/components/WhatsNewDialog.tsx', 'utf8');
    // The v5.0.2 patch bulletin replaced the v5.0.1 relabel prose (the
    // relabel's permanent home is the changelog, pinned below). What
    // must hold for EVERY bulletin: the dishonest wording never ships.
    expect(src).not.toContain('≤30% unheard');
  });

  test('the v5.0.0 changelog entry for F15 is relabeled', () => {
    const src = readFileSync('docs/CHANGELOG.md', 'utf8');
    const f15 = (src.split('**F15 Session Memory**')[1] ?? '').split('**F16')[0];
    expect(f15).toContain('≤30% freshly added rows');
    expect(f15).not.toContain('≤30% unheard'); // the CLAIM is gone (a quoted mention of the old wording is honest history)
  });

  test('the resume toast claims the queued spine, not ownership of listening', () => {
    const src = readFileSync('src/screens/StatsScreen.tsx', 'utf8');
    expect(src).toContain('MOSTLY YOUR SESSION');
    expect(src).not.toContain('MOSTLY YOURS`');
  });
});

describe('FIX-A2 · the mixer\u2019s 30% cap is unchanged (mutation target)', () => {
  test('freshShare is still the literal 0.3', () => {
    expect(SESSION_MEMORY.freshShare).toBe(0.3);
  });

  test('10-target mix from 7 seeds takes at most 3 fresh rows', () => {
    const seeds = Array.from({ length: 7 }, (_, i) => ({ id: `s${i}` }));
    const fresh = Array.from({ length: 100 }, (_, i) => ({ id: `f${i}` }));
    const { mix, freshUsed } = mixResumeSession(seeds, fresh, 10);
    expect(mix.length).toBe(10);
    expect(freshUsed).toBe(3); // floor(10 × 0.3) = 3 — the cap, not a suggestion
    expect(mix.slice(0, 7).map((t) => t.id)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's6']); // spine leads
  });

  test('a short spine drags the fresh cap down (the blind-critic P1 bound)', () => {
    const seeds = Array.from({ length: 4 }, (_, i) => ({ id: `s${i}` }));
    const fresh = Array.from({ length: 100 }, (_, i) => ({ id: `f${i}` }));
    const { freshUsed } = mixResumeSession(seeds, fresh, 10);
    expect(freshUsed).toBe(1); // floor(4 × 0.3/0.7) = 1 — "≤30% freshly added" at EVERY size
  });
});
