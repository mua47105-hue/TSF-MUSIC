/**
 * DynamicThemeProvider — paints the whole app with the current song.
 *
 * • Watches the active track in PlayerProvider and extracts its artwork
 *   palette (cached, off-render-path).
 * (v5.2.1 FIX-D4: the AmbientBackdrop component — a documented-but-never-
 *  rendered gradient wash — was DELETED, not mounted: dead code and a doc
 *  claim the app never kept are gone. The per-card useTrackPalette wash is
 *  the ambient layer that actually ships.)
 * • useTrackPalette: per-card hook (hero cards, collection headers) so
 *   any surface can wear its own artwork's colors.
 *
 * Performance contract:
 *   - gradients are static views; only opacity animates (native driver)
 *   - no blur anywhere in this file (glass = translucency + hairlines)
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { usePlayer } from '../player/PlayerProvider';
import {
  extractPalette,
  fallbackPalette,
  withAlpha,
  type DynamicPalette,
} from './dynamic';

const DynamicPaletteContext = createContext<DynamicPalette>(fallbackPalette('tsf'));

/** The palette of whatever is playing right now. */
export function useDynamicPalette(): DynamicPalette {
  return useContext(DynamicPaletteContext);
}

/**
 * Palette for an arbitrary artwork (hero card, collection header…).
 * Starts on a deterministic fallback, refines when extraction lands.
 */
export function useTrackPalette(artwork?: string, seed?: string): DynamicPalette {
  const [palette, setPalette] = useState<DynamicPalette>(() => fallbackPalette(seed ?? 'tsf'));

  useEffect(() => {
    if (!seed) return;
    if (!artwork) {
      setPalette(fallbackPalette(seed));
      return;
    }
    let cancelled = false;
    extractPalette(artwork, seed)
      .then((p) => {
        if (!cancelled) setPalette(p);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [artwork, seed]);

  return palette;
}

export function DynamicThemeProvider({ children }: { children: ReactNode }) {
  const { active } = usePlayer();
  const [palette, setPalette] = useState<DynamicPalette>(() => fallbackPalette('tsf-welcome'));

  const artwork = active?.artwork;
  const trackId = active?.id;

  useEffect(() => {
    if (!trackId) {
      setPalette(fallbackPalette('tsf-welcome'));
      return;
    }
    if (!artwork) {
      setPalette(fallbackPalette(trackId));
      return;
    }
    let cancelled = false;
    extractPalette(artwork, trackId)
      .then((p) => {
        if (!cancelled) setPalette(p);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [trackId, artwork]);

  const value = useMemo(() => palette, [palette]);
  return (
    <DynamicPaletteContext.Provider value={value}>
      {children}
    </DynamicPaletteContext.Provider>
  );
}
