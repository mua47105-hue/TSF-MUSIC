/**
 * TASTE RADAR CHART (MAGNUM OPUS · F8) — the six-axis hexagon, rendered
 * with PLAIN VIEWS + transforms. react-native-svg is deliberately NOT a
 * dependency of this repo (installed-constraint law); the geometry that
 * places every line here is the pure radarGeometry() from src/ai/radar.ts,
 * which is lock-tested without a device.
 *
 * Static by construction: nothing animates, so the OS reduce-motion
 * intent is honored trivially and the chart degrades to a static render
 * everywhere (the mission bar asks exactly that). Zero image assets.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { RADAR } from '../ai/core/constants';
import {
  RADAR_AXIS_ORDER,
  radarGeometry,
  type RadarAxes,
} from '../ai/radar';
import { colors, fonts } from '../theme';

const AXIS_LABEL: Record<string, string> = {
  energy: 'ENERGY',
  valence: 'VIBE',
  diversity: 'RANGE',
  discovery: 'FINDS',
  loyalty: 'LOYALTY',
  eraSpread: 'ERAS',
};

export function RadarChart({ axes, size = RADAR.chartSize }: { axes: RadarAxes; size?: number }) {
  const values = RADAR_AXIS_ORDER.map((a) => axes[a]);
  const geo = radarGeometry(values, size);

  return (
    <View style={[styles.wrap, { width: size, height: size }]} testID="taste-radar">
      {/* spokes */}
      {geo.spokes.map((s, i) => (
        <View
          key={`spoke-${i}`}
          style={[
            styles.spoke,
            { left: s.left, top: s.top, width: s.width, transform: [{ rotate: `${s.rotate}deg` }] },
          ]}
        />
      ))}
      {/* frame edges */}
      {geo.frameEdges.map((e, i) => (
        <View
          key={`frame-${i}`}
          style={[
            styles.frameEdge,
            { left: e.left, top: e.top, width: e.width, transform: [{ rotate: `${e.rotate}deg` }] },
          ]}
        />
      ))}
      {/* data polygon */}
      {geo.dataEdges.map((e, i) => (
        <View
          key={`data-${i}`}
          style={[
            styles.dataEdge,
            { left: e.left, top: e.top, width: e.width, transform: [{ rotate: `${e.rotate}deg` }] },
          ]}
        />
      ))}
      {/* vertex dots (a filled polygon needs svg; dots read cleaner anyway) */}
      {geo.data.map((p, i) => (
        <View key={`dot-${i}`} style={[styles.vertex, { left: p.x - 3.5, top: p.y - 3.5 }]} />
      ))}
      {/* axis labels, pinned outside each frame vertex */}
      {geo.frame.map((p, i) => (
        <Text
          key={`label-${i}`}
          style={[
            styles.label,
            {
              left: p.x + (p.x < size / 2 ? -34 : p.x > size / 2 ? 10 : -14),
              top: p.y + (p.y < size / 2 ? -16 : p.y > size / 2 ? 4 : -6),
            },
          ]}
          numberOfLines={1}
        >
          {AXIS_LABEL[RADAR_AXIS_ORDER[i]] ?? ''}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: 'center' },
  spoke: { position: 'absolute', height: 1, backgroundColor: colors.ink16 },
  frameEdge: { position: 'absolute', height: 2, backgroundColor: colors.ink },
  dataEdge: { position: 'absolute', height: 2.5, backgroundColor: colors.orange },
  vertex: {
    position: 'absolute',
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.orange,
    borderWidth: 1.5,
    borderColor: colors.ink,
  },
  label: {
    position: 'absolute',
    fontSize: 8,
    fontFamily: fonts.monoBold,
    color: colors.ink60,
    letterSpacing: 1,
    width: 40,
    textAlign: 'center',
  },
});
