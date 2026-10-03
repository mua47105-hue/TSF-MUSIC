/**
 * ShareCard — the PULSE share artifact (gauntlet WAVE 6a).
 *
 * An off-screen 540×540 card that share.ts captures into a 1080px PNG
 * for the native share sheet. The design contract is the app itself:
 * paper canvas, ink frame, zero radius, hard offset shadow, mono
 * kickers, Archivo Black display type. The differentiator sits under
 * the artwork — THE LINE RIGHT NOW: the exact synced-lyric moment the
 * sharer is standing in. Spotify's card cannot carry that.
 *
 * Mounted with pointerEvents="none" off the screen edge; never focusable,
 * never hittable, invisible to the user, real to the capture layer.
 */

import React from 'react';
import { Image, Text, View, type ImageStyle, type ViewProps } from 'react-native';
import { colors, fonts } from '../theme';
import { fitTitleSize, sanitizeLyricLine } from './cardSpec';
import type { Track } from '../types';

export interface ShareCardProps {
  active: Track | null;
  /** The synced line playing right now (raw LRC text — sanitized here). */
  lyricLine?: string | null;
  /** Artwork settle reporter — capture MUST wait for this or fall back
   *  to text, or a ♪-placeholder card ships to a chat thread (critic). */
  onArtworkSettled?: (loaded: boolean) => void;
}

export const ShareCard = React.forwardRef<View, ShareCardProps>(function ShareCard(
  { active, lyricLine, onArtworkSettled },
  ref,
) {
  const line = sanitizeLyricLine(lyricLine);
  const title = (active?.title ?? '').trim();
  const artist = (active?.artist ?? '').trim();
  const titleSize = fitTitleSize(title);

  return (
    <View ref={ref} testID="share-card" style={styles.card}>
      {/* masthead: brand mark + honest state */}
      <View style={styles.head}>
        <View style={styles.brandRow}>
          <View style={styles.brandSquare} />
          <Text style={styles.brand}>TSF MUSIC</Text>
        </View>
        <Text style={styles.state}>NOW PLAYING</Text>
      </View>

      {/* artwork owns the card — settle-reported so capture never ships a blank */}
      {active?.artwork ? (
        <Image
          source={{ uri: active.artwork }}
          style={styles.art}
          resizeMode="cover"
          onLoad={() => onArtworkSettled?.(true)}
          onError={() => onArtworkSettled?.(false)}
        />
      ) : (
        <View style={styles.artEmpty}>
          <Text style={styles.artEmptyGlyph}>♪</Text>
        </View>
      )}

      {/* the edge: the exact moment, if we know it */}
      {line ? (
        <View style={styles.lyricStrip}>
          <Text style={styles.lyricKicker}>THE LINE RIGHT NOW</Text>
          <Text style={styles.lyricLine} numberOfLines={2}>
            {line}
          </Text>
        </View>
      ) : null}

      {/* title block — lineHeight rides the fitted size (critic: a 44px
          Archivo Black in a fixed 40px box overlaps its own second line) */}
      <Text
        style={[styles.title, { fontSize: titleSize, lineHeight: titleSize + 4 }]}
        numberOfLines={2}
      >
        {title}
      </Text>
      <Text style={styles.artist} numberOfLines={1}>
        {artist}
      </Text>

      {/* foot rule + provenance */}
      <View style={styles.footRule} />
      <Text style={styles.foot}>SHARED FROM TSF MUSIC</Text>
    </View>
  );
});

const styles = {
  card: {
    width: 540,
    height: 540,
    backgroundColor: colors.paper,
    borderWidth: 3,
    borderColor: colors.ink,
    padding: 24,
    // the capture bakes the shadow in — offset shadow like every PULSE card
    shadowColor: colors.ink78,
    shadowOpacity: 1,
    shadowRadius: 0,
    shadowOffset: { width: 8, height: 8 },
  } as ViewProps['style'],
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  } as ViewProps['style'],
  brandRow: { flexDirection: 'row', alignItems: 'center' } as ViewProps['style'],
  brandSquare: {
    width: 18,
    height: 18,
    backgroundColor: colors.acid,
    borderWidth: 2,
    borderColor: colors.ink,
    marginRight: 10,
  } as ViewProps['style'],
  brand: {
    fontFamily: fonts.monoBold,
    fontSize: 17,
    letterSpacing: 2.4,
    color: colors.ink,
  } as ViewProps['style'],
  state: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.6,
    color: colors.ink40,
  } as ViewProps['style'],
  art: {
    flex: 1,
    width: '100%',
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.paper2,
  } as ImageStyle,
  artEmpty: {
    flex: 1,
    width: '100%',
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.paper2,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewProps['style'],
  artEmptyGlyph: { fontFamily: fonts.display, fontSize: 64, color: colors.ink16 } as ViewProps['style'],
  lyricStrip: { marginTop: 14 } as ViewProps['style'],
  lyricKicker: {
    fontFamily: fonts.monoBold,
    fontSize: 10,
    letterSpacing: 2,
    color: colors.orangeDeep,
    marginBottom: 4,
  } as ViewProps['style'],
  lyricLine: {
    fontFamily: fonts.display,
    fontSize: 20,
    lineHeight: 26,
    color: colors.ink,
  } as ViewProps['style'],
  title: {
    fontFamily: fonts.display,
    color: colors.ink,
    marginTop: 12,
  } as ViewProps['style'],
  artist: {
    fontFamily: fonts.mono,
    fontSize: 15,
    letterSpacing: 1.2,
    color: colors.ink60,
    marginTop: 6,
  } as ViewProps['style'],
  footRule: {
    height: 2,
    backgroundColor: colors.ink,
    marginTop: 14,
  } as ViewProps['style'],
  foot: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 2,
    color: colors.ink40,
    marginTop: 8,
  } as ViewProps['style'],
};

// flex:1 artwork needs the card to be a fixed-height column — it is (540).
