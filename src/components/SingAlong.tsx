/**
 * SingAlong — the karaoke card (Task 29 · godmode wave 2 → THE TEN F8
 * kinetic typography upgrade).
 *
 * A synced-lyrics timeline: the ACTIVE line prints LARGE in the song's
 * palette glow and grows with a spring; the rest sit dimmed below.
 * The view auto-scrolls to keep the active line centered, and ANY line
 * is tappable to seek the song to that moment — the Apple-Music-Sing
 * interaction, in PULSE ink.
 *
 * THE TEN F8 contract:
 *  - the active line is ALWAYS the one activeLrcIndex selects (no drift
 *    — the mapping function is shared, locked, and untouched);
 *  - colors come from the dynamic palette via the `tint` prop — never
 *    hardcoded (null tint ⇒ the classic ink highlight, the pre-F8 look);
 *  - only the active/inactive swap animates (one spring per change) —
 *    the 250ms progress tick re-renders memoized rows only, no timers;
 *  - uniform row height (KINETIC.lineHeight) keeps the scroll math
 *    exact across size changes;
 *  - the dim is a cheap OPACITY — never a real blur (potato phones).
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, fonts } from '../theme';
import { KINETIC } from '../ai/core/constants';
import { activeLrcIndex, kineticLineSpec, kineticScrollTarget, type LrcLine } from '../player/singalong';

// THE SINGLE SOURCE: the scroll math and the row style BOTH read
// KINETIC.lineHeight — the uniform-height contract cannot drift.
const VIEW_H = 190;

interface Props {
  lines: LrcLine[];
  /** playback position in ms (the parent's useProgress tick) */
  positionMs: number;
  /** seek the player to a line's timestamp, in seconds */
  onSeek: (seconds: number) => void;
  /** the song palette's glow color — the active line's tint (F8) */
  tint?: string | null;
}

interface RowProps {
  line: LrcLine;
  active: boolean;
  tint?: string | null;
  onPress: (tMs: number) => void;
  testID?: string;
}

const LrcRow = React.memo(function LrcRow({ line, active, tint, onPress, testID }: RowProps) {
  // THE F8 spring: ONE animated value per row, driven only by the
  // active/inactive swap — the 250ms progress tick never touches it.
  const grow = useRef(new Animated.Value(active ? 1 : 0)).current;
  useEffect(() => {
    Animated.spring(grow, {
      toValue: active ? 1 : 0,
      useNativeDriver: true,
      friction: 8,
      tension: 60,
    }).start();
  }, [active, grow]);

  const spec = kineticLineSpec(active, tint);
  // the spring breathes between the inactive and active font sizes
  const fontSize = grow.interpolate({
    inputRange: [0, 1],
    outputRange: [KINETIC.inactiveFontSize, spec.fontSize],
  });

  return (
    <Pressable
      onPress={() => onPress(line.tMs)}
      hitSlop={3}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`Jump to ${line.text}`}
    >
      <Animated.Text
        style={[
          styles.lrc,
          {
            fontSize,
            lineHeight: spec.lineHeight,
            opacity: spec.opacity,
            color: spec.activeTint ?? (active ? colors.ink : colors.ink40),
          },
        ]}
        numberOfLines={1}
      >
        {line.text}
      </Animated.Text>
    </Pressable>
  );
});

export function SingAlong({ lines, positionMs, onSeek, tint }: Props) {
  const scrollRef = useRef<ScrollView>(null);
  const lastIdx = useRef(-2);
  const seekRef = useRef(onSeek);
  seekRef.current = onSeek;

  // NO DRIFT: the active line is ALWAYS activeLrcIndex's pick — the same
  // locked binary search the share card and the lab use.
  const activeIdx = activeLrcIndex(lines, positionMs);

  // auto-scroll ONLY when the active line changes (not on every tick)
  useEffect(() => {
    if (activeIdx === lastIdx.current) return;
    lastIdx.current = activeIdx;
    scrollRef.current?.scrollTo({ y: kineticScrollTarget(activeIdx, VIEW_H), animated: true });
  }, [activeIdx]);

  // STABLE identity (critic SA-4): a fresh closure here every render would
  // defeat LrcRow's memo — all rows would repaint on every 250ms tick.
  const handlePress = useCallback((tMs: number) => seekRef.current(tMs / 1000), []);

  return (
    <View>
      <ScrollView
        ref={scrollRef}
        style={styles.view}
        nestedScrollEnabled
        showsVerticalScrollIndicator={false}
        testID="singalong-scroll"
      >
        {lines.map((line, i) => (
          <LrcRow
            key={`${line.tMs}-${i}`}
            line={line}
            active={i === activeIdx}
            tint={tint}
            onPress={handlePress}
            testID={i === activeIdx ? 'singalong-active' : undefined}
          />
        ))}
        {/* bottom breathing room so the last line can center too */}
        <View style={{ height: VIEW_H / 2 - KINETIC.lineHeight / 2 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  view: {
    height: VIEW_H,
    marginTop: 8,
  },
  lrc: {
    height: KINETIC.lineHeight,
    fontFamily: fonts.regular,
    letterSpacing: 0.2,
  },
});
