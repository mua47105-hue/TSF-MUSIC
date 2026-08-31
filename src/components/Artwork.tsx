/**
 * Artwork — remote cover with deterministic gradient fallback.
 * Variants mirror Spotify corner radii: 'card' shelf art (8), 'rounded'
 * rows (4), 'mini' mini-player art (4), 'circle' artists.
 * 'liked' renders Spotify's iconic purple→green Liked Songs tile.
 */

import React from 'react';
import { Image, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme';

const GRADIENTS: Array<[string, string]> = [
  ['#7C4DFF', '#00E5FF'],
  ['#E8115B', '#7C4DFF'],
  ['#0D73EC', '#503750'],
  ['#FF8A00', '#E52E71'],
  ['#1DB954', '#0D73EC'],
  ['#AF2896', '#503750'],
];

function gradientFor(seed: string): [string, string] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return GRADIENTS[h % GRADIENTS.length] as [string, string];
}

export const Artwork = React.memo(function Artwork({
  uri,
  seed,
  size,
  style,
  variant = 'rounded',
  liked = false,
  initials,
}: {
  uri?: string;
  seed: string;
  size: number;
  style?: StyleProp<ViewStyle>;
  variant?: 'card' | 'rounded' | 'mini' | 'circle' | 'square';
  /** Render Spotify's Liked Songs gradient heart tile. */
  liked?: boolean;
  /** When no image: render the letter(s) instead of the notes icon
   *  (artist circles without a photo — v3.2 honest fallback). */
  initials?: string;
}) {
  const [failed, setFailed] = React.useState(false);
  const borderRadius =
    variant === 'circle'
      ? size / 2
      : variant === 'card'
        ? 8
        : variant === 'square'
          ? 0
          : 4;

  if (liked) {
    return (
      <View style={[styles.fallback, { width: size, height: size, borderRadius }, style]}>
        <LinearGradient
          colors={[colors.likedStart, colors.likedEnd]}
          start={{ x: 0.1, y: 0.1 }}
          end={{ x: 0.9, y: 0.9 }}
          style={[styles.gradient, { borderRadius }]}
        >
          <Ionicons name="heart" size={Math.max(14, size * 0.42)} color="#FFFFFF" />
        </LinearGradient>
      </View>
    );
  }

  if (!uri || failed) {
    const [a, b] = gradientFor(seed);
    return (
      <View style={[styles.fallback, { width: size, height: size, borderRadius }, style]}>
        <LinearGradient
          colors={[a, b]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[styles.gradient, { borderRadius }]}
        >
          {initials ? (
            <Text style={[styles.initials, { fontSize: Math.max(13, size * 0.3) }]} allowFontScaling={false}>
              {initials.slice(0, 2).toUpperCase()}
            </Text>
          ) : (
            <Ionicons name="musical-notes" size={Math.max(14, size * 0.28)} color="rgba(255,255,255,0.85)" />
          )}
        </LinearGradient>
      </View>
    );
  }
  return (
    <View
      style={[
        styles.imageWrap,
        { width: size, height: size, borderRadius, overflow: 'hidden' },
        style,
      ]}
    >
      <Image
        source={{ uri }}
        style={styles.imageFill}
        onError={() => setFailed(true)}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  imageWrap: { backgroundColor: colors.surface },
  imageFill: { width: '100%', height: '100%' },
  fallback: { overflow: 'hidden' },
  initials: {
    color: 'rgba(255,255,255,0.94)',
    fontWeight: '800',
    fontFamily: 'Figtree-800',
    letterSpacing: 0.5,
  },
  gradient: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
