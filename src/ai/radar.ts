/**
 * TASTE RADAR (MAGNUM OPUS · F8) — the six-axis hexagon on StatsScreen.
 *
 * PURE description of the listener's own graded listens: six values in
 * [0,1], each with its formula DOCUMENTED IN constants.ts (RADAR) —
 * energy, valence, diversity, discovery, loyalty, era spread. No
 * Math.random, no network, no React — the locks run this in plain bun.
 *
 * Render note (potato law ⑯): react-native-svg is NOT a dependency of
 * this repo, so the hexagon is drawn with plain Views + transforms; the
 * pure geometry (radarGeometry) is exported here so the vertex/edge
 * math is lockable without a device. The chart degrades to a static
 * render (no animation dependency), and the OS reduce-motion intent
 * changes nothing because nothing animates.
 */

import { RADAR } from './core/constants';
import type { ListenRecord, TasteProfile } from './core/types';

export type RadarAxis = 'energy' | 'valence' | 'diversity' | 'discovery' | 'loyalty' | 'eraSpread';

export type RadarAxes = Record<RadarAxis, number>;

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0); // NaN/∞ degrade to 0, never into the layout

/** The axis order around the hexagon (clockwise from the top vertex). */
export const RADAR_AXIS_ORDER: RadarAxis[] = [
  'energy',
  'valence',
  'diversity',
  'discovery',
  'loyalty',
  'eraSpread',
];

/**
 * computeRadarAxes — the whole feature's brain.
 *
 * The 30-second rule (RADAR.minStreamMs) applies first: a 2s accidental
 * open is not taste evidence. With ZERO counted streams the axes are
 * honestly 0 — the UI renders the cold-state caption, never fake data.
 */
export function computeRadarAxes(profile: TasteProfile, listens: ListenRecord[], now: number): RadarAxes {
  void now; // part of the signature for future decay windows; formulas are window-based
  const counted = listens.filter((l) => l.listenedMs >= RADAR.minStreamMs);

  if (!counted.length) {
    return { energy: 0, valence: 0, diversity: 0, discovery: 0, loyalty: 0, eraSpread: 0 };
  }

  // energy / valence — the mean proxy features of counted streams.
  const energy = counted.reduce((s, l) => s + l.energy, 0) / counted.length;
  const valence = counted.reduce((s, l) => s + l.valence, 0) / counted.length;

  // diversity — distinct primary artists vs the saturation point.
  const artistSet = new Set(counted.map((l) => l.artist.trim().toLowerCase()).filter(Boolean));
  const diversity = artistSet.size / RADAR.artistSaturation;

  // discovery — the share of DISTINCT tracks you met exactly once
  // (1-play rows are finds you haven't returned to yet).
  const trackPlays = new Map<string, number>();
  for (const l of counted) trackPlays.set(l.trackId, (trackPlays.get(l.trackId) ?? 0) + 1);
  const distinct = trackPlays.size;
  let singlePlay = 0;
  for (const plays of trackPlays.values()) if (plays === 1) singlePlay += 1;
  const discovery = distinct > 0 ? singlePlay / distinct : 0;

  // loyalty — the top artist's share of counted streams vs saturation.
  const artistPlays = new Map<string, number>();
  for (const l of counted) {
    const key = l.artist.trim().toLowerCase();
    if (key) artistPlays.set(key, (artistPlays.get(key) ?? 0) + 1);
  }
  let topShare = 0;
  for (const plays of artistPlays.values()) topShare = Math.max(topShare, plays / counted.length);
  const loyalty = topShare / RADAR.loyaltySaturation;

  // era spread — distinct release DECADES among rows that carry a year.
  const decades = new Set<string>();
  for (const l of counted) {
    if (typeof l.year === 'number' && l.year > 1900) {
      decades.add(`${Math.floor(l.year / 10) * 10}`);
    }
  }
  const eraSpread = decades.size / RADAR.eraSaturation;

  // The profile participates so callers can pass the SAME objects the
  // facade holds (and so the signature carries the model for future
  // decay-aware formulas); today's formulas are pure listen statistics.
  void profile;

  return {
    energy: clamp01(energy),
    valence: clamp01(valence),
    diversity: clamp01(diversity),
    discovery: clamp01(discovery),
    loyalty: clamp01(loyalty),
    eraSpread: clamp01(eraSpread),
  };
}

/** Deterministic string key of the axes (lock + empty-state helper). */
export function computeRadarAxesKey(axes: RadarAxes): string {
  return RADAR_AXIS_ORDER.map((a) => `${axes[a]}`).join('|');
}

/**
 * The radar's share text (the existing share pipeline's fallback path
 * and the web share both use it). Deterministic, offline, honest.
 */
export function radarShareText(axes: RadarAxes): string {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return [
    'MY TASTE RADAR — TSF MUSIC',
    `Energy ${pct(axes.energy)} · Vibe ${pct(axes.valence)} · Range ${pct(axes.diversity)}`,
    `Finds ${pct(axes.discovery)} · Loyalty ${pct(axes.loyalty)} · Eras ${pct(axes.eraSpread)}`,
  ].join('\n');
}

// ── The pure geometry the View-rendered hexagon consumes ────────────────

export interface RadarPoint {
  x: number;
  y: number;
}

export interface RadarEdge {
  /** absolute left of the (unrotated) edge view */
  left: number;
  /** absolute top of the (unrotated) edge view (height 2) */
  top: number;
  width: number;
  /** degrees clockwise; RN transform.rotate is clockwise for positive values */
  rotate: number;
}

export interface RadarGeometry {
  /** outer hexagon vertices (the frame), top first, clockwise */
  frame: RadarPoint[];
  /** data polygon vertices, same order */
  data: RadarPoint[];
  /** the 6 frame edges, placement-ready (center-of-view rotation) */
  frameEdges: RadarEdge[];
  /** the 6 data-polygon edges, placement-ready */
  dataEdges: RadarEdge[];
  /** center */
  center: RadarPoint;
  /** spoke specs: center → frame vertex, placement-ready */
  spokes: RadarEdge[];
  /** spoke lengths (center → frame vertex) */
  spokeLengths: number[];
}

/**
 * Segment A→B as a placement-ready View spec. RN rotates a View around
 * its OWN center, so the view is centered on the segment's midpoint and
 * rotated by the segment's angle — exact for any two points.
 */
function edgeBetween(a: RadarPoint, b: RadarPoint): RadarEdge {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const width = Math.sqrt(dx * dx + dy * dy);
  const rotate = (Math.atan2(dy, dx) * 180) / Math.PI;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  return { left: mx - width / 2, top: my - 1, width, rotate };
}

/**
 * Hexagon geometry: vertex i sits at angle -90° + i*60° (top first,
 * clockwise) at radius r = value × maxRadius for the data polygon and
 * maxRadius for the frame. Deterministic — same inputs, same map.
 */
export function radarGeometry(values: number[], size: number): RadarGeometry {
  const cx = size / 2;
  const cy = size / 2;
  const maxRadius = size / 2 - 2;
  const n = RADAR_AXIS_ORDER.length;

  const vertexAt = (i: number, radius: number): RadarPoint => {
    const angleDeg = -90 + (360 / n) * i;
    const rad = (angleDeg * Math.PI) / 180;
    return { x: cx + Math.cos(rad) * radius, y: cy + Math.sin(rad) * radius };
  };

  const frame: RadarPoint[] = [];
  const data: RadarPoint[] = [];
  for (let i = 0; i < n; i++) {
    frame.push(vertexAt(i, maxRadius));
    const v = Math.max(0.04, Math.min(1, values[i] ?? 0)); // a zero axis still shows a pinprick
    data.push(vertexAt(i, maxRadius * v));
  }

  const frameEdges: RadarEdge[] = [];
  const dataEdges: RadarEdge[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    frameEdges.push(edgeBetween(frame[i], frame[j]));
    dataEdges.push(edgeBetween(data[i], data[j]));
  }

  const spokes = frame.map((p) => edgeBetween({ x: cx, y: cy }, p));
  const spokeLengths = frame.map((p) => Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2));
  return { frame, data, frameEdges, dataEdges, center: { x: cx, y: cy }, spokes, spokeLengths };
}
