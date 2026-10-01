/**
 * Shelf — PULSE editorial primitives:
 *   Shelf      — kicker + Archivo Black header + full-width 1.5px rule
 *                + "Full list ▸" + horizontal rail
 *   ShelfCard  — bordered square cover w/ hard shadow + ink play FAB +
 *                uppercase title + mono meta (the .card)
 *   ArtistCard — grayscale square stamp ring, color on press (the .acard)
 *   QuickTile  — numbered 2-col index tile w/ hard shadow (the .tile)
 * All memo'd where lists re-render (R8-P1 contract).
 */

import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fonts, hardShadow } from '../theme';
import { Artwork } from './Artwork';
import { Brutal, MonoText } from './Brutal';

/** Editorial section header: orange kicker + display title + rule. */
export function Shelf({
  kicker,
  title,
  actionLabel,
  onAction,
  children,
}: {
  kicker?: string;
  title: string;
  actionLabel?: string;
  onAction?: () => void;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.shelf}>
      <View style={styles.header}>
        <View style={{ minWidth: 0 }}>
          {kicker ? (
            <MonoText size={9} bold color={colors.orangeDeep} style={{ letterSpacing: 2, marginBottom: 3 }} numberOfLines={1}>
              {kicker}
            </MonoText>
          ) : null}
          <Text style={styles.headerTitle} numberOfLines={1}>
            {title}
          </Text>
        </View>
        {actionLabel && onAction ? (
          <Pressable onPress={onAction} hitSlop={8}>
            <MonoText size={10} bold color={colors.ink60}>
              {actionLabel} ▸
            </MonoText>
          </Pressable>
        ) : null}
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scroller}
        overScrollMode="always"
      >
        {children}
      </ScrollView>
    </View>
  );
}

/** The .card — bordered cover, hard shadow, ink play FAB. */
export const ShelfCard = React.memo(function ShelfCard({
  title,
  subtitle,
  artwork,
  seed,
  onPress,
  onLongPress,
  size = 150,
  round = false,
  badge,
  subtitleMaxLines = 1,
  index,
}: {
  title: string;
  subtitle?: string;
  artwork?: string;
  seed: string;
  onPress: () => void;
  onLongPress?: () => void;
  size?: number;
  round?: boolean;
  badge?: React.ReactNode;
  subtitleMaxLines?: number;
  index?: string;
}) {
  return (
    <Brutal
      onPress={onPress}
      onLongPress={onLongPress}
      testID="shelf-card"
      shadow={4}
      style={{ width: size, backgroundColor: 'transparent' }}
      contentStyle={styles.cardInner}
      haptic
    >
      <View style={{ width: '100%' }}>
        <View style={[styles.coverWrap, { width: size, height: size }]}>
          <Artwork uri={artwork} seed={seed} size={size} variant={round ? 'circle' : 'square'} style={round ? styles.artistRing : undefined} />
          {badge}
          <View style={styles.fab}>
            <Ionicons name="play" size={13} color={colors.acid} />
          </View>
        </View>
      </View>
      {index ? (
        <MonoText size={9} bold color={colors.ink40} style={{ marginTop: 8 }}>
          {index}
        </MonoText>
      ) : null}
      <Text style={[styles.cardTitle, index ? { marginTop: 2 } : { marginTop: 8 }]} numberOfLines={1}>
        {title}
      </Text>
      {subtitle ? (
        <MonoText size={9.5} style={{ marginTop: 2 }} numberOfLines={subtitleMaxLines}>
          {subtitle}
        </MonoText>
      ) : null}
    </Brutal>
  );
});

/** The .acard — grayscale square stamp ring; color on press. */
export const ArtistCard = React.memo(function ArtistCard({
  name,
  meta,
  artwork,
  seed,
  onPress,
  size = 112,
}: {
  name: string;
  meta?: string;
  artwork?: string;
  seed: string;
  onPress: () => void;
  size?: number;
}) {
  const [pressed, setPressed] = React.useState(false);
  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      testID="home-artist"
      style={{ width: size }}
    >
      <View
        style={[
          styles.artistRing,
          { width: size - 6, height: size - 6 },
          pressed && { shadowColor: colors.orange },
        ]}
      >
        <Artwork uri={artwork} seed={seed} size={size - 6} variant="square" bordered={false} initials={name} style={{ opacity: pressed ? 1 : 0.88 }} />
      </View>
      <Text style={styles.artistName} numberOfLines={1}>
        {name}
      </Text>
      {meta ? (
        <MonoText size={9} style={{ marginTop: 2, textAlign: 'center' }} numberOfLines={1}>
          {meta}
        </MonoText>
      ) : null}
    </Pressable>
  );
});

/**
 * QuickTile — the numbered index tile: bordered paper, hard shadow,
 * 44px bordered art flush-left, uppercase label + mono meta.
 */
export const QuickTile = React.memo(function QuickTile({
  title,
  subtitle,
  artwork,
  seed,
  onPress,
  width,
  icon,
  liked = false,
  acid = false,
}: {
  title: string;
  subtitle?: string;
  artwork?: string;
  seed: string;
  onPress: () => void;
  width?: number;
  /** ink square glyph tile (e.g. AI) */
  icon?: keyof typeof Ionicons.glyphMap;
  liked?: boolean;
  acid?: boolean;
}) {
  return (
    <Brutal
      onPress={onPress}
      shadow={3}
      style={[styles.tile, width != null ? { width } : null]}
      haptic
    >
      {icon ? (
        <View style={[styles.tileArt, liked && { backgroundColor: colors.orange }, acid && { backgroundColor: colors.acid }]}>
          <Ionicons name={icon} size={18} color={colors.ink} />
        </View>
      ) : liked ? (
        <View style={[styles.tileArt, { backgroundColor: colors.orange }]}>
          <Ionicons name="heart" size={18} color={colors.ink} />
        </View>
      ) : (
        <Artwork uri={artwork} seed={seed} size={44} />
      )}
      <View style={styles.tileText}>
        <Text style={styles.tileTitle} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <MonoText size={9.5} style={{ marginTop: 2 }} numberOfLines={1}>
            {subtitle}
          </MonoText>
        ) : null}
      </View>
    </Brutal>
  );
});

const styles = StyleSheet.create({
  shelf: { marginTop: 22 },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    marginHorizontal: 18,
    marginBottom: 10,
    paddingBottom: 8,
    borderBottomWidth: 1.5,
    borderBottomColor: colors.ink,
  },
  headerTitle: {
    color: colors.ink,
    fontFamily: fonts.display,
    fontSize: 16.5,
    letterSpacing: 0.2,
    textTransform: 'uppercase',
  },
  scroller: { paddingHorizontal: 18, gap: 13, paddingBottom: 8 },
  cardInner: { alignItems: 'flex-start', minWidth: 0 },
  coverWrap: {
    borderWidth: 1.5,
    borderColor: colors.ink,
    ...hardShadow(4),
    backgroundColor: colors.paper2,
  },
  artistRing: {
    borderWidth: 2,
    borderColor: colors.ink,
    overflow: 'hidden',
    backgroundColor: colors.paper2,
    ...hardShadow(4, colors.ink),
  },
  artistName: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.2,
  },
  fab: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 36,
    height: 36,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 12.5,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  tile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    padding: 10,
    backgroundColor: colors.paper,
    borderWidth: 1.5,
    borderColor: colors.ink,
    minHeight: 64,
  },
  tileArt: {
    width: 44,
    height: 44,
    borderWidth: 1.5,
    borderColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileText: { flex: 1, minWidth: 0 },
  tileTitle: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 13,
    textTransform: 'uppercase',
    letterSpacing: 0.2,
  },
});
