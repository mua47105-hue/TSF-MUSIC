/**
 * MiniPlayer — PULSE ink bar (the prototype's #mini):
 * black strip with a hard orange shadow floating above the tab bar,
 * bordered artwork that swaps to acid EQ bars while playing, uppercase
 * title + mono artist, heart / play / next in paper, 3px acid progress
 * line along the bottom edge. Tapping opens the broadsheet player.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useProgress } from 'react-native-track-player';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { colors, fonts } from '../theme';
import { Artwork } from './Artwork';
import { usePlayer } from '../player/PlayerProvider';
import type { RootStackParamList } from '../screens/navigation';
import { EqualizerBars } from './TrackRow';
import { MonoText } from './Brutal';
import { orangeShadow } from '../theme';

export function MiniPlayer() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { active, isPlaying, loading, togglePlay, next, favorites, toggleLike } = usePlayer();
  const { position, duration } = useProgress(500);
  if (!active) return null;
  const pct = duration > 0 ? Math.min(1, position / duration) : 0;
  const isFav = favorites.has(active.id);

  return (
    <View style={[styles.card, orangeShadow(4)]}>
      <Pressable
        style={({ pressed }) => [styles.row, pressed && { backgroundColor: 'rgba(244,241,234,0.06)' }]}
        onPress={() => nav.navigate('Player')}
        testID="mini-player"
      >
        <View>
          <Artwork uri={active.artwork} seed={active.id} size={38} bordered={false} style={styles.miniArt} />
          {isPlaying ? (
            <View style={styles.eqOverlay}>
              <EqualizerBars playing size={12} />
            </View>
          ) : null}
        </View>
        <View style={styles.meta}>
          <Text style={styles.title} numberOfLines={1}>
            {active.title}
          </Text>
          <MonoText size={9.5} color={colors.onInk60} style={{ marginTop: 1 }} numberOfLines={1}>
            {active.artist}
          </MonoText>
        </View>

        <Pressable
          hitSlop={10}
          style={styles.btn}
          onPress={() => toggleLike(active)}
          accessibilityLabel="Like"
          testID="mini-like"
        >
          <Ionicons
            name={isFav ? 'heart' : 'heart-outline'}
            size={19}
            color={isFav ? colors.orange : colors.onInk}
          />
        </Pressable>
        <Pressable hitSlop={10} style={styles.btn} onPress={togglePlay} accessibilityLabel="Play" testID="mini-toggle">
          {loading ? (
            <View style={styles.spinner} />
          ) : (
            <Ionicons name={isPlaying ? 'pause' : 'play'} size={21} color={colors.onInk} />
          )}
        </Pressable>
        <Pressable hitSlop={10} style={styles.btn} onPress={() => next()} accessibilityLabel="Next" testID="mini-next">
          <Ionicons name="play-skip-forward" size={18} color={colors.onInk} />
        </Pressable>
      </Pressable>
      {/* acid progress line hugging the bar's bottom edge */}
      <View style={styles.progressTrack} pointerEvents="none">
        <View style={[styles.progressFill, { width: `${pct * 100}%` }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 12,
    backgroundColor: colors.ink,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 9,
    paddingHorizontal: 12,
    gap: 11,
  },
  eqOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(22,21,19,0.55)',
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
    paddingBottom: 6,
    paddingRight: 6,
  },
  miniArt: { borderColor: 'rgba(244,241,234,0.4)', borderWidth: 1.5, backgroundColor: colors.paper2 },
  meta: { flex: 1, minWidth: 0 },
  title: {
    color: colors.onInk,
    fontSize: 12.5,
    fontFamily: fonts.bold,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  btn: { padding: 7, alignItems: 'center', justifyContent: 'center' },
  spinner: {
    width: 16,
    height: 16,
    borderWidth: 2,
    borderColor: 'rgba(244,241,234,0.3)',
    borderTopColor: colors.acid,
  },
  progressTrack: {
    height: 4,
    backgroundColor: 'rgba(244,241,234,0.18)',
    width: '100%',
  },
  progressFill: { height: 4, backgroundColor: colors.acid },
});
