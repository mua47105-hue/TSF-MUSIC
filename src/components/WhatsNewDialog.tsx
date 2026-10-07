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

const SEEN_KEY = 'tsf.whatsNew.v5_0_0';
/** Set on every close — Onboarding polls it before showing (see Onboarding.tsx). */
const WHATSNEW_DISMISSED_KEY = 'tsf.whatsNewDismissed';

const CHANGES = [
  // ── WAVE 1 — performance & polish (prewarm, prefetch, images, cinema, hermes) ──
  'PREWARM + PREFETCH — the next song’s stream and your search results resolve before you ask; taps land on warm URLs.',
  'IMAGE PREWARM + CINEMA FLIGHT — artwork lands pre-fetched, and a row tap flies its cover to the player on a transform-only flight.',
  // ── WAVE 2 — emotional features ──
  'SONG STORIES — pin a note to a song: "this was playing when we met." It renders as an italic line under the lyrics, on this device only.',
  'AUDIO BOOKMARKS — long-press the progress bar to save a moment (with a note), tap the dot to jump back; scrubbing is untouched.',
  'TASTE RADAR — a six-axis hexagon of your listening (energy, valence, diversity, discovery, loyalty, era spread) on the Stats desk, shareable offline.',
  'TIME MACHINE — "this day last year" reopens your own history: top-5 tracks and artists per day, kept 3 years, folded from your ledger on-device.',
  // ── WAVE 3 — intelligent playback ──
  'HAPTIC CHOREOGRAPHY — beat ticks, heart taps, crate spins and bookmark saves as pure haptic specs; a reduced-haptics switch ships too.',
  'PSEUDO-VISUALIZER — amplitude bars behind the art, driven by each song’s BAKED energy (no audio DSP), native-driver only, frozen under reduce-motion.',
  'KARAOKE WORDS — word-level timing inside synced lyrics: the current word grows and glows; no word timings = the same line-level mode as before.',
  'SHUFFLE BY VIBE — one button re-orders the queue into an energy-smooth set (greedy nearest-neighbour, ±25% steps); your dragged pins never move.',
  // ── WAVE 4 — deep intelligence ──
  'MOOD JOURNEY — "take me from anxious to calm": a 12-slot queue that drifts toward the target, bounded ±15% a step; empty slots are skipped, never faked.',
  'SESSION MEMORY — the last 3 listening sessions snapshot in the background; RESUME A SESSION rebuilds the vibe with ≤30% unheard rows.',
  'DECADE RADIO — "play the sound of 1994": a deterministic query ladder + year-filtered candidates, with an honest toast when a year is thin.',
  'ARTIST TIMELINE — an artist’s albums on a horizontal year axis; tap a decade chip to play that era; no albums = the top-tracks timeline instead.',
  // ── WAVE 5 — social & exploration ──
  'CONCERT MODE — share the queue + a synchronized start as ONE code; your friend pastes it and the room starts together. No server — the code IS the room; each phone starts on its own clock (±500ms is real).',
  'GENRE EXPLORER — a zoomable map of 26 genre bubbles (same seed, same map for everyone); tap a bubble to play its rows through the existing search ladder.',
  'MEMORY TAGS — "tag this moment" stamps a timestamp + note onto the playing song (a Memories chip appears when it plays). LITE edition: timestamp + note only — location and photos were left out rather than ship unverified native permissions.',
  'As always: all twenty run 100% on-device — zero servers, zero accounts, zero telemetry.',
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
            TSF MUSIC 5.0.0 — THE MAGNUM OPUS
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
