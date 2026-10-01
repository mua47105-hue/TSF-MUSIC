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

const SEEN_KEY = 'tsf.whatsNew.v4_0_0';
/** Set on every close — Onboarding polls it before showing (see Onboarding.tsx). */
const WHATSNEW_DISMISSED_KEY = 'tsf.whatsNewDismissed';

const CHANGES = [
  'PULSE — the whole app is redrawn: an editorial, paper-and-ink broadsheet with acid accents, Archivo Black display type and hard shadows. Zero blur, zero rounded corners.',
  'The Wire is now a full tab: MINDBEAT files narrated 25-track playlists from a typed vibe, with a live pipeline view.',
  'Every surface got micro-interactions: press-in buttons, the front-page ticker, acid equalizer bars, and a striped seek bar in the broadsheet player.',
  'Under the hood nothing changed: 320 kbps playback, YouTube rescue, MINDBEAT intelligence, downloads and your library are exactly as v3.4.5 left them.',
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
            TSF MUSIC 4.0 · PULSE — THE BROADSHEET REDESIGN
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
