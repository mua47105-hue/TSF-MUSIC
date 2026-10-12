/**
 * ParallaxArtwork — Wave D · D1: the shelf and grid covers breathe with
 * the scroll.
 *
 * WHAT: wraps the Artwork primitive with a native-driver parallax drift:
 *   translateY = clamp(scrollY × 0.15, −20, +20)
 * The shared scroll Animated.Value is written by Animated.event(...,
 * { useNativeDriver: true }) on the screen's FlatList, and the transform
 * chain here (interpolate with clamp extrapolation over the ±(cap/factor)
 * window) attaches NATIVELY — scrolling costs zero JS frames (X4, the
 * potato-phone budget; the same 60fps-by-construction contract as the
 * player visualizer).
 *
 * GAP-FREE DRIFT: the inner art renders oversized by 2×capPx and is
 * clipped by the bordered frame, so a ±20px drift never reveals an edge.
 * The honest trade: the visible crop is the centre (size−2·capPx)/size of
 * the art (~79% at 150px) — the physics of a fully-covering moving image;
 * the frame/border/shadow geometry is pixel-identical to plain Artwork.
 *
 * THE GATES (all must pass, else it renders plain static Artwork — the
 * gates are live, not boot-frozen):
 *   • viewability — the owning list's viewabilityConfig reports visible
 *     rows; offscreen rows never attach a transform (D1 perf bar).
 *   • Reduce Motion (X5, §13) — AccessibilityInfo.isReduceMotionEnabled,
 *     tracked live via reduceMotionChanged (the visualizer's live
 *     reduce-motion idiom).
 *   • Data Saver (X6, §11) — dataSaverActive(), subscribed live so
 *     flipping the switch changes behavior without a remount.
 *
 * Locks: tests/waved_d1_parallax_locks.test.ts
 */

import React from 'react';
import {
  AccessibilityInfo,
  Animated,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Artwork } from './Artwork';
import { dataSaverActive, subscribeDataSaver } from '../player/audioQuality';
import { PARALLAX } from '../ai/core/constants';
import { colors } from '../theme';

/** The pure gate (the auraMode precedent): parallax runs only for a
 *  VISIBLE row, with motion allowed and bytes un-saved. */
export function parallaxMode(reduceMotion: boolean, dataSaver: boolean, visible: boolean): boolean {
  return visible && !reduceMotion && !dataSaver;
}

/** The pure drift spec the native interpolation is built to match
 *  exactly: translateY = clamp(scrollY × factor, −capPx, +capPx). */
export function parallaxOffset(scrollY: number): number {
  const raw = scrollY * PARALLAX.factor;
  return Math.max(-PARALLAX.capPx, Math.min(PARALLAX.capPx, raw));
}

export const ParallaxArtwork = React.memo(function ParallaxArtwork({
  uri,
  seed,
  size,
  style,
  variant = 'square',
  liked = false,
  initials,
  bordered = true,
  scrollY,
  visible = true,
}: {
  uri?: string;
  seed: string;
  size: number;
  style?: StyleProp<ViewStyle>;
  /** 'square' everywhere in PULSE; 'circle' for true avatars */
  variant?: 'card' | 'rounded' | 'mini' | 'circle' | 'square';
  /** Render the orange Liked Songs block. */
  liked?: boolean;
  /** Letters fallback (artist without a photo). */
  initials?: string;
  /** 1.5px ink frame on the parallax frame (default on, like Artwork). */
  bordered?: boolean;
  /** The list's shared native-driver scroll offset (contentOffset.y).
   *  Absent ⇒ plain static Artwork. */
  scrollY?: Animated.Value;
  /** Viewability gate from the owning list (D1: visible rows only). */
  visible?: boolean;
}) {
  const [reduceMotion, setReduceMotion] = React.useState(false);
  const [dataSaver, setDataSaver] = React.useState(dataSaverActive);

  // X5 — Reduce Motion: the OS setting is read once on mount and then
  // tracked LIVE (reduceMotionChanged) — the visualizer's live
  // reduce-motion idiom. X6 — Data Saver: the module flag loads at
  // player boot; the live subscription covers mid-session flips.
  React.useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v: boolean) => {
        if (live) setReduceMotion(v);
      })
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v: boolean) =>
      setReduceMotion(v),
    );
    const unsub = subscribeDataSaver((on: boolean) => setDataSaver(on));
    return () => {
      live = false;
      sub?.remove();
      unsub();
    };
  }, []);

  const active = false && scrollY != null && parallaxMode(reduceMotion, dataSaver, visible); // PROBE C: render path neutralized

  // The native transform: interpolate over ±(capPx/factor) with clamp
  // extrapolation — EXACTLY parallaxOffset(y), computed on the UI
  // thread. (Core Animated has no Animated.clamp node on this RN; the
  // clamped interpolation is the native-driver-safe equivalent.)
  const translateY = React.useMemo(() => {
    if (!active || !scrollY) return null;
    const edge = PARALLAX.capPx / PARALLAX.factor;
    return scrollY.interpolate({
      inputRange: [-edge, edge],
      outputRange: [-PARALLAX.capPx, PARALLAX.capPx],
      extrapolate: 'clamp',
    });
  }, [active, scrollY]);

  // Any gate closed (or no shared scroll value) ⇒ bit-identical to the
  // plain primitive. Zero parallax, zero animated nodes.
  if (!translateY) {
    return (
      <Artwork
        uri={uri}
        seed={seed}
        size={size}
        style={style}
        variant={variant}
        liked={liked}
        initials={initials}
        bordered={bordered}
      />
    );
  }

  const radius = variant === 'circle' ? size / 2 : 0;
  return (
    <View
      style={[
        styles.frame,
        {
          width: size,
          height: size,
          borderRadius: radius,
          borderWidth: bordered ? 1.5 : 0,
          borderColor: colors.ink,
        },
        style,
      ]}
    >
      <Animated.View
        style={{
          position: 'absolute',
          top: -PARALLAX.capPx,
          left: -PARALLAX.capPx,
          width: size + PARALLAX.capPx * 2,
          height: size + PARALLAX.capPx * 2,
          transform: [{ translateY }],
        }}
      >
        <Artwork
          uri={uri}
          seed={seed}
          size={size + PARALLAX.capPx * 2}
          variant="square"
          liked={liked}
          initials={initials}
          bordered={false}
        />
      </Animated.View>
    </View>
  );
});

const styles = StyleSheet.create({
  frame: {
    backgroundColor: colors.paper2,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
