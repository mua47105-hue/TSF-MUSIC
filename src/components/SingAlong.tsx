/**
 * SingAlong — the karaoke card (Task 29 · godmode wave 2).
 *
 * A synced-lyrics timeline: the active line prints in ink and grows,
 * the rest sit in ink40; the view auto-scrolls to keep the active line
 * centered, and ANY line is tappable to seek the song to that moment —
 * the Apple-Music-Sing / Spotify-Karaoke interaction, in PULSE ink.
 *
 * Perf contract: rows are memoized (only the active/inactive swap
 * re-renders); the parent recomputes the active index from the existing
 * 250ms progress tick — no extra timer, no bridge spam.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, fonts } from '../theme';
import { activeLrcIndex, type LrcLine } from '../player/singalong';

const LINE_H = 30;
const VIEW_H = 168;

interface Props {
  lines: LrcLine[];
  /** playback position in ms (the parent's useProgress tick) */
  positionMs: number;
  /** seek the player to a line's timestamp, in seconds */
  onSeek: (seconds: number) => void;
}

interface RowProps {
  line: LrcLine;
  active: boolean;
  onPress: (tMs: number) => void;
  testID?: string;
}

const LrcRow = React.memo(function LrcRow({ line, active, onPress, testID }: RowProps) {
  return (
    <Pressable
      onPress={() => onPress(line.tMs)}
      hitSlop={3}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`Jump to ${line.text}`}
    >
      <Text style={[styles.lrc, active && styles.lrcOn]} numberOfLines={1}>
        {line.text}
      </Text>
    </Pressable>
  );
});

export function SingAlong({ lines, positionMs, onSeek }: Props) {
  const scrollRef = useRef<ScrollView>(null);
  const lastIdx = useRef(-2);
  const seekRef = useRef(onSeek);
  seekRef.current = onSeek;

  const activeIdx = activeLrcIndex(lines, positionMs);

  // auto-scroll ONLY when the active line changes (not on every tick)
  useEffect(() => {
    if (activeIdx === lastIdx.current) return;
    lastIdx.current = activeIdx;
    const target = activeIdx * LINE_H + LINE_H / 2 - VIEW_H / 2;
    scrollRef.current?.scrollTo({ y: Math.max(0, target), animated: true });
  }, [activeIdx]);

  // STABLE identity (critic SA-4): a fresh closure here every render would
  // defeat LrcRow's memo — all rows would repaint on every 250ms tick.
  const handlePress = useCallback((tMs: number) => seekRef.current(tMs / 1000), []);

  return (
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
          onPress={handlePress}
          testID={i === activeIdx ? 'singalong-active' : undefined}
        />
      ))}
      {/* bottom breathing room so the last line can center too */}
      <View style={{ height: VIEW_H / 2 - LINE_H / 2 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  view: {
    height: VIEW_H,
    marginTop: 8,
  },
  lrc: {
    height: LINE_H,
    lineHeight: LINE_H,
    fontSize: 13,
    fontFamily: fonts.regular,
    color: colors.ink40,
    letterSpacing: 0.2,
  },
  lrcOn: {
    fontFamily: fonts.semibold,
    color: colors.ink,
    fontSize: 15,
  },
});
