/**
 * TrackRow — PULSE index-list row (the prototype's .trow):
 * mono index number OR 44px bordered art that swaps to an acid EQ on
 * ink block while playing, uppercase Archivo title (orange when
 * active), mono meta, acid reason chip, source badge, heart slot.
 * Long rows separated by 1px soft rules.
 *
 * React.memo (R8-P1): feed appends can no longer re-render every
 * mounted row — only rows whose props actually changed re-render.
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
import { colors, fonts } from '../theme';
import { Artwork } from './Artwork';
import { usePlayer } from '../player/PlayerProvider';
import { isDownloaded } from '../storage/downloads';
import { SourceBadge } from './Brutal';

/** Three looping acid bars on an ink block — the playing heartbeat. */
export function EqualizerBars({ playing, size = 14, color = colors.acid }: { playing: boolean; size?: number; color?: string }) {
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
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: size, gap: 2.5 }}>
      {bars.map((b, i) => (
        <Animated.View
          key={i}
          style={{
            width: Math.max(2.5, size / 5.5),
            height: '100%',
            backgroundColor: color,
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
  reasonLabel,
  showSource = false,
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
  /** acid reason chip (truthful MINDBEAT lines) */
  reasonLabel?: string;
  /** YT / PREVIEW / SAVED source chip (saavn rows stay clean — P-B) */
  showSource?: boolean;
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
    [track.artist, track.album].filter(Boolean).join(' \u00b7 ');

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      testID="track-row"
      delayLongPress={280}
      android_ripple={{ color: 'rgba(22,21,19,0.06)' }}
      style={({ pressed }) => [styles.row, style, pressed && { backgroundColor: colors.paper2 }]}
    >
      {index != null && !showArtwork ? (
        <Text style={[styles.index, isActive && { color: colors.orange }]}>
          {String(index + 1).padStart(2, '0')}
        </Text>
      ) : showArtwork ? (
        isActive ? (
          <View style={styles.eqBlock}>
            <EqualizerBars playing={isPlaying} size={18} />
          </View>
        ) : (
          <Artwork uri={track.artwork} seed={track.id} size={44} />
        )
      ) : null}

      <View style={styles.meta}>
        <View style={styles.titleRow}>
          {track.explicit ? <ExplicitBadge /> : null}
          <Text style={[styles.title, isActive && { color: colors.orange }]} numberOfLines={1}>
            {track.title}
          </Text>
        </View>
        {reasonLabel ? (
          <View style={styles.reasonChip}>
            <Text style={styles.reasonText} numberOfLines={1}>
              {reasonLabel}
            </Text>
          </View>
        ) : null}
        <View style={styles.subRow}>
          {downloaded ? (
            <Ionicons name="arrow-down" size={11} color={colors.orange} style={{ marginRight: 4 }} />
          ) : null}
          {track.previewOnly ? (
            <Text style={styles.previewTag}>PREVIEW</Text>
          ) : null}
          <Text style={styles.subtitle} numberOfLines={1}>
            {sub}
          </Text>
        </View>
        {/* MINDBEAT truthful explanation — every recommended track
            carries an honest reason line, never social proof. */}
        {!reasonLabel && track.isRecommended && track.reason ? (
          <View style={styles.reasonChip}>
            <Text style={styles.reasonText} numberOfLines={1}>
              {track.reason}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={styles.side}>
        {showSource ? <SourceBadge source={track.source} /> : null}
        {right ??
          (showHeart ? (
            <Pressable hitSlop={12} onPress={() => toggleLike(track)} style={styles.likeBtn}>
              <Ionicons
                name={isFav ? 'heart' : 'heart-outline'}
                size={19}
                color={isFav ? colors.orange : colors.ink40}
              />
            </Pressable>
          ) : null)}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 11,
    gap: 12,
    minHeight: 66,
    borderBottomWidth: 1,
    borderBottomColor: colors.ink16,
    backgroundColor: colors.paper,
  },
  index: {
    width: 24,
    color: colors.ink40,
    fontSize: 10,
    textAlign: 'left',
    fontFamily: fonts.monoBold,
  },
  eqBlock: {
    width: 44,
    height: 44,
    backgroundColor: colors.ink,
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
    paddingBottom: 11,
    paddingRight: 11,
  },
  meta: { flex: 1, minWidth: 0 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: {
    color: colors.ink,
    fontSize: 13.5,
    fontFamily: fonts.bold,
    letterSpacing: 0.2,
    textTransform: 'uppercase',
    flexShrink: 1,
  },
  reasonChip: {
    alignSelf: 'flex-start',
    backgroundColor: colors.acid,
    paddingHorizontal: 6,
    paddingVertical: 1,
    marginTop: 3,
  },
  reasonText: {
    color: colors.ink,
    fontSize: 8.5,
    fontFamily: fonts.monoBold,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    flexShrink: 1,
  },
  subRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  subtitle: {
    color: colors.ink40,
    fontSize: 10,
    fontFamily: fonts.mono,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    flexShrink: 1,
  },
  previewTag: {
    color: colors.ink40,
    fontSize: 8.5,
    fontFamily: fonts.monoBold,
    letterSpacing: 1,
    marginRight: 5,
    borderWidth: 1,
    borderColor: colors.ink40,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  badge: {
    width: 14,
    height: 14,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: colors.paper,
    fontSize: 9,
    fontFamily: fonts.monoBold,
  },
  side: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  likeBtn: { padding: 6 },
});
