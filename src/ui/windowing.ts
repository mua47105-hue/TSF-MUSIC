/**
 * Pure windowing math shared by the adaptive-layout work (gauntlet R5).
 *
 * Why these helpers exist: with the orientation lock removed (the root
 * fix for the tablet letterbox bug — see plugins/withWindowPolicy.js),
 * the app can genuinely be asked to lay out in ANY window: landscape
 * phones, portrait/landscape tablets, split halves, Samsung DeX /
 * desktop windows, foldables. The two calculations below are the ones
 * that used to assume "window is a portrait phone" and must not.
 *
 * Pure functions (no React, no Dimensions) so they are lockable by
 * tests/ai/windowing_locks.test.ts.
 */

/**
 * Column count for the Search "Browse all" genre grid.
 *
 * 2 columns at phone widths (as since v1), 4 columns once the window is
 * wide enough that 2 flex:1 tiles would look oversized (≥720dp — the
 * sw600dp+ tablet / landscape-phone / desktop-window territory).
 *
 * The FlatList consuming this MUST change its `key` when the count
 * changes (`key={`browse-${cols}`}`) — remounting the list per column
 * count is the only safe way to change numColumns (Android VirtualizedList
 * invariant, lesson locked in v3.4.1's "Changing numColumns on the fly" fix).
 */
export function browseColumnsFor(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 2;
  return width >= 720 ? 4 : 2;
}

/**
 * Player artwork edge length for a given window.
 *
 * Portrait phones: full width minus page padding (the historic look —
 * unchanged for every portrait-phone window). Landscape phones, landscape
 * tablets and desktop windows: capped at 62% of the window HEIGHT so a
 * 900dp-wide window doesn't produce a 900dp square that shoves every
 * control off-screen. Floored at 200dp so tiny split-screen windows
 * still show a usable artwork.
 */
export function playerArtSize(width: number, height: number): number {
  const w = Number.isFinite(width) && width > 0 ? width : 400;
  const h = Number.isFinite(height) && height > 0 ? height : 800;
  return Math.round(Math.max(200, Math.min(w - 32, h * 0.62)));
}
