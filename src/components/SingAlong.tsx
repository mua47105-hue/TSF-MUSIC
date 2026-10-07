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

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, fonts } from '../theme';
import { KINETIC, KARAOKE } from '../ai/core/constants';
import { activeLrcIndex, kineticLineSpec, kineticScrollTarget, withWordSpans, activeWord, type LrcLine } from '../player/singalong';

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
  line: LrcLine & { words?: { word: string; startMs: number; endMs: number }[] };
  active: boolean;
  tint?: string | null;
  onPress: (tMs: number) => void;
  testID?: string;
  /** MAGNUM OPUS F12 — the word being sung (active row only; -1 = the
   *  line-level degradation). Inactive rows always get -1, so the memo
   *  keeps them silent on progress ticks. */
  wordIndex?: number;
}

const LrcRow = React.memo(function LrcRow({ line, active, tint, onPress, testID, wordIndex = -1 }: RowProps) {
  // THE F8 spring: ONE animated value per row, driven only by the
  // active/inactive swap — the 250ms progress tick never touches it.
  // (Skipped when the word-level look renders — its Animated.Text is
  // not mounted, so the spring would be dead work. Blind-critic P2.)
  const grow = useRef(new Animated.Value(active ? 1 : 0)).current;
  const showWords = active && wordIndex >= 0 && !!line.words && line.words.length > 0;
  useEffect(() => {
    if (showWords) return; // no Animated.Text to drive
    Animated.spring(grow, {
      toValue: active ? 1 : 0,
      useNativeDriver: true,
      friction: 8,
      tension: 60,
    }).start();
  }, [active, grow, showWords]);

  const spec = kineticLineSpec(active, tint);
  // the spring breathes between the inactive and active font sizes
  const fontSize = grow.interpolate({
    inputRange: [0, 1],
    outputRange: [KINETIC.inactiveFontSize, spec.fontSize],
  });

  // MAGNUM OPUS F12 — KARAOKE WORDS: only the active row with a computable
  // word timeline renders the word-level look (see `showWords` above);
  // everything else (inactive rows, single-word lines, zero-span lines)
  // renders EXACTLY the pre-F12 line — the degradation is structural,
  // never a flag.

  const wordContent = (words: NonNullable<RowProps['line']['words']>) =>
    words.map((w: { word: string; startMs: number; endMs: number }, i: number) => {
      const sung = i < wordIndex;
      const isCurrent = i === wordIndex;
      return (
        <Text
          key={`${w.startMs}-${i}`}
          style={{
            fontSize: isCurrent ? KARAOKE.activeWordFontSize : spec.fontSize,
            lineHeight: KINETIC.lineHeight, // the uniform-height contract holds word-by-word
            color: isCurrent ? (spec.activeTint ?? colors.ink) : colors.ink,
            opacity: isCurrent ? 1 : sung ? KARAOKE.sungDim : KINETIC.inactiveOpacity + KARAOKE.upcomingLift,
          }}
        >
          {i === 0 ? '' : ' '}
          {w.word}
        </Text>
      );
    });

  return (
    <Pressable
      onPress={() => onPress(line.tMs)}
      hitSlop={3}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`Jump to ${line.text}`}
    >
      {showWords ? (
        <Text
          testID={testID ? 'karaoke-active-line' : undefined}
          style={[styles.lrc, { fontSize: spec.fontSize, lineHeight: KINETIC.lineHeight, opacity: 1, color: colors.ink }]}
          numberOfLines={1}
        >
          {wordContent(line.words!)}
        </Text>
      ) : (
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
      )}
    </Pressable>
  );
});

export function SingAlong({ lines, positionMs, onSeek, tint }: Props) {
  const scrollRef = useRef<ScrollView>(null);
  const lastIdx = useRef(-2);
  const seekRef = useRef(onSeek);
  seekRef.current = onSeek;

  // MAGNUM OPUS F12 — the word timeline is derived ONCE per song (rides
  // the same memo as the parsed LRC — never per tick).
  const wordLines = useMemo(() => withWordSpans(lines), [lines]);

  // NO DRIFT: the active line is ALWAYS activeLrcIndex's pick — the same
  // locked binary search the share card and the lab use.
  const activeIdx = activeLrcIndex(lines, positionMs);
  // the word on the mic right now — ONE binary search per 250ms tick,
  // only meaningful for the active row (every other row gets -1)
  const wordIdx = activeIdx >= 0 ? activeWord(wordLines[activeIdx], positionMs) : -1;

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
        {wordLines.map((line, i) => (
          <LrcRow
            key={`${line.tMs}-${i}`}
            line={line}
            active={i === activeIdx}
            tint={tint}
            onPress={handlePress}
            wordIndex={i === activeIdx ? wordIdx : -1}
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
