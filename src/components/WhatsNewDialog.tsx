/**
 * WhatsNewDialog — a one-time "What's new" modal shown the first time the
 * app runs after an update. Makes every release visibly verifiable on the
 * user's device (no more "did the update install?" ambiguity).
 */

import React, { useEffect, useState } from 'react';
import { Modal, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { PressableScale } from './PressableScale';
import { colors, fonts, radius, spacing } from '../theme';

const SEEN_KEY = 'tsf.whatsNew.v3_4_0';
/** Set on every close — Onboarding polls it before showing (see Onboarding.tsx). */
const WHATSNEW_DISMISSED_KEY = 'tsf.whatsNewDismissed';

const CHANGES = [
  'YouTube section is LIVE — full songs, ad-free playback, junk rows filtered out',
  'Search now rescues the OFFICIAL song when the catalog only has same-name covers',
  'Fixed the half-screen UI: the app now always renders full-screen (no more split-window wedges)',
  'Tap-to-play is faster and never dies silently — a toast tells you if something fails',
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
          <View style={styles.badge}>
            <Ionicons name="sparkles" size={20} color={colors.textOnGreen} />
          </View>
          <Text style={styles.title}>What&apos;s new</Text>
          <Text style={styles.version}>TSF Music 3.4.0 · YouTube + full-screen fix</Text>
          <View style={styles.list}>
            {CHANGES.map((c) => (
              <View key={c} style={styles.row}>
                <View style={styles.dot} />
                <Text style={styles.rowText}>{c}</Text>
              </View>
            ))}
          </View>
          <PressableScale haptic scaleTo={0.97} style={styles.btn} onPress={close} testID="whatsnew-continue">
            <Text style={styles.btnText}>Let&apos;s go</Text>
          </PressableScale>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  sheet: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: colors.elevated,
    borderRadius: radius.lg,
    padding: spacing.xl,
    gap: 6,
  },
  badge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.accentBright,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  title: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '800',
    fontFamily: fonts.extrabold,
  },
  version: {
    color: colors.accentBright,
    fontSize: 13.5,
    fontWeight: '700',
    fontFamily: fonts.bold,
    marginBottom: 10,
  },
  list: { gap: 10, marginBottom: 18 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.accentBright,
    marginTop: 7,
  },
  rowText: {
    color: colors.text,
    fontSize: 14,
    fontFamily: fonts.regular,
    lineHeight: 19,
    flex: 1,
  },
  btn: {
    backgroundColor: colors.accentBright,
    borderRadius: radius.full,
    alignItems: 'center',
    paddingVertical: 13,
  },
  btnText: {
    color: colors.textOnGreen,
    fontSize: 15,
    fontWeight: '800',
    fontFamily: fonts.extrabold,
  },
});
