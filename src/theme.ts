/**
 * TSF Music design system — PULSE (v4.0).
 * Editorial brutalism: paper + ink + acid + orange. Type is the
 * interface; zero radius in the chrome; hard offset shadows instead of
 * blurs; mono uppercase labels; Archivo Black display type.
 * Contract: docs/PULSE-REDESIGN.md · bar: prototype-2-pulse.html.
 * Legacy Spotify token names are re-pointed so any un-migrated surface
 * still lands on-brand (same migration trick as v2.3).
 */

export const colors = {
  // ── PULSE core ──
  paper: '#F4F1EA', // base canvas
  paper2: '#ECEADF', // dimmed wells, alt surfaces
  paperDeep: '#DCD9D0', // outer stage (outside the frame)
  ink: '#161513', // text, borders, ink panels
  ink60: 'rgba(22,21,19,0.62)',
  ink40: 'rgba(22,21,19,0.60)',
  ink16: 'rgba(22,21,19,0.16)', // soft rules
  ink78: 'rgba(22,21,19,0.78)', // offset shadows
  acid: '#D9FF3D', // active / play / fill
  orange: '#FF4D00', // accents, shadows-on-ink, liked
  orangeDeep: '#C23A00', // kickers
  // text on ink panels
  onInk: '#F4F1EA',
  onInk60: 'rgba(244,241,234,0.62)',
  onInk40: 'rgba(244,241,234,0.40)',
  onInk16: 'rgba(244,241,234,0.16)',

  // ── legacy names, re-pointed to PULSE ──
  bg: '#F4F1EA', // was #121212
  bgDeep: '#F4F1EA', // tab bar canvas (paper + ink top border now)
  surface: '#ECEADF',
  card: '#ECEADF', // sheets, dialogs
  cardDim: '#E7E4D8',
  elevated: '#161513', // mini player, ink cards (was #282828)
  tile: '#F4F1EA', // quick tiles are bordered paper now
  border: '#161513',

  glass: '#ECEADF',
  glassStrong: '#161513',
  glassBorder: 'rgba(0,0,0,0)',
  glassBorderStrong: 'rgba(0,0,0,0)',

  text: '#161513',
  textDim: 'rgba(22,21,19,0.62)',
  textFaint: 'rgba(22,21,19,0.60)',
  textOnGreen: '#161513', // text on acid

  accent: '#FF4D00', // brand accent → safety orange
  accentBright: '#D9FF3D', // CTA green → acid
  accentDim: '#C23A00',
  accentDeep: '#161513',
  danger: '#C23A00',

  chipActiveBg: '#D9FF3D',
  chipActiveText: '#161513',
  chipInactiveBg: '#F4F1EA',
  chipGhostBorder: '#161513',

  aiStart: '#FF4D00',
  aiMid: '#C23A00',
  aiEnd: '#FF4D00',

  white: '#FFFFFF',
  black: '#161513',
  overlay: 'rgba(22,21,19,0.55)',
  inactiveTab: 'rgba(22,21,19,0.60)',
  likedStart: '#FF4D00', // Liked Songs → solid orange hero
  likedEnd: '#161513',
};

/** Fonts loaded via expo-font in App.tsx. */
export const fonts = {
  regular: 'Archivo-400',
  medium: 'Archivo-500',
  semibold: 'Archivo-600',
  bold: 'Archivo-700',
  display: 'ArchivoBlack-400',
  mono: 'SpaceMono-400',
  monoBold: 'SpaceMono-700',
  // legacy aliases (pre-v4 call sites) — both resolve to display
  extrabold: 'ArchivoBlack-400',
  black: 'ArchivoBlack-400',
  // legacy Figtree (kept loaded; fallbacks only)
  figtreeRegular: 'Figtree-400',
  figtreeBold: 'Figtree-700',
  figtreeBlack: 'Figtree-900',
};

const weightMap: Record<number, string> = {
  400: fonts.regular,
  500: fonts.medium,
  600: fonts.semibold,
  700: fonts.bold,
  800: fonts.display,
  900: fonts.display,
};

/** Pick the loaded font family for a numeric weight (800/900 → display). */
export function font(weight: 400 | 500 | 600 | 700 | 800 | 900 = 500): string {
  return weightMap[weight] ?? fonts.medium;
}

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

/** PULSE geometry — the app chrome has NO radius. */
export const radius = {
  sm: 0,
  md: 0,
  lg: 0,
  xl: 0,
  xxl: 0,
  squircle: 0,
  full: 999, // reserved: the few true circles (avatars in stat feet)
};

/** Border widths. */
export const borderW = {
  hair: 1,
  soft: 1.5,
  hard: 2,
} as const;

/** Hard offset shadow (no blur) — the brutalist elevation. */
export const hardShadow = (n = 4, color: string = colors.ink78) =>
  ({ shadowColor: color, shadowOpacity: 1, shadowRadius: 0, shadowOffset: { width: n, height: n }, elevation: n } as const);

/** Orange hard shadow — reserved for elements sitting on ink. */
export const orangeShadow = (n = 4) => hardShadow(n, colors.orange);

/** PULSE type scale (px). */
export const type = {
  hero: 34, // masthead huge (clamp target on phone)
  title: 17, // shelf headers
  headline: 18,
  subhead: 15,
  body: 13.5,
  caption: 12,
  micro: 10,
  monoXs: 8.5,
  monoSm: 9.5,
  monoMd: 10.5,
  monoLg: 11.5,
};

/** Kicker style helper — mono uppercase orange-deep micro label. */
export const kicker = {
  fontFamily: fonts.monoBold,
  fontSize: type.monoSm,
  letterSpacing: 2,
  textTransform: 'uppercase' as const,
  color: colors.orangeDeep,
};

/** Mono meta style helper — uppercase ink-60. */
export const monoMeta = {
  fontFamily: fonts.mono,
  fontSize: type.monoSm,
  letterSpacing: 0.6,
  textTransform: 'uppercase' as const,
  color: colors.ink40,
};

/** The app is a light paper surface now. */
export const isDarkTheme = false;

/** Genre stacks keep editorial two-color pairs for gradients/grids. */
export const genreColors: Array<[string, string]> = [
  ['#161513', '#D9FF3D'], // Made For You
  ['#C23A00', '#161513'], // Bollywood
  ['#FF4D00', '#F4F1EA'], // Punjabi
  ['#161513', '#F4F1EA'], // Hip-Hop
  ['#D9FF3D', '#161513'], // Chill
  ['#ECEADF', '#161513'], // Lo-Fi
  ['#F4F1EA', '#C23A00'], // Devotional
  ['#FF4D00', '#161513'], // Romance
  ['#161513', '#FF4D00'], // Party
  ['#C23A00', '#D9FF3D'], // Workout
  ['#ECEADF', '#FF4D00'], // Acoustic
  ['#F4F1EA', '#161513'], // Rock
];

export function genreGradient(i: number): [string, string] {
  return genreColors[i % genreColors.length];
}
