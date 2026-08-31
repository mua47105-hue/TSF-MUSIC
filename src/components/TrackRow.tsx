/**
 * TrackRow — the workhorse row, tuned to Spotify specs:
 * 52px rounded art (4px), 16/500 title, 13/400 dim subtitle, explicit
 * "E" box, animated green equalizer on the active track, sparkle badge
 * for Smart Shuffle picks, optional heart toggle / index / custom right
 * slot / long-press. Spotify lists show no hearts by default.
 *
 * React.memo (R8-P1): parent re-renders (feed appends, chip flips) can no
 * longer re-render every mounted row — only rows whose props actually
 * changed re-render. onPress IS compared (call sites build closures over
 * list indexes; a memo that ignored it would go stale on reorder).
 */

import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Track } from '../types';
import { colors, fonts, spacing } from '../theme';
import { Artwork } from './Artwork';
import { usePlayer } from '../player/PlayerProvider';
import { isDownloaded } from '../storage/downloads';

/** Three looping bars — the "this is playing" heartbeat. */
export function EqualizerBars({ playing, size = 14 }: { playing: boolean; size?: number }) {
  const bars = useRef([new Animated.Value(0.3), new Animated.Value(0.65), new Animated.Value(0.45)]).current;

  useEffect(() => {
    if (!playing) {
      bars.forEach((b) => b.stopAnimation());
      return;
    }
    const loops = bars.map((b, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(b, { toValue: 1, duration: 320 + i * 110, useNativeDriver: true }),
          Animated.timing(b, { toValue: 0.25, duration: 290 + i * 90, useNativeDriver: true }),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [playing, bars]);

  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: size, gap: 2 }}>
      {bars.map((b, i) => (
        <Animated.View
          key={i}
          style={{
            width: Math.max(2, size / 5),
            height: '100%',
            borderRadius: 1,
            backgroundColor: colors.accentBright,
            transform: [{ scaleY: b }],
          }}
        />
      ))}
    </View>
  );
}

function ExplicitBadge() {
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText}>E</Text>
    </View>
  );
}

export const TrackRow = React.memo(function TrackRow({
  track,
  index,
  onPress,
  onLongPress,
  style,
  showArtwork = true,
  showHeart = false,
  right,
  subtitle,
}: {
  track: Track;
  index?: number;
  onPress?: () => void;
  onLongPress?: () => void;
  style?: StyleProp<ViewStyle>;
  showArtwork?: boolean;
  showHeart?: boolean;
  right?: React.ReactNode;
  subtitle?: string;
}) {
  const { active, isPlaying, favorites, toggleLike } = usePlayer();
  const [downloaded, setDownloaded] = React.useState(!!track.localUri);
  const isActive = active?.id === track.id;
  const isFav = favorites.has(track.id);

  useEffect(() => {
    let cancelled = false;
    isDownloaded(track.id).then((ok) => {
      if (!cancelled) setDownloaded(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [track.id]);

  const sub =
    subtitle ??
    [track.artist, track.album].filter(Boolean).join(' • ');

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      testID="track-row"
      delayLongPress={280}
      android_ripple={{ color: colors.elevated }}
      style={({ pressed }) => [styles.row, style, pressed && { opacity: 0.75 }]}
    >
      {index != null && !showArtwork ? (
        <Text style={[styles.index, isActive && { color: colors.accentBright }]}>{index + 1}</Text>
      ) : showArtwork ? (
        <View>
          <Artwork uri={track.artwork} seed={track.id} size={52} />
          {isActive ? (
            <View style={styles.eqOverlay}>
              <EqualizerBars playing={isPlaying} size={16} />
            </View>
          ) : null}
        </View>
      ) : null}

      <View style={styles.meta}>
        <View style={styles.titleRow}>
          {track.explicit ? <ExplicitBadge /> : null}
          {track.isRecommended ? (
            <Ionicons name="sparkles" size={13} color={colors.aiEnd} style={{ marginRight: 2 }} />
          ) : null}
          <Text style={[styles.title, isActive && { color: colors.accentBright }]} numberOfLines={1}>
            {track.title}
          </Text>
        </View>
        <View style={styles.subRow}>
          {downloaded ? (
            <Ionicons name="arrow-down-circle" size={13} color={colors.accentBright} style={{ marginRight: 3 }} />
          ) : null}
          {track.previewOnly ? (
            <Text style={styles.previewTag}>PREVIEW</Text>
          ) : null}
          <Text style={styles.subtitle} numberOfLines={1}>
            {sub}
          </Text>
        </View>
        {/* MINDBEAT truthful explanation (§8.5) — every recommended
            track carries an honest reason line, never social proof. */}
        {track.isRecommended && track.reason ? (
          <View style={styles.reasonRow}>
            <Ionicons name="sparkles" size={11} color={colors.aiEnd} />
            <Text style={styles.reasonText} numberOfLines={1}>
              {track.reason}
            </Text>
          </View>
        ) : null}
      </View>

      {right ??
        (showHeart ? (
          <Pressable hitSlop={12} onPress={() => toggleLike(track)} style={styles.likeBtn}>
            <Ionicons
              name={isFav ? 'heart' : 'heart-outline'}
              size={21}
              color={isFav ? colors.accentBright : colors.textFaint}
            />
          </Pressable>
        ) : null)}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: 9,
    gap: spacing.md,
    minHeight: 70,
  },
  index: {
    width: 26,
    color: colors.textDim,
    fontSize: 16,
    textAlign: 'center',
    fontFamily: fonts.medium,
  },
  meta: { flex: 1, gap: 3 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '500',
    fontFamily: fonts.medium,
    flexShrink: 1,
  },
  subRow: { flexDirection: 'row', alignItems: 'center' },
  subtitle: {
    color: colors.textDim,
    fontSize: 13,
    fontFamily: fonts.regular,
    flexShrink: 1,
  },
  reasonRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 1 },
  reasonText: {
    color: colors.aiEnd,
    fontSize: 11.5,
    fontFamily: fonts.medium,
    flexShrink: 1,
  },
  previewTag: {
    color: colors.textFaint,
    fontSize: 9,
    fontWeight: '700',
    fontFamily: fonts.bold,
    letterSpacing: 0.5,
    marginRight: 5,
  },
  badge: {
    width: 15,
    height: 15,
    borderRadius: 3,
    backgroundColor: colors.textFaint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: colors.bg,
    fontSize: 10,
    fontWeight: '700',
    fontFamily: fonts.bold,
  },
  likeBtn: { padding: 8 },
  eqOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
  },
});
