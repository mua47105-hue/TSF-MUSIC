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

// Bulletin key history — one key per release, shown exactly once:
//   'tsf.whatsNew.v5_0_1' (THE VERIFICATION ROUND) ·
//   'tsf.whatsNew.v5_0_2' (THE STABILITY PATCH) ·
//   'tsf.whatsNew.v5_1_0' (THE MEMORY LAYER) ·
//   'tsf.whatsNew.v5_2_1' (THE HARDENING PASS) ·
//   'tsf.whatsNew.v5_3_0' (SPOTIFY RE INTELLIGENCE & AUDIO LIFT — current).
const SEEN_KEY = 'tsf.whatsNew.v5_3_0';
/** Set on every close — Onboarding polls it before showing (see Onboarding.tsx). */
const WHATSNEW_DISMISSED_KEY = 'tsf.whatsNewDismissed';

const CHANGES = [
  // ── v5.3.0 — SPOTIFY RE INTELLIGENCE & AUDIO LIFT ──
  'ALBUMS PLAY LIKE ALBUMS — loudness normalization now has an ALBUM MODE: every track on one record gets the same gain from the album\'s average loudness, so the quiet ballad stays quieter than the loud closer exactly as the mastering engineer intended. Powered by a re-baked knowledge table that now carries loudness, tempo and acoustic fingerprints for 71,750 songs.',
  'SHUFFLE THAT ACTUALLY SHUFFLES — the queue reorder is now an artist-SPREADING shuffle (the model Spotify itself moved to after users complained about artist clustering): same-artist back-to-back is engineered to zero while the order stays random-feeling, and it\'s seeded so it never repeats a fluke.',
  'IT RETREATS WHEN YOU SAY NO — skip two Smart Shuffle recommendations in a row and the mixer backs off: fewer, safer picks that sit closer to your session\'s energy until one of them earns a full listen.',
  'HOME LEARNS YOUR SHELVES — the AI shelves (The Weekly Crate, Daily Mixes, On The Rise, Because You Listened) are ordered by a tiny on-device bandit that learns which shelf YOU open at which time of day, and its older evidence fades with a 30-day half-life so last month\'s taste can\'t outvote this week\'s.',
  'FASTER FIRST BEAT + SMOOTHER LAST BEAT — the next track\'s connection is pre-warmed with a 64 kB head request the moment it resolves (Spotify\'s own instant-start trick, on-device), and the crossfade now follows the equal-power DJ curve — no more volume cliff when the fade kicks in.',
  'THE LYRICS ARE LISTENING BACK — finish a song with the Sing Along view open for half of it and that artist quietly earns a little more of your home feed. Attention, recorded honestly — nothing leaves the device.',
  'As always: zero servers, zero accounts, zero telemetry — every bit of intelligence runs on your phone.',
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
            TSF MUSIC 5.3.0 — SPOTIFY RE INTELLIGENCE & AUDIO LIFT
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
