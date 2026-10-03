/**
 * Player — PULSE broadsheet now-playing (v4.0):
 *   paper canvas with the artwork as a 14% grayscale-style wash ·
 *   square chevron buttons + kicker · bordered artwork with the hard
 *   8px ink shadow and the rotated acid "TSF 320 KBPS" stamp · huge
 *   display title · striped ink-on-orange progress bar with drag-seek ·
 *   square controls (66px ink play + orange shadow) · lyrics card ·
 *   CAST/SHARE/SAVE foot · ink-ruled queue sheet with square-switch
 *   pills. One PanResponder, no blur, no loops — 60fps-light.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Image,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  Animated,
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
import { mindbeat } from '../ai/mindbeat';
import { fetchPlainLyrics, fetchSyncedLyrics } from '../api/lrclib';
import { parseLrc, type LrcLine } from '../player/singalong';
import { SingAlong } from '../components/SingAlong';
import { isDoubleTap } from '../player/miniModel';
import { usePlayer } from '../player/PlayerProvider';
import {
  armSleepTimer,
  cancelSleepTimer,
  getSleepTimerState,
  subscribeSleepTimer,
  type SleepTimerState,
} from '../player/sleepTimer';
import { dataSaverActive, subscribeDataSaver } from '../player/audioQuality';
import { Artwork } from '../components/Artwork';
import { EqualizerBars } from '../components/TrackRow';
import { Brutal, MonoText } from '../components/Brutal';
import { TrackMenu } from '../components/TrackMenu';
import { useToast } from '../components/Toast';
import { colors, fonts } from '../theme';
import { useDynamicPalette } from '../theme/DynamicThemeProvider';
import { withAlpha } from '../theme/dynamic';
import { playerArtSize } from '../ui/windowing';
import type { RootStackParamList } from './navigation';

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/* ── The striped progress bar: bordered track, ink stripes on acid ── */

const STRIPES = Array.from({ length: 90 }, (_, i) => i);

/** Vibe state machine → listener-facing words (Task 28). The machine's own
 *  vocabulary stays in src/ai; this is just the broadsheet translation. */
const VIBE_LABEL: Record<string, string> = {
  WARMUP: 'WARMING UP',
  FLOW: 'IN FLOW',
  PEAK: 'PEAK',
  WIND_DOWN: 'WINDING DOWN',
  SKIP_STORM: 'NOT FEELING IT',
  EXPLORING: 'EXPLORING',
};

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
        {/* the fill: acid with hard ink stripes (the prototype's hatch) */}
        <View style={[styles.barFillWrap, { width: `${ratio * 100}%` }]}>
          <View style={styles.barFillStripes}>
            {STRIPES.map((i) => (
              <View key={i} style={styles.stripe} />
            ))}
          </View>
        </View>
      </View>
    </View>
  );
}

export function PlayerScreen() {
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
    queueVibeShift,
    removeFromQueue,
    refreshQueue,
  } = usePlayer();

  const { position, duration: liveDuration } = useProgress(250);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubValue, setScrubValue] = useState(0);
  const duration = liveDuration > 0 ? liveDuration : active?.duration ?? 0;

  const [showQueue, setShowQueue] = useState(false);
  const [showSleep, setShowSleep] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [radioLoading, setRadioLoading] = useState(false);
  // sleep timer (Task 28): session-scoped, armed from the queue sheet
  const [sleep, setSleep] = useState<SleepTimerState>(getSleepTimerState());
  const [, forceSleepTick] = useState(0);
  useEffect(() => subscribeSleepTimer(setSleep), []);
  const sleepArmed = sleep.endAt != null && sleep.endAt > Date.now();
  useEffect(() => {
    if (!sleepArmed) return undefined;
    const t = setInterval(() => forceSleepTick((n) => n + 1), 5000); // minute-granular label
    return () => clearInterval(t);
  }, [sleepArmed]);
  const sleepLabel = sleepArmed
    ? `SLEEP · ${Math.max(1, Math.ceil((sleep.endAt! - Date.now()) / 60000))}M`
    : 'SLEEP';
  const [saver, setSaver] = useState(dataSaverActive());
  useEffect(() => subscribeDataSaver(setSaver), []);
  // VIBE readout (Task 28): the session brain's mood state machine, finally
  // visible in the player. Refreshes on track change + every 20s so a
  // SKIP_STORM shows up while the screen is open.
  const [vibe, setVibe] = useState(mindbeat.sessionReadout());
  const [shifting, setShifting] = useState(false);
  useEffect(() => {
    setVibe(mindbeat.sessionReadout());
    const t = setInterval(() => setVibe(mindbeat.sessionReadout()), 20000);
    return () => clearInterval(t);
  }, [active?.id]);
  const shiftVibe = async () => {
    if (!active || shifting) return;
    setShifting(true);
    try {
      const exclude = new Set<string>([active.id, ...upNext.map((t) => t.id)]);
      const picks = await mindbeat.vibeShift(active, exclude);
      if (!picks.length) {
        toast.show({ message: 'NOT ENOUGH SESSION YET — PLAY OR LIKE A FEW SONGS FIRST', icon: 'sparkles-outline' });
        return;
      }
      const n = await queueVibeShift(picks);
      if (n > 0) {
        const dir = vibe.energy < 0.5 ? 'ENERGY UP' : 'WINDING DOWN';
        toast.show({ message: `VIBE SHIFTED · ${n} SONGS · ${dir}`, icon: 'sparkles' });
      } else {
        toast.show({ message: 'COULD NOT QUEUE THE SHIFT', icon: 'alert-outline' });
      }
    } finally {
      setShifting(false);
    }
  };
  // real lyrics (LRCLIB, on-device catalog lookup) — the broadsheet
  // card prints the actual words, never a fabricated byline.
  // lyricMiss closes the loop (v4.0.6): a null resolution means the desk
  // genuinely found nothing — the panel must SAY so instead of claiming
  // to fetch forever (dead-end audit, Task 28).
  const [lyricExcerpt, setLyricExcerpt] = useState<string | null>(null);
  const [lyricMiss, setLyricMiss] = useState(false);
  const [lyricAttempt, setLyricAttempt] = useState(0);
  // SING-ALONG (Task 29): synced timeline from the same catalog row —
  // non-null (≥4 lines) upgrades the card to the karaoke view.
  const [syncedLines, setSyncedLines] = useState<LrcLine[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLyricExcerpt(null);
    setLyricMiss(false);
    setSyncedLines(null);
    if (!active) return undefined;
    const ctrl = new AbortController();
    // both shapes share ONE catalog call (in-flight dedupe in lrclib)
    fetchPlainLyrics(active.title, active.artist, ctrl.signal)
      .then((lyrics) => {
        if (cancelled) return;
        if (!lyrics) {
          setLyricMiss(true); // honest terminal state — never an eternal spinner
          return;
        }
        // strip LRC stamps first (critic: synced-only rows borrow the
        // stamped text — those brackets are not “no lyrics filed”)
        const lines = lyrics
          .split('\n')
          .map((l) => l.replace(/^(?:\s*\[[^\]]*\])+\s*/, '').trim())
          .filter((l) => l && !l.startsWith('['));
        if (lines.length) setLyricExcerpt(lines.slice(0, 3).join('\n'));
        else setLyricMiss(true); // stamp-only file = instrumental — honest miss
      })
      .catch(() => undefined);
    fetchSyncedLyrics(active.title, active.artist, ctrl.signal)
      .then((raw) => {
        if (cancelled || !raw) return;
        const parsed = parseLrc(raw);
        // a real timeline, not a fragment: <4 timed lines is not singable
        setSyncedLines(parsed.length >= 4 ? parsed : null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [active?.id, lyricAttempt]);

  const isFav = active ? favorites.has(active.id) : false;
  const trackKey = active?.id ?? 'none';

  // DOUBLE-TAP ARTWORK → LIKE (Task 29): the big square is a gesture
  // surface — two taps inside 320ms like the song with a heart burst
  // (Spotify/Resso-class delight). Timing rule locked in miniModel.
  const lastArtTap = useRef(0);
  const burstVal = useRef(new Animated.Value(0)).current;
  const [burstOn, setBurstOn] = useState(false);
  // snapshot (critic): the icon must not flip mid-animation when
  // toggleLike's state lands ~100ms into the 640ms burst
  const [burstFav, setBurstFav] = useState(false);
  const onArtworkPress = () => {
    const now = Date.now();
    if (isDoubleTap(now, lastArtTap.current)) {
      lastArtTap.current = 0;
      if (!active) return;
      void toggleLike(active);
      setBurstFav(isFav); // the state BEFORE the toggle
      setBurstOn(true);
      burstVal.setValue(0);
      Animated.timing(burstVal, { toValue: 1, duration: 640, useNativeDriver: true }).start(({ finished }) => {
        // critic: a finished:false callback (interrupted by a newer burst)
        // must never unmount the newer burst's view
        if (finished) setBurstOn(false);
      });
      return;
    }
    lastArtTap.current = now;
  };

  useEffect(() => {
    void refreshQueue();
  }, [refreshQueue]);

  const startRadio = async () => {
    if (!active || radioLoading) return;
    setRadioLoading(true);
    toast.show({ message: 'BUILDING YOUR RADIO…', icon: 'radio-outline' });
    try {
      const radio = await getRadio(active, 12);
      if (radio.length) {
        await playQueue([active, ...radio], 0);
        toast.show({ message: `RADIO STARTED · ${radio.length + 1} SONGS`, icon: 'radio' });
      } else {
        toast.show({
          message: 'NOT ENOUGH SONGS FOR A RADIO',
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
        message: `${active.title} — ${active.artist}\nPlaying on TSF Music`,
      });
    } catch {
      /* user cancelled */
    }
  };

  const upNext = queue.filter((t) => t.id !== active?.id);

  return (
    <View style={styles.root}>
      {/* the artwork wash — 14% under a paper gradient (the prototype's
          playerBg), carrying a whisper of the song's palette hue */}
      <Image
        source={{ uri: active?.artwork }}
        style={[styles.bgArt, { opacity: 0.14 }]}
        resizeMode="cover"
        blurRadius={0}
      />
      <LinearGradient
        colors={[colors.paper, withAlpha(palette.wash, 0.55), colors.paper]}
        locations={[0, 0.45, 1]}
        style={StyleSheet.absoluteFill}
      />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + 10, paddingBottom: insets.bottom + 16 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* ── top bar: collapse + kicker + queue ───────────────────── */}
        <View style={styles.topRow}>
          <Brutal haptic shadow={0} pressOffset={1} onPress={() => nav.goBack()} testID="player-dismiss" style={styles.chevBtn}>
            <Ionicons name="chevron-down" size={16} color={colors.ink} />
          </Brutal>
          <MonoText size={9} bold color={colors.ink60} style={{ letterSpacing: 2.2, flex: 1, textAlign: 'center' }} numberOfLines={1}>
            NOW PLAYING · <MonoText size={9} bold color={colors.orange}>TSF MUSIC</MonoText>
          </MonoText>
          <Brutal haptic shadow={0} pressOffset={1} onPress={() => setShowQueue(true)} testID="player-queue-btn" style={styles.chevBtn}>
            <Ionicons name="list" size={16} color={colors.ink} />
          </Brutal>
        </View>

        {/* ── artwork + the 320 kbps stamp ─────────────────────────── */}
        <View style={[styles.artWrap, { width: artSize, height: artSize }]}>
          <Pressable
            onPress={onArtworkPress}
            testID="player-artwork"
            style={styles.artCard}
            accessibilityRole="button"
            accessibilityLabel="Now playing artwork. Double-tap to like or unlike this song."
          >
            <Artwork
              uri={active?.artwork}
              seed={trackKey}
              size={artSize}
              bordered={false}
              style={styles.artCard}
            />
            {burstOn ? (
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.burstHeart,
                  {
                    opacity: burstVal.interpolate({ inputRange: [0, 0.25, 1], outputRange: [0, 1, 0] }),
                    transform: [
                      { scale: burstVal.interpolate({ inputRange: [0, 0.25, 1], outputRange: [0.5, 1.15, 1.6] }) },
                      { translateY: burstVal.interpolate({ inputRange: [0, 1], outputRange: [0, -46] }) },
                    ],
                  },
                ]}
              >
                <Ionicons name={burstFav ? 'heart-dislike' : 'heart'} size={74} color={colors.orange} />
              </Animated.View>
            ) : null}
          </Pressable>
          <View pointerEvents="none" style={styles.stamp}>
            <MonoText size={8} bold color={colors.ink} style={{ letterSpacing: 0.8, textAlign: 'center', lineHeight: 11 }}>
              {saver ? 'TSF\n96\nSAVER' : 'TSF\n320\nKBPS'}
            </MonoText>
          </View>
        </View>

        {/* ── title + like ─────────────────────────────────────────── */}
        <View style={styles.titleSection}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.title} numberOfLines={2} allowFontScaling={false}>
              {(active?.title ?? 'NOTHING PLAYING').toUpperCase()}
            </Text>
            <MonoText size={11} color={colors.ink60} style={{ marginTop: 8, letterSpacing: 0.8 }} numberOfLines={1}>
              {active ? `${active.artist.toUpperCase()} · ${(active.album ?? '').toUpperCase()}` : '—'}
            </MonoText>
          </View>
          <Brutal
            haptic
            shadow={0}
            pressOffset={1}
            onPress={() => active && toggleLike(active)}
            style={[styles.likeBtn, isFav && { backgroundColor: colors.orange }]}
          >
            <Ionicons name={isFav ? 'heart' : 'heart-outline'} size={17} color={colors.ink} />
          </Brutal>
        </View>

        {/* ── striped progress ─────────────────────────────────────── */}
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
            <MonoText size={10} color={colors.ink60}>
              {fmt(scrubbing ? scrubValue : position)}
            </MonoText>
            <MonoText size={10} color={colors.ink60}>
              -{fmt(Math.max(0, duration - (scrubbing ? scrubValue : position)))}
            </MonoText>
          </View>
        </View>

        {/* ── controls ─────────────────────────────────────────────── */}
        <View style={styles.controls}>
          <Brutal haptic shadow={0} pressOffset={1} onPress={() => setShuffle(!shuffle)} style={[styles.smlBtn, shuffle && styles.smlOn]}>
            <Ionicons name="shuffle" size={19} color={colors.ink} />
          </Brutal>
          <Brutal haptic shadow={0} pressOffset={1} onPress={() => prev()} style={styles.smlBtn} testID="player-prev">
            <Ionicons name="play-skip-back" size={22} color={colors.ink} />
          </Brutal>
          <Brutal haptic onInk shadow={4} onPress={togglePlay} style={styles.playBtn} testID="player-toggle">
            {loading ? (
              <View style={styles.spinner} />
            ) : (
              <Ionicons
                name={isPlaying ? 'pause' : 'play'}
                size={26}
                color={colors.acid}
                style={{ marginLeft: isPlaying ? 0 : 3 }}
              />
            )}
          </Brutal>
          <Brutal haptic shadow={0} pressOffset={1} onPress={() => next()} style={styles.smlBtn} testID="player-next">
            <Ionicons name="play-skip-forward" size={22} color={colors.ink} />
          </Brutal>
          <Brutal haptic shadow={0} pressOffset={1} onPress={cycleRepeat} style={[styles.smlBtn, repeat !== 'off' && styles.smlOn]}>
            <View>
              <Ionicons name="repeat" size={19} color={colors.ink} />
              {repeat === 'track' ? <View style={styles.repeatOne} /> : null}
            </View>
          </Brutal>
        </View>

        {/* ── vibe strip — the session brain, made visible (Task 28) ─ */}
        <View style={styles.vibeStrip}>
          <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, minWidth: 0 }}>
            <View style={[styles.vibeDot, vibe.listens > 0 && styles.vibeDotLive]} />
            <MonoText size={9} bold color={colors.ink} style={{ letterSpacing: 1.2 }} numberOfLines={1}>
              {`VIBE · ${VIBE_LABEL[vibe.vibe as keyof typeof VIBE_LABEL] ?? vibe.vibe} · E ${Math.round(vibe.energy * 100)}%`}
            </MonoText>
          </View>
          <Brutal haptic shadow={0} pressOffset={1} onPress={() => void shiftVibe()} style={styles.vibeBtn}>
            <MonoText size={9} bold color={colors.ink}>
              {shifting ? 'SHIFTING…' : 'SHIFT ▸'}
            </MonoText>
          </Brutal>
        </View>

        {/* ── lyrics card — the real words via LRCLIB ──────────────── */}
        <View
          style={styles.lyricsCard}
          {...(lyricMiss && !lyricExcerpt && !syncedLines
            ? { onStartShouldSetResponder: () => { setLyricAttempt((n) => n + 1); return false; } }
            : {})}
        >
          <MonoText size={8.5} bold color={colors.orange} style={{ letterSpacing: 2 }}>
            {syncedLines ? 'SING ALONG' : 'LYRICS · VIA LRCLIB'}
          </MonoText>
          {syncedLines ? (
            <SingAlong lines={syncedLines} positionMs={position * 1000} onSeek={(sec) => void seek(sec)} />
          ) : lyricExcerpt ? (
            <Text style={styles.lyricsLine} numberOfLines={3}>
              {lyricExcerpt}
            </Text>
          ) : (
            <Text style={[styles.lyricsLine, { color: colors.ink40 }]} numberOfLines={2}>
              {lyricMiss
                ? 'The desk checked the catalog — nothing filed for this one (instrumental, obscure, or not yet indexed). Tap to retry.'
                : active
                  ? `${active.title} — ${active.artist}`
                  : 'The words land here once the catalog resolves this track'}
            </Text>
          )}
          <MonoText size={9.5} color={colors.ink40} style={{ marginTop: 5, letterSpacing: 0.8 }}>
            {syncedLines
              ? 'SYNCED · TAP ANY LINE TO JUMP THERE'
              : lyricExcerpt
                ? 'PLAIN LYRICS · ON DEVICE LOOKUP'
                : lyricMiss
                  ? 'NO LYRICS FILED · INSTRUMENTAL OR OFF-DESK — TAP TO RETRY'
                  : 'FETCHING FROM THE LYRICS DESK…'}
          </MonoText>
        </View>
      </ScrollView>

      {/* ── CAST / SHARE / SAVE foot ────────────────────────────────── */}
      <View style={[styles.foot, { paddingBottom: insets.bottom + 14 }]}>
        <FootBtn icon="desktop-outline" label="CAST" onPress={() => toast.show({ message: 'NO CAST DEVICES NEARBY', icon: 'desktop-outline' })} />
        <FootBtn icon="share-outline" label="SHARE" onPress={() => void onShare()} />
        <FootBtn icon="download-outline" label="SAVE" onPress={() => setShowMore(true)} />
      </View>

      {/* ── queue sheet (the prototype's #queueSheet) ───────────────── */}
      <Modal visible={showQueue} transparent animationType="slide" onRequestClose={() => setShowQueue(false)}>
        <Pressable style={styles.queueBackdrop} onPress={() => setShowQueue(false)}>
          <Pressable style={styles.queueSheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.queueHeaderRow}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.queueHeader}>The Queue</Text>
                <MonoText size={9.5} color={colors.ink60} style={{ marginTop: 3, letterSpacing: 0.8 }} numberOfLines={1}>
                  {upNext.length + 1} TRACKS · SMART SHUFFLE {smartShuffle ? 'ON' : 'OFF'}
                </MonoText>
              </View>
              <Brutal haptic shadow={0} pressOffset={1} onPress={() => setShowQueue(false)} style={styles.chevBtn}>
                <Ionicons name="close" size={16} color={colors.ink} />
              </Brutal>
            </View>

            {/* square-switch pills */}
            <View style={styles.queueToggles}>
              <QueuePill label="SMART SHUFFLE" active={smartShuffle} onPress={() => setSmartShuffle(!smartShuffle)} />
              <QueuePill label="AUTOPLAY" active={autoplay} onPress={() => setAutoplay(!autoplay)} />
              <QueuePill
                label={sleepLabel}
                active={sleepArmed}
                onPress={() => setShowSleep((v) => !v)}
              />
            </View>

            {active ? (
              <View style={styles.queueCurrentRow}>
                <View style={styles.eqBlock}>
                  <EqualizerBars playing={isPlaying} size={16} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <MonoText size={10} bold color={colors.ink} style={{ letterSpacing: 0.8 }} numberOfLines={1}>
                    {active.title.toUpperCase()}
                  </MonoText>
                  <MonoText size={9.5} style={{ marginTop: 2 }} numberOfLines={1}>
                    {active.artist.toUpperCase()}
                  </MonoText>
                </View>
              </View>
            ) : null}

            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 20 }}>
              <View style={styles.secLabel}>
                <MonoText size={9.5} bold color={colors.ink60} style={{ letterSpacing: 2.2 }}>
                  NEXT UP
                </MonoText>
                <View style={styles.secRule} />
              </View>
              {upNext.length === 0 ? (
                <MonoText size={10} color={colors.ink60} style={{ paddingVertical: 20, textAlign: 'center', letterSpacing: 0.6 }}>
                  NOTHING QUEUED — SONGS YOU ADD WILL APPEAR HERE
                </MonoText>
              ) : (
                upNext.map((t, i) => (
                  <View key={t.id} style={styles.queueRow}>
                    <MonoText size={10} bold color={colors.ink40} style={{ width: 22 }}>
                      {String(i + 1).padStart(2, '0')}
                    </MonoText>
                    <Artwork uri={t.artwork} seed={t.id} size={40} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.queueTitle} numberOfLines={1}>
                        {t.isRecommended ? '\u2726 ' : ''}
                        {t.title.toUpperCase()}
                      </Text>
                      <MonoText size={9.5} style={{ marginTop: 2 }} numberOfLines={1}>
                        {t.artist.toUpperCase()}
                      </MonoText>
                    </View>
                    <Pressable hitSlop={10} onPress={() => removeFromQueue(t.id)}>
                      <Ionicons name="close" size={17} color={colors.ink40} />
                    </Pressable>
                  </View>
                ))
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ── sleep timer sheet (Task 28 · godmode) ───────────────────── */}
      <Modal visible={showSleep} transparent animationType="fade" onRequestClose={() => setShowSleep(false)}>
        <Pressable style={styles.queueBackdrop} onPress={() => setShowSleep(false)}>
          <Pressable style={styles.sleepSheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.queueHeaderRow}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.queueHeader}>Sleep Timer</Text>
                <MonoText size={9.5} color={colors.ink60} style={{ marginTop: 3, letterSpacing: 0.8 }}>
                  {sleepArmed
                    ? `MUSIC STOPS IN ${Math.max(1, Math.ceil((sleep.endAt! - Date.now()) / 60000))} MIN · FADES THE LAST 8S`
                    : 'THE QUEUE WAVES GOODNIGHT — NO SUDDEN SILENCE'}
                </MonoText>
              </View>
              <Brutal haptic shadow={0} pressOffset={1} onPress={() => setShowSleep(false)} style={styles.chevBtn}>
                <Ionicons name="close" size={16} color={colors.ink} />
              </Brutal>
            </View>
            <View style={styles.sleepOpts}>
              {[15, 30, 45, 60].map((m) => (
                <Brutal
                  key={m}
                  haptic
                  shadow={0}
                  pressOffset={1}
                  onPress={() => armSleepTimer(m)}
                  style={[styles.sleepOpt, sleep.minutes === m && sleepArmed && styles.sleepOptOn]}
                >
                  <MonoText size={11} bold color={colors.ink}>
                    {`${m} MIN`}
                  </MonoText>
                </Brutal>
              ))}
              <Brutal
                haptic
                shadow={0}
                pressOffset={1}
                onPress={() => cancelSleepTimer()}
                style={styles.sleepOpt}
              >
                <MonoText size={11} bold color={colors.ink40}>
                  {'TURN OFF'}
                </MonoText>
              </Brutal>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* more menu (download / radio / share) */}
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

function FootBtn({ icon, label, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) {
  return (
    <Pressable hitSlop={8} onPress={onPress} style={({ pressed }) => [styles.footBtn, pressed && { opacity: 0.6 }]}>
      <Ionicons name={icon} size={17} color={colors.ink60} />
      <MonoText size={8.5} bold color={colors.ink60} style={{ letterSpacing: 1.4, marginTop: 3 }}>
        {label}
      </MonoText>
    </Pressable>
  );
}

function QueuePill({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Brutal haptic shadow={0} pressOffset={1} onPress={onPress} style={[styles.qPill, active && { backgroundColor: colors.acid }]}>
      <View style={[styles.qSw, active && { backgroundColor: colors.orange }]} />
      <MonoText size={10} bold color={colors.ink} style={{ letterSpacing: 0.8 }}>
        {label}
      </MonoText>
    </Brutal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  bgArt: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%' },
  scroll: { paddingHorizontal: 24 },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 18,
    borderBottomWidth: 2,
    borderBottomColor: colors.ink,
    paddingBottom: 10,
    marginHorizontal: -24,
    paddingHorizontal: 18,
  },
  chevBtn: {
    width: 38,
    height: 38,
    borderWidth: 2,
    borderColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.paper,
  },
  artWrap: {
    position: 'relative',
    alignSelf: 'center',
    marginTop: 6,
  },
  artCard: {
    borderWidth: 2.5,
    borderColor: colors.ink,
    ...({ shadowColor: colors.ink, shadowOpacity: 1, shadowRadius: 0, shadowOffset: { width: 8, height: 8 }, elevation: 8 } as object),
  },
  burstHeart: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    marginLeft: -37,
    marginTop: -37,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stamp: {
    position: 'absolute',
    top: -14,
    right: -14,
    width: 58,
    height: 58,
    backgroundColor: colors.acid,
    borderWidth: 2,
    borderColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '8deg' }],
  },
  titleSection: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginTop: 22,
    borderBottomWidth: 2,
    borderBottomColor: colors.ink,
    paddingBottom: 14,
  },
  title: {
    color: colors.ink,
    fontFamily: fonts.display,
    fontSize: 28,
    lineHeight: 28,
    textTransform: 'uppercase',
    letterSpacing: -0.2,
  },
  likeBtn: {
    width: 40,
    height: 40,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.paper,
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressSection: { marginTop: 18 },
  barHit: { paddingVertical: 8, marginVertical: -4 },
  barTrack: {
    height: 14,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.paper2,
    overflow: 'hidden',
  },
  barFillWrap: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: colors.orange,
    overflow: 'hidden',
    maxWidth: '100%',
  },
  barFillStripes: {
    flexDirection: 'row',
    alignItems: 'stretch',
    height: '100%',
  },
  stripe: {
    width: 6,
    marginRight: 2,
    backgroundColor: colors.ink,
    height: '100%',
  },
  times: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 7 },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 14,
  },
  smlBtn: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  smlOn: {
    backgroundColor: colors.acid,
    borderColor: colors.ink,
  },
  playBtn: {
    width: 66,
    height: 66,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  spinner: {
    width: 22,
    height: 22,
    borderWidth: 2.5,
    borderColor: 'rgba(244,241,234,0.3)',
    borderTopColor: colors.acid,
  },
  repeatOne: {
    position: 'absolute',
    bottom: -3,
    right: -5,
    width: 7,
    height: 7,
    backgroundColor: colors.orange,
  },
  lyricsCard: {
    marginTop: 16,
    marginBottom: 8,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.paper2,
    padding: 13,
  },
  lyricsLine: {
    color: colors.ink,
    fontSize: 14.5,
    fontFamily: fonts.semibold,
    lineHeight: 21,
    marginTop: 6,
  },
  foot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingTop: 12,
    borderTopWidth: 2,
    borderTopColor: colors.ink,
    backgroundColor: colors.paper,
  },
  footBtn: { alignItems: 'center', flexDirection: 'row', gap: 6 },
  /* queue sheet */
  queueBackdrop: { flex: 1, backgroundColor: 'rgba(22,21,19,0.45)', justifyContent: 'flex-end' },
  queueSheet: {
    height: '78%',
    backgroundColor: colors.paper,
    borderTopWidth: 3,
    borderTopColor: colors.ink,
    paddingTop: 16,
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  queueHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: colors.ink,
    paddingBottom: 10,
  },
  queueHeader: {
    color: colors.ink,
    fontFamily: fonts.display,
    fontSize: 18,
    textTransform: 'uppercase',
  },
  queueToggles: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: colors.ink,
  },
  /* vibe strip (Task 28) */
  vibeStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 14,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.paper2,
  },
  vibeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.ink16,
    marginRight: 8,
  },
  vibeDotLive: {
    backgroundColor: colors.acid,
  },
  vibeBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.acid,
  },
  /* sleep timer sheet (Task 28) */
  sleepSheet: {
    backgroundColor: colors.paper,
    borderTopWidth: 3,
    borderTopColor: colors.ink,
    paddingTop: 16,
    paddingHorizontal: 20,
    paddingBottom: 24,
  },
  sleepOpts: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingTop: 14,
  },
  sleepOpt: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.paper,
  },
  sleepOptOn: {
    backgroundColor: colors.acid,
  },
  qPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1.5,
    borderColor: colors.ink,
    paddingHorizontal: 13,
    paddingVertical: 7,
  },
  qSw: { width: 8, height: 8, backgroundColor: colors.ink40 },
  queueCurrentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
  },
  eqBlock: {
    width: 40,
    height: 40,
    backgroundColor: colors.ink,
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
    paddingBottom: 10,
    paddingRight: 10,
  },
  queueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: colors.ink16,
  },
  queueTitle: {
    color: colors.ink,
    fontSize: 12.5,
    fontFamily: fonts.bold,
    textTransform: 'uppercase',
    letterSpacing: 0.2,
    flexShrink: 1,
  },
  secLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingTop: 12,
    paddingBottom: 4,
  },
  secRule: { flex: 1, height: 2, backgroundColor: colors.ink },
});
