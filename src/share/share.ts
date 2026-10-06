/**
 * share.ts — the capture + handoff orchestrator (gauntlet WAVE 6a).
 *
 * Contract (bars: gauntlet/WAVE6-BARS.md §6a):
 *   native  → capture the off-screen card into a 1080px PNG → native
 *             share sheet (expo-sharing). ANY capture-layer failure
 *             falls back to the v4.0.5 text share — the button can
 *             never regress.
 *   web     → text share, deterministically (cardSpec.shareMode).
 *   cancel  → if a sheet was already shown, we NEVER stack a second
 *             sheet. User dismissed = done.
 */

import { Platform, Share, type View } from 'react-native';
import { captureRef } from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import { shareMode, shareText } from './cardSpec';
import type { Track } from '../types';

export type ShareOutcome = 'card' | 'text' | 'cancel';

export async function shareNowPlaying(
  cardRef: React.RefObject<View>,
  active: Track | null,
  lyricLine: string | null,
  /** Resolves true when the card's artwork has actually loaded. Capture
   *  waits for it — a ♪-placeholder card in a chat thread is worse than
   *  the honest text share (critic round, wave 6). */
  waitArtwork?: () => Promise<boolean>,
): Promise<ShareOutcome> {
  const textFallback = async (): Promise<ShareOutcome> => {
    if (!active) return 'cancel';
    try {
      await Share.share({ message: shareText(active.title, active.artist) });
      return 'text';
    } catch {
      return 'cancel';
    }
  };

  if (shareMode(Platform.OS === 'web' ? 'web' : 'native') === 'text') {
    return textFallback();
  }
  if (!cardRef.current || !active) return textFallback();
  if (waitArtwork) {
    const artOk = await waitArtwork();
    if (!artOk) return textFallback();
  }

  let uri: string;
  try {
    uri = await captureRef(cardRef, {
      format: 'png',
      quality: 1,
      width: 1080,
      height: 1080,
      fileName: 'tsf-share-card',
    });
  } catch {
    // failed BEFORE any sheet was shown → the honest fallback path
    return textFallback();
  }

  try {
    const available = await Sharing.isAvailableAsync();
    if (!available) return textFallback();
    await Sharing.shareAsync(uri, {
      mimeType: 'image/png',
      dialogTitle: 'TSF MUSIC',
    });
    return 'card';
  } catch {
    // The sheet was already up — a dismissal, not a failure. Report the
    // truth ('cancel': the card was shown, nothing was shared) and NEVER
    // stack the text sheet under it (critic round: outcome honesty).
    return 'cancel';
  }
}

/**
 * THE TEN F6 — the Rewind's share: the SAME capture + handoff contract
 * as shareNowPlaying (card PNG on native, honest text share everywhere
 * else, cancel never stacks a second sheet), with the rewind's own
 * text fallback.
 */
export async function shareWrappedNow(
  cardRef: React.RefObject<View>,
  fallbackText: string,
  waitSettle?: () => Promise<boolean>,
): Promise<ShareOutcome> {
  const textFallback = async (): Promise<ShareOutcome> => {
    try {
      await Share.share({ message: fallbackText });
      return 'text';
    } catch {
      return 'cancel';
    }
  };

  if (shareMode(Platform.OS === 'web' ? 'web' : 'native') === 'text') {
    return textFallback();
  }
  if (!cardRef.current) return textFallback();
  if (waitSettle) {
    const ok = await waitSettle();
    if (!ok) return textFallback();
  }

  let uri: string;
  try {
    uri = await captureRef(cardRef, {
      format: 'png',
      quality: 1,
      width: 1080,
      height: 1080,
      fileName: 'tsf-rewind-card',
    });
  } catch {
    return textFallback();
  }

  try {
    const available = await Sharing.isAvailableAsync();
    if (!available) return textFallback();
    await Sharing.shareAsync(uri, {
      mimeType: 'image/png',
      dialogTitle: 'TSF REWIND',
    });
    return 'card';
  } catch {
    return 'cancel';
  }
}
