/**
 * Artwork — PULSE cover primitive: SQUARE, zero radius, 1.5px ink
 * border (the prototype's bordered art everywhere). Fallback is the
 * prototype's diagonal hatch pattern with an ink music glyph — never a
 * wrong image. 'liked' renders the orange Liked Songs block with the
 * ink heart. React.memo (R8-P1 feed contract).
 */

import React from 'react';
import { Image, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fonts } from '../theme';

export const Artwork = React.memo(function Artwork({
  uri,
  seed,
  size,
  style,
  variant = 'square',
  liked = false,
  initials,
  bordered = true,
}: {
  uri?: string;
  seed: string;
  size: number;
  style?: StyleProp<ViewStyle>;
  /** 'square' everywhere in PULSE; 'circle' reserved for true avatars */
  variant?: 'card' | 'rounded' | 'mini' | 'circle' | 'square';
  /** Render the orange Liked Songs block. */
  liked?: boolean;
  /** Letters fallback (artist without a photo). */
  initials?: string;
  /** 1.5px ink frame (default on). */
  bordered?: boolean;
}) {
  const [failed, setFailed] = React.useState(false);
  const radius = variant === 'circle' ? size / 2 : 0;

  if (liked) {
    return (
      <View
        style={[
          styles.block,
          { width: size, height: size, borderRadius: radius, backgroundColor: colors.orange, borderWidth: bordered ? 1.5 : 0, borderColor: colors.ink },
          style,
        ]}
      >
        <Ionicons name="heart" size={Math.max(14, size * 0.42)} color={colors.ink} />
      </View>
    );
  }

  if (!uri || failed) {
    return (
      <View
        style={[
          styles.block,
          styles.hatch,
          { width: size, height: size, borderRadius: radius, borderWidth: bordered ? 1.5 : 0, borderColor: colors.ink },
          style,
        ]}
      >
        {initials ? (
          <Text style={[styles.initials, { fontSize: Math.max(12, size * 0.3) }]} allowFontScaling={false}>
            {initials.slice(0, 2).toUpperCase()}
          </Text>
        ) : (
          <Ionicons name="musical-notes" size={Math.max(12, size * 0.3)} color={colors.ink60} />
        )}
      </View>
    );
  }

  return (
    <View
      style={[
        styles.block,
        { width: size, height: size, borderRadius: radius, borderWidth: bordered ? 1.5 : 0, borderColor: colors.ink, overflow: 'hidden' },
        style,
      ]}
    >
      <Image source={{ uri }} style={styles.imageFill} onError={() => setFailed(true)} />
    </View>
  );
});

const styles = StyleSheet.create({
  block: {
    backgroundColor: colors.paper2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hatch: {
    backgroundColor: '#E3E0D4',
  },
  initials: {
    color: colors.ink,
    fontFamily: fonts.display,
    letterSpacing: 0.5,
  },
  imageFill: { width: '100%', height: '100%' },
});
