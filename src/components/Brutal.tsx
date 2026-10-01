/**
 * Brutal.tsx — PULSE primitives (editorial brutalism).
 *
 * Brutal      — the pressable: content presses INTO the paper
 *               (translate 2,2 over a hard offset shadow), 100ms,
 *               native driver, optional haptic. The signature feel.
 * OutlineText — Archivo Black with a hard 1.5px ink stroke (the
 *               prototype's -webkit-text-stroke em words), built from
 *               an 8-direction zero-radius text-shadow stack.
 * Kicker      — orange-deep mono micro label (the editorial eyebrow).
 * MonoText    — Space Mono uppercase meta text.
 * SourceBadge — the SAAVN / YT source chip (YT inverted).
 * PulseDot    — blinking orange square (live wire indicator).
 * Ticker      — the marquee strip: ink bar, mono uppercase, acid dots,
 *               26s linear loop, native driver.
 */

import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
  type PressableProps,
  type StyleProp,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { colors, fonts, hardShadow, orangeShadow } from '../theme';

export function Brutal({
  children,
  style,
  contentStyle,
  shadow = 4,
  onInk = false,
  pressOffset = 2,
  haptic = true,
  disabled,
  onPress,
  onLongPress,
  testID,
  onPressIn,
  onPressOut,
  ...rest
}: PressableProps & {
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  /** hard shadow depth in px */
  shadow?: number;
  /** orange shadow (for elements sitting on ink panels) */
  onInk?: boolean;
  pressOffset?: number;
  haptic?: boolean;
}) {
  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;

  const handleIn = useCallbackRef((e: never) => {
    Animated.parallel([
      Animated.timing(tx, { toValue: pressOffset, duration: 100, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(ty, { toValue: pressOffset, duration: 100, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]).start();
    if (haptic) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    onPressIn?.(e as never);
  });

  const handleOut = useCallbackRef((e: never) => {
    Animated.parallel([
      Animated.timing(tx, { toValue: 0, duration: 120, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(ty, { toValue: 0, duration: 120, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]).start();
    onPressOut?.(e as never);
  });

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      testID={testID}
      onPressIn={handleIn as never}
      onPressOut={handleOut as never}
      {...rest}
    >
      <Animated.View
        style={[
          onInk ? orangeShadow(shadow) : hardShadow(shadow),
          style,
          { transform: [{ translateX: tx }, { translateY: ty }] },
          contentStyle,
        ]}
      >
        {children as React.ReactNode}
      </Animated.View>
    </Pressable>
  );
}

function useCallbackRef(fn: (e: never) => void) {
  const ref = useRef(fn);
  ref.current = fn;
  return useRef((e: never) => ref.current(e)).current;
}

/** Archivo Black display text with a hard ink stroke (the outline em). */
export function OutlineText({
  children,
  style,
  outline = 1.5,
  strokeColor = colors.ink,
  ...rest
}: TextProps & { outline?: number; strokeColor?: string; children?: React.ReactNode }) {
  const offs: Array<[number, number]> = [
    [outline, 0], [-outline, 0], [0, outline], [0, -outline],
    [outline * 0.71, outline * 0.71], [-outline * 0.71, -outline * 0.71],
    [outline * 0.71, -outline * 0.71], [-outline * 0.71, outline * 0.71],
  ];
  const base = [style, { fontFamily: (style as TextStyle)?.fontFamily ?? fonts.display }] as StyleProp<TextStyle>;
  return (
    <View>
      {offs.map(([dx, dy], i) => (
        <Text
          key={i}
          aria-hidden
          importantForAccessibility="no"
          style={StyleSheet.flatten([base, styles.outlineLayer, { color: strokeColor, textShadowColor: strokeColor, textShadowOffset: { width: dx, height: dy } }])}
          {...rest}
        >
          {children}
        </Text>
      ))}
      <Text style={StyleSheet.flatten([base, { color: 'transparent' }])} {...rest}>
        {children}
      </Text>
    </View>
  );
}

/** Orange-deep mono eyebrow label. */
export function Kicker({
  children,
  color = colors.orangeDeep,
  style,
  dot = false,
}: {
  children?: React.ReactNode;
  color?: string;
  style?: StyleProp<TextStyle>;
  dot?: boolean;
}) {
  return (
    <View style={styles.kickerRow}>
      {dot ? <View style={[styles.kickerDot, { backgroundColor: color === colors.orangeDeep ? colors.orange : color }]} /> : null}
      <Text style={[styles.kicker, { color }, style]} maxFontSizeMultiplier={1.2}>
        {children}
      </Text>
    </View>
  );
}

/** Space Mono uppercase meta. */
export function MonoText({
  children,
  size = 9.5,
  color = colors.ink40,
  bold = false,
  style,
  ...rest
}: TextProps & { size?: number; color?: string; bold?: boolean; children?: React.ReactNode }) {
  return (
    <Text
      style={[
        {
          fontFamily: bold ? fonts.monoBold : fonts.mono,
          fontSize: size,
          letterSpacing: 0.6,
          textTransform: 'uppercase',
          color,
        },
        style,
      ]}
      maxFontSizeMultiplier={1.3}
      {...rest}
    >
      {children}
    </Text>
  );
}

/** Track source chip — SAAVN outlined / YT inverted / others mapped. */
export function SourceBadge({ source, style }: { source?: string; style?: StyleProp<ViewStyle> }) {
  if (!source) return null;
  const yt = source === 'youtube';
  const label =
    source === 'youtube' ? 'YT' : source === 'itunes' ? 'PREVIEW' : source === 'local' ? 'SAVED' : 'SAAVN';
  return (
    <View style={[styles.src, yt && styles.srcYt, style]}>
      <MonoText size={8} bold color={yt ? colors.acid : colors.ink60} style={{ letterSpacing: 1 }}>
        {label}
      </MonoText>
    </View>
  );
}

/** Blinking orange square — the live-wire indicator. */
export function PulseDot({ size = 8, color = colors.orange }: { size?: number; color?: string }) {
  const op = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(op, { toValue: 0, duration: 600, useNativeDriver: true }),
        Animated.timing(op, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [op]);
  return <Animated.View style={{ width: size, height: size, backgroundColor: color, opacity: op }} />;
}

/** The broadsheet ticker — ink strip, mono uppercase, acid separators. */
export function Ticker({ items, duration = 26000 }: { items: string[]; duration?: number }) {
  const x = useRef(new Animated.Value(0)).current;
  const halfRef = useRef(0);
  const loopRef = useRef<Animated.CompositeAnimation | null>(null);

  const start = () => {
    loopRef.current?.stop();
    if (halfRef.current > 0) {
      loopRef.current = Animated.loop(
        Animated.timing(x, { toValue: -halfRef.current, duration, easing: Easing.linear, useNativeDriver: true }),
      );
      loopRef.current.start();
    }
  };

  useEffect(() => {
    x.setValue(0);
    start();
    return () => loopRef.current?.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const run = items.map((t, i) => (
    <Text key={i} style={styles.tkText}>
      {t}
      <Text style={{ color: colors.acid }}>{'  \u2726  '}</Text>
    </Text>
  ));

  return (
    <View style={styles.ticker}>
      <Animated.View
        style={{ flexDirection: 'row', transform: [{ translateX: x }] }}
        onLayout={(e) => {
          const w = e.nativeEvent.layout.width / 2;
          if (w > 0 && Math.abs(w - halfRef.current) > 1) {
            halfRef.current = w;
            x.setValue(0);
            start();
          }
        }}
      >
        <View style={styles.tkHalf}>{run}</View>
        <View style={styles.tkHalf}>{run}</View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  outlineLayer: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    textShadowRadius: 0,
  },
  kickerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  kickerDot: { width: 7, height: 7 },
  kicker: {
    fontFamily: fonts.monoBold,
    fontSize: 9.5,
    letterSpacing: 2.2,
    textTransform: 'uppercase',
  },
  src: {
    borderWidth: 1.5,
    borderColor: colors.ink,
    paddingHorizontal: 6,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  srcYt: { backgroundColor: colors.ink },
  ticker: {
    backgroundColor: colors.ink,
    overflow: 'hidden',
    borderTopWidth: 2,
    borderBottomWidth: 2,
    borderTopColor: colors.ink,
    borderBottomColor: colors.ink,
    paddingVertical: 6,
  },
  tkHalf: { flexDirection: 'row', alignItems: 'center' },
  tkText: {
    fontFamily: fonts.monoBold,
    fontSize: 10.5,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: colors.onInk,
    paddingLeft: 14,
  },
});
