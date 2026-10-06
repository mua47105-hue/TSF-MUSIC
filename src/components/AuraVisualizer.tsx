/**
 * AuraVisualizer — THE TEN · FEATURE 9: the living backdrop that
 * breathes with the song, built from the album art's palette.
 *
 * BATTERY CONTRACT (the whole feature is this list):
 *   • exactly THREE expo-linear-gradient layers (JSX structure) — NO
 *     video, NO canvas, NO blur, NO per-frame JS math;
 *   • only OPACITY animates (native driver, rounded to the pulse period
 *     — the JS thread wakes once per pulse, not per frame);
 *   • motion speed/intensity come from the PURE auraMotion(energy) spec
 *     (src/theme/aura.ts) fed by the track's baked energy;
 *   • OS reduce-motion freezes the aura (static wash, zero loops);
 *     data saver calms it to half speed (battery first);
 *   • no palette ⇒ the palette provider's deterministic fallback is
 *     already in use (useDynamicPalette never fails);
 *   • mounts with the Player screen (post-paint) — cold start untouched.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Animated } from 'react-native';
import { withAlpha, type DynamicPalette } from '../theme/dynamic';
import { auraMode, auraMotion } from '../theme/aura';
import type { AuraMode } from '../theme/aura';

interface Props {
  palette: DynamicPalette;
  /** the current track's BAKED energy (null ⇒ calmest wash) */
  energy: number | null | undefined;
  /** data-saver intent (the audioQuality flag) */
  dataSaver: boolean;
}

export function AuraVisualizer({ palette, energy, dataSaver }: Props) {
  const [reduceMotion, setReduceMotion] = React.useState(false);
  const mode: AuraMode = auraMode(reduceMotion, dataSaver);
  const motion = useMemo(() => auraMotion(energy), [energy]);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled()
      .then(setReduceMotion)
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => sub?.remove();
  }, []);

  // THREE looping opacity pulses, phase-offset; the JS thread wakes once
  // per pulse (duration = the pulse period), the native driver does the rest.
  const a1 = useRef(new Animated.Value(0)).current;
  const a2 = useRef(new Animated.Value(0)).current;
  const a3 = useRef(new Animated.Value(0)).current;
  const anims = [a1, a2, a3];

  useEffect(() => {
    if (mode === 'frozen') {
      anims.forEach((a) => a.stopAnimation());
      a1.setValue(0.5);
      a2.setValue(0.2);
      a3.setValue(0.8);
      return undefined;
    }
    // data saver calms: half speed (a longer period = fewer wake-ups)
    const scale = mode === 'calm' ? 2 : 1;
    // TRUE phase offsets: a ONE-TIME delay before each loop shifts the
    // layer's start; every loop then runs the same period, so the layers
    // breathe in a slow wave forever (lockstep would be a flat wash).
    // offsets scale with the ACTUAL period (calm mode stretches it 2×)
    const phase = Math.round((motion.pulseMs * scale) / 3);
    const driven = anims.map((a, i) =>
      i === 0 ? Animated.loop(
        Animated.sequence([
          Animated.timing(a, { toValue: 1, duration: Math.round((motion.pulseMs * scale) / 2), easing: (t) => 0.5 - Math.cos(Math.PI * t) / 2, useNativeDriver: true }),
          Animated.timing(a, { toValue: 0, duration: Math.round((motion.pulseMs * scale) / 2), easing: (t) => 0.5 - Math.cos(Math.PI * t) / 2, useNativeDriver: true }),
        ]),
      ) : Animated.sequence([
        Animated.delay(phase * i),
        Animated.loop(
          Animated.sequence([
            Animated.timing(a, { toValue: 1, duration: Math.round((motion.pulseMs * scale) / 2), easing: (t) => 0.5 - Math.cos(Math.PI * t) / 2, useNativeDriver: true }),
            Animated.timing(a, { toValue: 0, duration: Math.round((motion.pulseMs * scale) / 2), easing: (t) => 0.5 - Math.cos(Math.PI * t) / 2, useNativeDriver: true }),
          ]),
        ),
      ]),
    );
    driven.forEach((d) => d.start());
    return () => driven.forEach((d) => d.stop());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, motion.pulseMs, palette.key]);

  const glow = (i: number) => {
    const a = anims[i]!;
    const min = motion.minGlow;
    const max = motion.maxGlow;
    return a.interpolate({ inputRange: [0, 1], outputRange: [min, max] });
  };

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} testID="aura-visualizer">
      {/* layer 1 — the deep wash breathing with the song's energy */}
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: glow(0) }]}>
        <LinearGradient
          colors={[withAlpha(palette.deep, 0.9), withAlpha(palette.dominant, 0.25), 'rgba(0,0,0,0)']}
          start={{ x: 0.2, y: 0 }}
          end={{ x: 0.8, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
      {/* layer 2 — the vibrant bloom, phase-offset */}
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: glow(1) }]}>
        <LinearGradient
          colors={['rgba(0,0,0,0)', withAlpha(palette.vibrant, 0.22), 'rgba(0,0,0,0)']}
          start={{ x: 1, y: 0.1 }}
          end={{ x: 0, y: 0.9 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
      {/* layer 3 — the glow whisper at the floor */}
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: glow(2) }]}>
        <LinearGradient
          colors={['rgba(0,0,0,0)', withAlpha(palette.glow, 0.16)]}
          start={{ x: 0.5, y: 0.55 }}
          end={{ x: 0.5, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </View>
  );
}


