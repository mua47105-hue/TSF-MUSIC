/**
 * WhatsNewDialog — a one-time "What's new" broadsheet bulletin shown the
 * first time the app runs after an update. Makes every release visibly
 * verifiable on the user's device (no more "did the update install?"
 * ambiguity). PULSE edition: paper bulletin, ink rules, acid CTA.
 */

import React, { useEffect, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Brutal, MonoText } from './Brutal';
import { colors, fonts } from '../theme';

const SEEN_KEY = 'tsf.whatsNew.v4_3_0';
/** Set on every close — Onboarding polls it before showing (see Onboarding.tsx). */
const WHATSNEW_DISMISSED_KEY = 'tsf.whatsNewDismissed';

const CHANGES = [
  'SMART VOLUME — ReplayGain-style loudness levelling from the baked energy feature: bangers calm down, quiet songs lift, and it composes with every fade.',
  'CROSSFADE + PLAYBACK SPEED — a 0–12s transition fade (0 = the native cut) and speeds from 0.75× to 2×, both persisted. Honest fade, never claimed gapless.',
  'SMART CRATES — Heavy Rotation, Forgotten Gems, The Graveyard, Recently Rescued: live folders queried from your own listening evidence.',
  'EDIT INFO — fix a song’s title, artist, album, or artwork on this device; the correction keys onto the recording, so every re-listing is fixed at once.',
  'LOCAL REWIND — your monthly Wrapped, computed entirely on your phone: top songs, the Midnight Obsession window, your streak, your Aura — as swipeable share cards.',
  'TASTE DNA BLEND — share your taste code, paste a friend’s, get a deterministic blend playlist of shared artists bridged by each side’s strongest picks. No server.',
  'KINETIC LYRICS — the active line prints LARGE in the song’s palette glow and springs between lines; auto-scroll rides a grid that cannot drift.',
  'AURA VISUALIZER — gradient layers breathing behind the artwork on the native driver; frozen under reduce-motion, half-speed under data saver.',
  'FOCUS MODE — a study timer that owns the player: 15/25/45 minutes of energy-gated focus picks, then a haptics pulse. Cancel restores everything exactly.',
  'As always: all ten run 100% on-device — zero servers, zero accounts, zero telemetry.',
];

export function WhatsNewDialog() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(SEEN_KEY)
      .then((seen) => {
        if (!seen) {
          setVisible(true);
          return AsyncStorage.setItem(SEEN_KEY, '1');
        }
        return undefined;
      })
      .catch(() => undefined);
  }, []);

  const close = () => {
    setVisible(false);
    // Signal for the Onboarding gate — it waits for the dialog to be
    // dismissed before taking over the screen (fresh installs see both).
    AsyncStorage.setItem(WHATSNEW_DISMISSED_KEY, String(Date.now())).catch(() => undefined);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={close}
      statusBarTranslucent
    >
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.kickerRow}>
            <View style={styles.edDot} />
            <MonoText size={9.5} bold color={colors.ink60} style={{ letterSpacing: 2 }}>
              MORNING EDITION · EXTRA
            </MonoText>
          </View>
          <Text style={styles.title}>What&apos;s new</Text>
          <MonoText size={10} bold color={colors.orangeDeep} style={{ letterSpacing: 1, marginBottom: 12 }}>
            TSF MUSIC 4.3.0 — THE TEN
          </MonoText>
          {/* v4.3.1: ten features cannot fit a fixed sheet — the E2E lab
              caught the CTA pushed off-screen (whatsnew-continue never
              visible). The bulletin scrolls; the CTA never leaves. */}
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
            nestedScrollEnabled
          >
            <View style={styles.list}>
              {CHANGES.map((c) => (
                <View key={c} style={styles.row}>
                  <View style={styles.dot} />
                  <Text style={styles.rowText}>{c}</Text>
                </View>
              ))}
            </View>
          </ScrollView>
          <Brutal haptic shadow={3} onInk style={styles.btn} onPress={close} testID="whatsnew-continue">
            <MonoText size={11} bold color={colors.acid} style={{ letterSpacing: 2 }}>
              START READING ▸
            </MonoText>
          </Brutal>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(22,21,19,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  sheet: {
    width: '100%',
    maxWidth: 360,
    // v4.3.1: NO percentage height and NO flex math — twice the E2E lab
    // probe showed Yoga failing to bound the list inside the RN Modal
    // (maxHeight + flexShrink → clipped CTA; height 88% + flex:1 → CTA
    // pushed behind the nav bar, pruned from the a11y tree). A fixed DP
    // viewport on the ScrollView is screens-independent: the sheet hugs
    // header + ≤380dp of scrolling bulletin + the always-visible CTA.
    backgroundColor: colors.paper,
    borderWidth: 2,
    borderColor: colors.ink,
    padding: 24,
    gap: 6,
    ...({ shadowColor: colors.ink, shadowOpacity: 1, shadowRadius: 0, shadowOffset: { width: 8, height: 8 }, elevation: 8 } as object),
  },
  /** Fixed-height scrolling bulletin (≈4.5 bullets); CTA below stays on-screen. */
  scroll: { maxHeight: 380 },
  scrollContent: { flexGrow: 0 },
  kickerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  edDot: { width: 7, height: 7, backgroundColor: colors.orange },
  title: {
    color: colors.ink,
    fontFamily: fonts.display,
    fontSize: 26,
    textTransform: 'uppercase',
    lineHeight: 27,
  },
  list: { gap: 10, marginBottom: 20, borderTopWidth: 1.5, borderTopColor: colors.ink, paddingTop: 14 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  dot: {
    width: 6,
    height: 6,
    backgroundColor: colors.orange,
    marginTop: 6,
  },
  rowText: {
    color: colors.ink,
    fontSize: 13,
    fontFamily: fonts.medium,
    lineHeight: 19,
    flex: 1,
  },
  btn: {
    backgroundColor: colors.ink,
    alignItems: 'center',
    paddingVertical: 14,
  },
});
