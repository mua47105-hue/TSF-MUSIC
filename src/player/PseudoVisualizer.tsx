/**
 * PSEUDO-VISUALIZER (MAGNUM OPUS · F11) — the equalizer behind the
 * player art.
 *
 * 60fps BY CONSTRUCTION: one Animated.loop per bar, useNativeDriver:
 * true, transform-only — after start(), NO JS runs per frame (the JS
 * thread only re-configures loops on track change / reduce-motion).
 * Mounts INSIDE the PlayerScreen modal only (zero cold-start cost —
 * App.tsx and mindbeat.init() never see this module).
 *
 * HONESTY: this is NOT an audio spectrum analyzer. There is no audio-
 * buffer DSP in the app (standalone law); the bars breathe to the
 * track's BAKED energy/valence/tempo row, and with no baked row they
 * fall to the calmest wash rather than fake a beat the app cannot hear.
 * The OS reduce-motion intent freezes the frame entirely.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, View } from 'react-native';
import { VISUALIZER } from '../ai/core/constants';
import { barDurations, barTransform, visualizerState, type VisualizerFeatures } from './visualizer';
import { colors } from '../theme';

interface Props {
  features: VisualizerFeatures | null;
  /** the song palette's glow — bar tint (null → the classic ink) */
  tint?: string | null;
  /** px — the art hero's height the bars rise from (default 320) */
  height?: number;
}

export function PseudoVisualizer({ features, tint, height = 320 }: Props) {
  const [reducedMotion, setReducedMotion] = React.useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => live && setReducedMotion(v)).catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => setReducedMotion(v));
    return () => {
      live = false;
      sub.remove();
    };
  }, []);

  const hasBaked = !!features;
  const state = useMemo(
    () => visualizerState(features, 0, { reducedMotion, hasBakedFeatures: hasBaked }),
    [features, reducedMotion, hasBaked],
  );

  // ONE animated value per bar — created once, re-driven only when the
  // state's identity changes (track change, freeze, unfreeze).
  const valuesRef = useRef<Animated.Value[] | null>(null);
  if (!valuesRef.current) {
    valuesRef.current = Array.from({ length: VISUALIZER.barCount }, () => new Animated.Value(0));
  }
  const values = valuesRef.current;

  useEffect(() => {
    if (state.frozen) {
      values.forEach((v) => {
        v.stopAnimation();
        v.setValue(0); // the frozen frame: bars at TRUE rest (scaled to the floor), never mid-air
      });
      return undefined;
    }
    const { upMs, downMs } = barDurations(state);
    const loops = values.map((v, i) => {
      // the even stagger (state.phases) spreads the bars into a wave —
      // the delay sits BEFORE the loop so every bar keeps the SAME
      // period (up+down) and the stagger never drifts (blind-critic P2)
      const offset = Math.round(state.phases[i] * upMs);
      const loop = Animated.sequence([
        Animated.delay(offset),
        Animated.loop(
          Animated.sequence([
            Animated.timing(v, { toValue: 1, duration: upMs, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
            Animated.timing(v, { toValue: 0, duration: downMs, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          ]),
        ),
      ]);
      loop.start();
      return loop;
    });
    return () => loops.forEach((l) => l.stop());
  }, [state, values]);

  const barW = 3;
  const gap = 4;
  const totalW = VISUALIZER.barCount * (barW + gap) - gap;

  return (
    <View
      pointerEvents="none"
      style={[styles.wrap, { height, width: totalW }]}
      testID="pseudo-visualizer"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {values.map((v, i) => (
        <Bar key={i} value={v} amplitude={state.amplitude} tint={tint} />
      ))}
    </View>
  );
}

const Bar = React.memo(function Bar({
  value,
  amplitude,
  tint,
}: {
  value: Animated.Value;
  amplitude: number;
  tint?: string | null;
}) {
  // THE bottom-anchored transform (pure, lock-verified in visualizer.ts):
  // scaleY shrinks around the center; translateY pushes the bar back
  // down by exactly (1 - scale) × amplitude / 2 so the base never floats.
  const scaleY = value.interpolate({
    inputRange: [0, 1],
    outputRange: [VISUALIZER.minBarScale, 1],
  });
  const translateY = value.interpolate({
    inputRange: [0, 1],
    outputRange: [((1 - VISUALIZER.minBarScale) * amplitude) / 2, 0],
  });
  return (
    <View style={styles.slot}>
      <Animated.View
        style={[styles.bar, { backgroundColor: tint ?? colors.ink, height: amplitude, transform: [{ scaleY }, { translateY }] }]}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    // the bar tips peek just BELOW the art card's bottom edge — the
    // visualizer sits behind the art (rendered first) but stays visible
    bottom: -12,
    left: 0,
    flexDirection: 'row',
    alignItems: 'flex-end',
    opacity: 0.5,
  },
  slot: {
    width: 3,
    marginRight: 4,
    height: '100%',
    justifyContent: 'flex-end',
  },
  bar: {
    width: 3,
    borderRadius: 1.5,
  },
});
