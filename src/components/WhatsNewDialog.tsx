/**
 * WhatsNewDialog — a one-time "What's new" broadsheet bulletin shown the
 * first time the app runs after an update. Makes every release visibly
 * verifiable on the user's device (no more "did the update install?"
 * ambiguity). PULSE edition: paper bulletin, ink rules, acid CTA.
 */

import React, { useEffect, useState } from 'react';
import { Modal, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Brutal, MonoText } from './Brutal';
import { colors, fonts } from '../theme';

const SEEN_KEY = 'tsf.whatsNew.v4_3_0';
/** Set on every close — Onboarding polls it before showing (see Onboarding.tsx). */
const WHATSNEW_DISMISSED_KEY = 'tsf.whatsNewDismissed';

const CHANGES = [
  'SMART VOLUME — ReplayGain-style loudness levelling built from the baked energy feature: bangers calm down, quiet songs lift, and it composes with every fade. Toggle it off and the volume is byte-identical the instant you tap.',
  'CROSSFADE + PLAYBACK SPEED — a 0–12s transition fade (0 = the native cut) and playback speeds from 0.75× to 2×, both persisted and re-applied on every queue. Honest fade, never claimed gapless.',
  'SMART CRATES — Heavy Rotation, Forgotten Gems, The Graveyard, and Recently Rescued: live folders queried from your own listening evidence, with honest empty states when the proof isn’t there yet.',
  'EDIT INFO — fix a song’s title, artist, album, or artwork right on this device; the correction keys onto the recording, so every re-listing of the same song is fixed at once.',
  'LOCAL REWIND — your monthly Wrapped, computed entirely on your phone: top songs, the Midnight Obsession window, your listening streak, and a truth-conditioned Aura — as swipeable share cards.',
  'TASTE DNA BLEND — share your taste code, paste a friend’s, and get a deterministic blend playlist of your shared artists bridged by each side’s strongest picks. Peer-to-peer, no server in the middle.',
  'KINETIC LYRICS — the active line prints LARGE in the song’s palette glow and springs between lines; upcoming lines dim cheaply. Auto-scroll rides a uniform-height grid that cannot drift.',
  'AURA VISUALIZER — three gradient layers breathing behind the artwork on the native driver. No video, no canvas, no per-frame JS; frozen under reduce-motion, half-speed under data saver.',
  'FOCUS MODE — a study timer that owns the player: 15/25/45 minutes of energy-gated focus picks, art + clock + play/pause, then a haptics pulse. Cancel restores your volume and music exactly. Sleep timer keeps precedence.',
  'As always: every one of the ten runs 100% on-device — zero servers, zero accounts, zero telemetry — and works fully offline once your data is local.',
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
          <View style={styles.list}>
            {CHANGES.map((c) => (
              <View key={c} style={styles.row}>
                <View style={styles.dot} />
                <Text style={styles.rowText}>{c}</Text>
              </View>
            ))}
          </View>
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
    backgroundColor: colors.paper,
    borderWidth: 2,
    borderColor: colors.ink,
    padding: 24,
    gap: 6,
    ...({ shadowColor: colors.ink, shadowOpacity: 1, shadowRadius: 0, shadowOffset: { width: 8, height: 8 }, elevation: 8 } as object),
  },
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
