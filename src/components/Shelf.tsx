/**
 * Shelf — authentic Spotify home primitives:
 *   • Shelf       — section: 22px bold header, "Show all" link, horizontal rail
 *   • ShelfCard   — square cover (8px radius) + semibold title + dim subtitle
 *   • QuickTile   — the #2A2A2A home shortcut tile (art + 2-line bold label)
 */

import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fonts, radius, spacing } from '../theme';
import { Artwork } from './Artwork';
import { PressableScale } from './PressableScale';

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
  subtitleMaxLines = 2,
}: {
  title: string;
  subtitle?: string;
  artwork?: string;
  seed: string;
  onPress: () => void;
  onLongPress?: () => void;
  size?: number;
  /** artist round covers */
  round?: boolean;
  badge?: React.ReactNode;
  subtitleMaxLines?: number;
}) {
  return (
    <PressableScale
      onPress={onPress}
      onLongPress={onLongPress}
      testID="shelf-card"
      style={{ width: size, gap: 8 }}
      haptic
    >
      <View>
        <Artwork uri={artwork} seed={seed} size={size} variant={round ? 'circle' : 'card'} />
        {badge}
      </View>
      <View style={styles.textWrap}>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.cardSubtitle} numberOfLines={subtitleMaxLines}>
            {subtitle}
          </Text>
        ) : null}
      </View>
    </PressableScale>
  );
});

export function Shelf({
  title,
  actionLabel,
  onAction,
  children,
}: {
  title: string;
  actionLabel?: string;
  onAction?: () => void;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.shelf}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{title}</Text>
        {actionLabel && onAction ? (
          <Pressable onPress={onAction} hitSlop={8}>
            <Text style={styles.headerAction}>{actionLabel}</Text>
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

/**
 * QuickTile — Spotify home shortcut: #2A2A2A tile, rounded-square artwork
 * flush-left, bold white single-line label.
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
}: {
  title: string;
  subtitle?: string;
  artwork?: string;
  seed: string;
  onPress: () => void;
  width: number;
  /** gradient icon tile (e.g. AI) */
  icon?: keyof typeof Ionicons.glyphMap;
  liked?: boolean;
}) {
  return (
    <PressableScale
      onPress={onPress}
      scaleTo={0.97}
      haptic
      style={[styles.quickTile, { width }]}
    >
      {icon ? (
        <View style={styles.quickIconTile}>
          <Ionicons name={icon} size={26} color="#FFFFFF" />
        </View>
      ) : (
        <Artwork
          uri={artwork}
          seed={seed}
          size={56}
          variant="square"
          liked={liked}
          style={styles.quickArt}
        />
      )}
      <View style={styles.quickText}>
        <Text style={styles.quickTitle} numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.quickSubtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
    </PressableScale>
  );
});

const styles = StyleSheet.create({
  shelf: { gap: 12, marginBottom: 32 },
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
  },
  headerTitle: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '700',
    fontFamily: fonts.bold,
    letterSpacing: -0.3,
  },
  headerAction: {
    color: colors.textDim,
    fontSize: 13,
    fontWeight: '400',
    fontFamily: fonts.regular,
  },
  scroller: { paddingHorizontal: spacing.lg, gap: spacing.md },
  cardTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
    fontFamily: fonts.semibold,
    lineHeight: 18,
  },
  cardSubtitle: {
    color: colors.textDim,
    fontSize: 13,
    fontFamily: fonts.regular,
    marginTop: 2,
    lineHeight: 16,
  },
  textWrap: { gap: 2, paddingRight: 2 },
  quickTile: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.tile, // #2A2A2A pixel-verified
    borderRadius: 6,
    overflow: 'hidden',
    height: 56,
  },
  quickArt: {},
  quickIconTile: {
    width: 56,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.aiStart,
  },
  quickText: { flex: 1, paddingHorizontal: 10, paddingRight: 8 },
  quickTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
    fontFamily: fonts.bold,
    lineHeight: 16,
  },
  quickSubtitle: {
    color: colors.textDim,
    fontSize: 11,
    fontFamily: fonts.regular,
    marginTop: 1,
  },
});
