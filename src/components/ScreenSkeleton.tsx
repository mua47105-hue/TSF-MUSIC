/**
 * WAVE A (A3) — the lazy-screen fallback.
 *
 * Eight screens are deferred off the boot bundle (React.lazy + async
 * routes): the FIRST visit to one shows this skeleton for the split
 * second the chunk takes to parse — then the real screen, real data,
 * no further loading surfaces. A deterministic shimmer (an Animated
 * opacity loop — no Math.random anywhere), paper-toned so it reads as
 * "the app is arriving", never as a fake screen: no text, no fake rows,
 * no shapes pretending to be content (the honesty law — a skeleton that
 * fakes content is a lie with a fade).
 *
 * Cold-path note: this component is imported by App.tsx at module scope
 * (it IS part of the boot bundle) — it is ~1 KB of Animated wiring, the
 * price of the fallback, and it renders only when a lazy screen is
 * actually loading.
 */

import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { colors } from '../theme';

export function ScreenSkeleton() {
  const shimmer = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmer, { toValue: 1, duration: 850, useNativeDriver: true }),
        Animated.timing(shimmer, { toValue: 0, duration: 850, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [shimmer]);
  const opacity = shimmer.interpolate({ inputRange: [0, 1], outputRange: [0.3, 0.75] });
  return (
    <View style={styles.wrap} testID="lazy-screen-skeleton">
      <Animated.View style={[styles.block, styles.head, { opacity }]} />
      <Animated.View style={[styles.block, styles.row, { opacity }]} />
      <Animated.View style={[styles.block, styles.row, { opacity }]} />
      <Animated.View style={[styles.block, styles.row, { opacity }]} />
      <Animated.View style={[styles.block, styles.row, { opacity }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: colors.paper,
    paddingHorizontal: 20,
    paddingTop: 24,
    gap: 14,
  },
  block: {
    backgroundColor: colors.ink16,
    borderRadius: 2,
  },
  head: { height: 44, width: '72%' },
  row: { height: 18, width: '100%' },
});
