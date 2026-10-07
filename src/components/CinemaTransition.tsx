/**
 * CINEMA TRANSITION (MAGNUM OPUS F4) — the flying-album-art overlay.
 *
 * Mounted by PlayerScreen when a row tap armed a flight. Renders the
 * artwork AT THE PLAYER'S HERO RECT (measured via onLayout) and drives
 * it back onto the tapped row's rect with transform-only interpolation
 * (translateX/Y + scale + opacity, useNativeDriver — the JS thread
 * paints nothing per frame, and nothing in the layout ever shifts:
 * the overlay is absolute and touch-transparent).
 *
 * ORDERING DISCIPLINE: the animation starts only after the image LOADS
 * (Image onLoad — the row's art is typically cached, so this lands the
 * same frame) and never runs under the OS reduce-motion intent (honest
 * skip: no flight, the hero art simply paints). onDone fires when the
 * flight lands, fails to load, or is skipped — the parent unmounts the
 * overlay; the real hero art is underneath the whole time.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Dimensions,
  Easing,
  StyleSheet,
  View,
} from 'react-native';
import { CINEMA } from '../ai/core/constants';
import {
  planCinemaFlight,
  flightStartDecision,
  type CinemaFlight,
  type Rect,
} from '../player/cinema';

export function CinemaTransition({
  flight,
  to,
  onDone,
}: {
  flight: CinemaFlight;
  to: Rect;
  onDone?: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [reduced, setReduced] = useState(false);
  const progress = useRef(new Animated.Value(0)).current;
  const settled = useRef(false);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then(setReduced)
      .catch(() => undefined);
  }, []);

  const plan = useMemo(() => planCinemaFlight(flight.from, to), [flight.from, to]);

  const finish = (reason: string) => {
    if (settled.current) return;
    settled.current = true;
    onDone?.();
  };

  useEffect(() => {
    const expired = Date.now() - flight.armedAt > CINEMA.armTtlMs;
    // BLIND-CRITIC P0-1 FIX: the FIRST effect run is always unloaded —
    // a skip there unmounts the overlay before onLoad can re-run the
    // effect, so the flight could never start. The decision table
    // (locked in wave1_cinema_locks) has an explicit WAIT state: hold
    // for onLoad, bounded by an honest give-up timeout.
    const action = flightStartDecision({ loaded, failed, reducedMotion: reduced, expired });
    if (action === 'skip') {
      finish(failed ? 'load-failed' : 'skipped');
      return;
    }
    if (action === 'wait') {
      const t = setTimeout(() => finish('load-timeout'), CINEMA.loadWaitMs);
      return () => clearTimeout(t);
    }
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration: CINEMA.durationMs, // < CINEMA budget 400ms (locked)
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    anim.start(({ finished }) => {
      if (finished) finish('landed');
    });
    return () => anim.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, failed, reduced]);

  const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [plan.dx0, 0] });
  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [plan.dy0, 0] });
  const scale = progress.interpolate({ inputRange: [0, 1], outputRange: [plan.scale0, 1] });
  // Hold fully opaque, then hand over to the real hero art at the very end.
  const opacity = progress.interpolate({ inputRange: [0, 0.88, 1], outputRange: [1, 1, 0] });

  return (
    <View
      pointerEvents="none"
      testID="cinema-overlay"
      style={[styles.overlay, { width: Dimensions.get('window').width, height: Dimensions.get('window').height }]}
    >
      <Animated.Image
        source={{ uri: flight.uri }}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        style={{
          position: 'absolute',
          left: to.x,
          top: to.y,
          width: to.width,
          height: to.height,
          opacity,
          transform: [{ translateX }, { translateY }, { scale }],
        }}
        resizeMode="cover"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    // window-sized absolute fill; touch-transparent by pointerEvents
  },
});
