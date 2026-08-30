/**
 * Player — authentic Spotify Android now-playing screen:
 *   artwork-colored gradient background (the app repaints per song —
 *   exactly like Spotify's extracted-color player) · large rounded
 *   artwork card · title/artist with green library-check · draggable
 *   thin progress bar · shuffle/prev/white-circle-play/next/repeat ·
 *   devices + share + queue row · tinted lyrics card · Spotify queue
 *   sheet (Now playing / Next up) with Smart Shuffle + Autoplay chips.
 *
 * Performance: static gradient views, one PanResponder, no blur, no
 * loops — the screen stays 60fps-light on low-end devices.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useProgress } from 'react-native-track-player';
import { getRadio } from '../ai/engine';
import { usePlayer } from '../player/PlayerProvider';
import { Artwork } from '../components/Artwork';
import { EqualizerBars } from '../components/TrackRow';
import { PressableScale } from '../components/PressableScale';
import { TrackMenu } from '../components/TrackMenu';
import { useToast } from '../components/Toast';
import { colors, fonts, radius } from '../theme';
import { useDynamicPalette } from '../theme/DynamicThemeProvider';
import { boostForPlayer } from '../theme/dynamic';
import { playerArtSize } from '../ui/windowing';
import type { RootStackParamList } from './navigation';

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/* ── Spotify progress bar: 4px, white fill, full drag-seek ─────────── */

function ProgressBar({
  duration,
  position,
  scrubbing,
  scrubValue,
  onScrubStart,
  onScrubMove,
  onScrubEnd,
}: {
  duration: number;
  position: number;
  scrubbing: boolean;
  scrubValue: number;
  onScrubStart: () => void;
  onScrubMove: (sec: number) => void;
  onScrubEnd: (sec: number) => void;
}) {
  const widthRef = useRef(1);
  const ratio = duration > 0 ? Math.min(1, (scrubbing ? scrubValue : position) / duration) : 0;

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
          onScrubStart();
          const w = widthRef.current || 1;
          onScrubMove(Math.max(0, Math.min(1, e.nativeEvent.locationX / w)) * duration);
        },
        onPanResponderMove: (e) => {
          const w = widthRef.current || 1;
          onScrubMove(Math.max(0, Math.min(1, e.nativeEvent.locationX / w)) * duration);
        },
        onPanResponderRelease: (e) => {
          const w = widthRef.current || 1;
          onScrubEnd(Math.max(0, Math.min(1, e.nativeEvent.locationX / w)) * duration);
        },
        onPanResponderTerminate: () => onScrubEnd(scrubValue),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [duration],
  );

  return (
    <View
      style={styles.barHit}
      onLayout={(e) => {
        widthRef.current = e.nativeEvent.layout.width;
      }}
      {...pan.panHandlers}
    >
      <View style={styles.barTrack}>
        <View style={[styles.barFill, { width: `${ratio * 100}%` }]} />
        {scrubbing ? <View style={[styles.barKnob, { left: `${ratio * 100}%` }]} /> : null}
      </View>
    </View>
  );
}

export function PlayerScreen() {
  // window-reactive artwork (W2 + R5): tablets / split-screen / pop-up /
  // DeX / landscape windows re-measure instead of freezing the phone-width
  // module constant. R5: also cap by window HEIGHT so a wide landscape
  // window can't produce an oversized square (see src/ui/windowing.ts).
  const { width: winWidth, height: winHeight } = useWindowDimensions();
  const artSize = playerArtSize(winWidth, winHeight);
  const insets = useSafeAreaInsets();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const toast = useToast();
  const palette = useDynamicPalette();
  const {
    active,
    isPlaying,
    loading,
    queue,
    shuffle,
    smartShuffle,
    autoplay,
    repeat,
    favorites,
    playQueue,
    togglePlay,
    next,
    prev,
    seek,
    setShuffle,
    setSmartShuffle,
    setAutoplay,
    cycleRepeat,
    toggleLike,
    removeFromQueue,
    refreshQueue,
  } = usePlayer();

  const { position, duration: liveDuration } = useProgress(250);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubValue, setScrubValue] = useState(0);
  const duration = liveDuration > 0 ? liveDuration : active?.duration ?? 0;

  const [showQueue, setShowQueue] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [radioLoading, setRadioLoading] = useState(false);

  const isFav = active ? favorites.has(active.id) : false;
  const trackKey = active?.id ?? 'none';

  useEffect(() => {
    void refreshQueue();
  }, [refreshQueue]);

  const startRadio = async () => {
    if (!active || radioLoading) return;
    setRadioLoading(true);
    toast.show({ message: 'Building your radio…', icon: 'radio-outline' });
    try {
      const radio = await getRadio(active, 12);
      if (radio.length) {
        await playQueue([active, ...radio], 0);
        toast.show({ message: `Radio started · ${radio.length + 1} songs`, icon: 'radio' });
      } else {
        toast.show({
          message: 'Not enough songs for a radio — try another track',
          icon: 'alert-circle-outline',
        });
      }
    } finally {
      setRadioLoading(false);
    }
  };

  const onShare = async () => {
    if (!active) return;
    try {
      await Share.share({
        message: `🎶 ${active.title} — ${active.artist}\nPlaying on TSF Music`,
      });
    } catch {
      /* user cancelled */
    }
  };

  const upNext = queue.filter((t) => t.id !== active?.id);

  return (
    <View style={styles.root}>
      {/* Spotify's signature: a gradient built from the artwork's own color */}
      <LinearGradient
        colors={[boostForPlayer(palette.dominant), palette.wash, '#121212']}
        locations={[0, 0.42, 0.85]}
        style={StyleSheet.absoluteFill}
      />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 16 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* ── top bar: collapse + more ─────────────────────────────── */}
        <View style={styles.topRow}>
          <Pressable hitSlop={12} onPress={() => nav.goBack()} testID="player-dismiss">
            <Ionicons name="chevron-down" size={30} color={colors.text} />
          </Pressable>
          <Pressable hitSlop={12} onPress={() => setShowMore(true)}>
            <Ionicons name="ellipsis-horizontal" size={26} color={colors.text} />
          </Pressable>
        </View>

        {/* ── artwork card ─────────────────────────────────────────── */}
        <View style={styles.artWrap}>
          <Artwork
            uri={active?.artwork}
            seed={trackKey}
            size={artSize}
            variant="card"
            style={styles.artCard}
          />
        </View>

        {/* ── title + library check ───────────────────────────────── */}
        <View style={styles.titleSection}>
          <View style={{ flex: 1, gap: 4, paddingRight: 12 }}>
            <Text style={styles.title} numberOfLines={2}>
              {active?.title ?? 'Nothing playing'}
            </Text>
            <Text style={styles.artist} numberOfLines={1}>
              {active?.artist ?? '—'}
            </Text>
          </View>
          <PressableScale hitSlop={8} haptic onPress={() => active && toggleLike(active)}>
            {isFav ? (
              <View style={styles.libCheck}>
                <Ionicons name="checkmark" size={17} color={colors.black} />
              </View>
            ) : (
              <View style={styles.libPlus}>
                <Ionicons name="add" size={18} color={colors.white} />
              </View>
            )}
          </PressableScale>
        </View>

        {/* ── progress ────────────────────────────────────────────── */}
        <View style={styles.progressSection}>
          <ProgressBar
            duration={Math.max(1, duration)}
            position={position}
            scrubbing={scrubbing}
            scrubValue={scrubValue}
            onScrubStart={() => {
              setScrubbing(true);
              setScrubValue(position);
            }}
            onScrubMove={(sec) => setScrubValue(sec)}
            onScrubEnd={(sec) => {
              setScrubbing(false);
              void seek(sec);
            }}
          />
          <View style={styles.times}>
            <Text style={styles.time}>{fmt(scrubbing ? scrubValue : position)}</Text>
            <Text style={styles.time}>-{fmt(Math.max(0, duration - (scrubbing ? scrubValue : position)))}</Text>
          </View>
        </View>

        {/* ── controls: shuffle · prev · play · next · repeat ─────── */}
        <View style={styles.controls}>
          <PressableScale hitSlop={8} onPress={() => setShuffle(!shuffle)}>
            <Ionicons
              name="shuffle"
              size={26}
              color={shuffle ? colors.accentBright : colors.text}
            />
          </PressableScale>
          <PressableScale hitSlop={8} onPress={prev}>
            <Ionicons name="play-skip-back" size={34} color={colors.text} />
          </PressableScale>
          <PressableScale
            scaleTo={0.92}
            haptic
            onPress={togglePlay}
            style={styles.playBtn}
          >
            {loading ? (
              <View style={styles.spinner} />
            ) : (
              <Ionicons
                name={isPlaying ? 'pause' : 'play'}
                size={62}
                color={colors.text}
                style={{ marginLeft: isPlaying ? 0 : 4 }}
              />
            )}
          </PressableScale>
          <PressableScale hitSlop={8} onPress={next}>
            <Ionicons name="play-skip-forward" size={34} color={colors.text} />
          </PressableScale>
          <PressableScale hitSlop={8} onPress={cycleRepeat}>
            <View>
              <Ionicons
                name="repeat"
                size={26}
                color={repeat !== 'off' ? colors.accentBright : colors.text}
              />
              {repeat === 'track' ? <View style={styles.repeatOne} /> : null}
            </View>
          </PressableScale>
        </View>

        {/* ── devices · share · queue ─────────────────────────────── */}
        <View style={styles.subRow}>
          <PressableScale hitSlop={8} onPress={() => toast.show({ message: 'Playing on this phone', icon: 'phone-portrait-outline' })}>
            <Ionicons name="tv-outline" size={20} color={colors.accentBright} />
          </PressableScale>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 22 }}>
            <PressableScale hitSlop={8} onPress={onShare}>
              <Ionicons name="share-outline" size={21} color={colors.text} />
            </PressableScale>
            <PressableScale hitSlop={8} onPress={() => setShowQueue(true)} testID="player-queue-btn">
              <Ionicons name="list" size={22} color={colors.text} />
            </PressableScale>
          </View>
        </View>

        {/* ── lyrics card, tinted by the song's color ─────────────── */}
        <View style={[styles.lyricsCard, { backgroundColor: boostForPlayer(palette.vibrant) }]}>
          <Text style={styles.lyricsTitle}>Lyrics</Text>
          <Text style={styles.lyricsSub} numberOfLines={1}>
            {active ? `${active.title} — ${active.artist}` : 'Nothing playing'}
          </Text>
        </View>
      </ScrollView>

      {/* ── queue sheet (Spotify: Now playing / Next up) ──────────── */}
      <Modal visible={showQueue} transparent animationType="slide" onRequestClose={() => setShowQueue(false)}>
        <Pressable style={styles.queueBackdrop} onPress={() => setShowQueue(false)}>
          <Pressable style={styles.queueSheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.queueGrabber} />
            <View style={styles.queueHeaderRow}>
              <Text style={styles.queueHeader}>Now playing</Text>
              <Pressable hitSlop={10} onPress={() => setShowQueue(false)}>
                <Ionicons name="close" size={24} color={colors.text} />
              </Pressable>
            </View>

            {active ? (
              <View style={styles.queueCurrentRow}>
                <Artwork uri={active.artwork} seed={active.id} size={44} variant="mini" />
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={styles.queueActiveTitle} numberOfLines={1}>
                      {active.title}
                    </Text>
                    <EqualizerBars playing={isPlaying} size={12} />
                  </View>
                  <Text style={styles.queueSub} numberOfLines={1}>
                    {active.artist}
                  </Text>
                </View>
              </View>
            ) : null}

            {/* Smart Shuffle + Autoplay — Spotify queue toggle chips */}
            <View style={styles.queueToggles}>
              <QueueChip
                label="Smart Shuffle"
                icon="sparkles"
                active={smartShuffle}
                onPress={() => setSmartShuffle(!smartShuffle)}
              />
              <QueueChip
                label="Autoplay"
                icon="infinite"
                active={autoplay}
                onPress={() => setAutoplay(!autoplay)}
              />
            </View>

            <Text style={styles.queueNextHeader}>Next up</Text>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 20 }}>
              {upNext.length === 0 ? (
                <Text style={styles.queueEmpty}>
                  Nothing queued — songs you add will appear here
                </Text>
              ) : (
                upNext.map((t) => (
                  <View key={t.id} style={styles.queueRow}>
                    <Artwork uri={t.artwork} seed={t.id} size={44} variant="mini" />
                    <View style={{ flex: 1, gap: 2, paddingRight: 8 }}>
                      <Text style={styles.queueTitle} numberOfLines={1}>
                        {t.isRecommended ? '✦ ' : ''}
                        {t.title}
                      </Text>
                      <Text style={styles.queueSub} numberOfLines={1}>
                        {t.artist}
                      </Text>
                    </View>
                    <Pressable hitSlop={10} onPress={() => removeFromQueue(t.id)}>
                      <Ionicons name="close" size={20} color={colors.textDim} />
                    </Pressable>
                  </View>
                ))
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* more menu (download / radio / playlist actions) */}
      <TrackMenu
        track={active}
        visible={showMore}
        onClose={() => setShowMore(false)}
        extraActions={
          active
            ? [
                {
                  icon: radioLoading ? 'sync' : 'radio-outline',
                  label: radioLoading ? 'Building radio…' : 'Go to song radio',
                  onPress: () => {
                    setShowMore(false);
                    void startRadio();
                  },
                },
                {
                  icon: 'share-outline',
                  label: 'Share',
                  onPress: () => {
                    setShowMore(false);
                    void onShare();
                  },
                },
              ]
            : undefined
        }
      />
    </View>
  );
}

function QueueChip({
  label,
  icon,
  active,
  onPress,
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <PressableScale
      onPress={onPress}
      haptic
      style={[styles.qChip, active && styles.qChipActive]}
    >
      <Ionicons
        name={icon}
        size={15}
        color={active ? colors.accentDeep : colors.accentBright}
      />
      <Text style={[styles.qChipText, active && styles.qChipTextActive]}>{label}</Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingHorizontal: 16 },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  artWrap: { alignItems: 'center', marginBottom: 20 },
  artCard: {
    borderRadius: 8,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 12,
  },
  titleSection: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 14,
    minHeight: 64,
  },
  title: {
    color: colors.text,
    fontSize: 23,
    fontWeight: '700',
    fontFamily: fonts.bold,
    lineHeight: 28,
    letterSpacing: -0.3,
  },
  artist: {
    color: colors.textDim,
    fontSize: 17,
    fontFamily: fonts.regular,
    lineHeight: 22,
  },
  libCheck: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.accentBright,
    alignItems: 'center',
    justifyContent: 'center',
  },
  libPlus: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1.5,
    borderColor: colors.textFaint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressSection: { marginBottom: 12 },
  barHit: { paddingVertical: 8 },
  barTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.3)',
    overflow: 'visible',
  },
  barFill: { height: 4, borderRadius: 2, backgroundColor: colors.text },
  barKnob: {
    position: 'absolute',
    top: -4,
    marginLeft: -7,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.text, // Spotify: white thumb
  },
  times: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 },
  time: { color: colors.textDim, fontSize: 11.5, fontFamily: fonts.medium },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    marginBottom: 18,
  },
  playBtn: {
    width: 68,
    height: 68,
    alignItems: 'center',
    justifyContent: 'center',
  },
  spinner: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.3)',
    borderTopColor: colors.text,
  },
  repeatOne: {
    position: 'absolute',
    bottom: -2,
    right: -4,
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.accentBright,
  },
  subRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    marginBottom: 20,
  },
  lyricsCard: {
    borderRadius: radius.lg,
    padding: 16,
    gap: 6,
    opacity: 0.95,
  },
  lyricsTitle: {
    color: colors.white,
    fontSize: 20,
    fontWeight: '700',
    fontFamily: fonts.bold,
    letterSpacing: -0.3,
  },
  lyricsSub: { color: 'rgba(255,255,255,0.85)', fontSize: 13, fontFamily: fonts.medium },

  /* queue sheet */
  queueBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  queueSheet: {
    height: '72%',
    backgroundColor: colors.elevated, // Spotify sheet surface #282828
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 8,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  queueGrabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.3)',
    marginBottom: 10,
  },
  queueHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  queueHeader: { color: colors.text, fontSize: 17, fontWeight: '700', fontFamily: fonts.bold },
  queueCurrentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
  },
  queueActiveTitle: {
    color: colors.accentBright,
    fontSize: 15,
    fontWeight: '500',
    fontFamily: fonts.medium,
    flexShrink: 1,
  },
  queueToggles: {
    flexDirection: 'row',
    gap: 8,
    marginVertical: 10,
  },
  qChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  qChipActive: { backgroundColor: colors.accentBright, borderColor: colors.accentBright },
  qChipText: { color: colors.text, fontSize: 12.5, fontWeight: '600', fontFamily: fonts.semibold },
  qChipTextActive: { color: colors.accentDeep },
  queueNextHeader: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
    fontFamily: fonts.bold,
    marginBottom: 6,
  },
  queueRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  queueTitle: { color: colors.text, fontSize: 15, fontFamily: fonts.medium, flexShrink: 1 },
  queueSub: { color: colors.textDim, fontSize: 13, fontFamily: fonts.regular },
  queueEmpty: {
    color: colors.textDim,
    fontSize: 14,
    fontFamily: fonts.regular,
    paddingVertical: 24,
    textAlign: 'center',
  },
});
