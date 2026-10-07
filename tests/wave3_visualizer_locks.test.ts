/**
 * MAGNUM OPUS WAVE 3 · F11 — PSEUDO-VISUALIZER LOCKS.
 *
 * The bar: high energy → high amplitude (the mapping is monotone);
 * no baked features → the calmest wash; reduced-motion → a frozen
 * frame; deterministic phases; the bottom-anchor transform math is
 * exact; 60fps BY CONSTRUCTION (native driver, transform-only, no
 * per-frame JS — source-locked); mounts ONLY in the player modal.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { barDurations, barTransform, visualizerState, type VisualizerFeatures } from '../src/player/visualizer';
import { VISUALIZER } from '../src/ai/core/constants';

const hot: VisualizerFeatures = { energy: 0.9, valence: 0.7, tempoClass: 'fast' };
const cold: VisualizerFeatures = { energy: 0.1, valence: 0.3, tempoClass: 'slow' };
const LIVE = { reducedMotion: false, hasBakedFeatures: true };

describe('F11 · visualizerState — the energy mapping', () => {
  test('high energy → higher amplitude AND faster than low energy', () => {
    const h = visualizerState(hot, 0, LIVE);
    const c = visualizerState(cold, 0, LIVE);
    expect(h.amplitude).toBeGreaterThan(c.amplitude);
    expect(h.speed).toBeGreaterThan(c.speed);
    // the literal anchors at elapsedMs=0 (the breathing wave is at 0.5):
    // low edge = 14 + 32*0.2*0.5 = 17.2; amplitude = lerp(17.2, 46, 0.9) = 43.12
    expect(h.amplitude).toBeCloseTo(17.2 + (46 - 17.2) * 0.9, 10);
    // speed = 0.8 + (1.6-0.8)*0.9 + fastBonus 0.15 = 1.67
    expect(h.speed).toBeCloseTo(1.67, 10);
  });

  test('no baked features → the CALMEST wash (the honest fallback, literals)', () => {
    const s = visualizerState(null, 0, { reducedMotion: false, hasBakedFeatures: false });
    expect(s.amplitude).toBe(6); // VISUALIZER.washAmplitude
    expect(s.speed).toBe(0.6); // VISUALIZER.washSpeed
    expect(s.frozen).toBeFalse();
    // a features object with hasBakedFeatures=false ALSO washes (the
    // caller's honesty flag wins — the app cannot pretend to hear)
    const s2 = visualizerState(hot, 0, { reducedMotion: false, hasBakedFeatures: false });
    expect(s2.amplitude).toBe(6);
  });

  test('reduce-motion → FROZEN frame (amplitude 0), locked', () => {
    const s = visualizerState(hot, 0, { reducedMotion: true, hasBakedFeatures: true });
    expect(s.frozen).toBeTrue();
    expect(s.amplitude).toBe(0);
    expect(s.speed).toBe(0);
  });

  test('determinism: same inputs → byte-identical state, twice (X4)', () => {
    const a = JSON.stringify(visualizerState(hot, 12345, LIVE));
    const b = JSON.stringify(visualizerState(hot, 12345, LIVE));
    expect(a).toBe(b);
    // and the phases are the fixed even stagger (no randomness anywhere)
    const s = visualizerState(hot, 0, LIVE);
    expect(s.phases).toEqual(Array.from({ length: 24 }, (_, i) => i / 24));
  });

  test('valence maps to the palette bias (0..1, clamped)', () => {
    expect(visualizerState(hot, 0, LIVE).valenceBias).toBeCloseTo(0.7, 10);
    expect(visualizerState({ energy: 0.5, valence: 9, tempoClass: 'mid' }, 0, LIVE).valenceBias).toBe(1);
  });
});

describe('F11 · barTransform — the bottom-anchored math (exact)', () => {
  test('the base never leaves the floor: translateY = (1-scale)·amp/2', () => {
    const amp = 40;
    expect(barTransform(1, amp)).toEqual({ scaleY: 1, translateY: 0 });
    expect(barTransform(0.35, amp)).toEqual({ scaleY: 0.35, translateY: 13 }); // 0.65*40/2
    expect(barTransform(0, amp)).toEqual({ scaleY: 0.35, translateY: 13 }); // clamped at the floor
  });
  test('loop durations divide by speed (462/638 at speed 1, literal)', () => {
    const s = visualizerState(cold, 0, LIVE); // speed 0.8 + 0 = 0.8
    const d = barDurations(s);
    expect(d.upMs).toBe(Math.round((1100 / s.speed) * 0.42));
    expect(d.downMs).toBe(Math.round((1100 / s.speed) * 0.58));
  });
});

describe('F11 · source laws (60fps by construction + mount isolation)', () => {
  test('native driver, transform-only, no per-frame JS', () => {
    const src = readFileSync('src/player/PseudoVisualizer.tsx', 'utf8');
    expect(src).toContain('useNativeDriver: true');
    expect(src).not.toMatch(/setInterval|requestAnimationFrame/); // no JS frame loop
    expect(src).not.toMatch(/useNativeDriver: false/);
  });

  test('mounts ONLY inside the player screen (zero cold start)', () => {
    // the component file list: the import may appear in exactly one screen
    const { execSync } = require('node:child_process');
    const hits = execSync(
      `grep -rl "PseudoVisualizer" src/ --include='*.tsx' --include='*.ts'`,
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .filter((f: string) => f !== 'src/player/PseudoVisualizer.tsx' && f !== 'src/player/visualizer.ts');
    expect(hits).toEqual(['src/screens/PlayerScreen.tsx']);
  });

  test('no audio-buffer DSP anywhere in the feature (standalone law)', () => {
    const core = readFileSync('src/player/visualizer.ts', 'utf8');
    const comp = readFileSync('src/player/PseudoVisualizer.tsx', 'utf8');
    for (const src of [core, comp]) {
      expect(src).not.toMatch(/AudioBuffer|decodeAudio|getFloatFrequency|AnalyserNode|expo-av/);
      expect(src).not.toMatch(/Math\.random\s*\(/);
    }
  });
});
