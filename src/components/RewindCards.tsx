/**
 * RewindCards — THE TEN · F6: the Local Rewind, rendered as a swipeable
 * PULSE card sequence (the prototype's broadsheet language).
 *
 * Content is a PURE spec (share/cardSpec.wrappedCardLines — locked);
 * this component only paints it and wires the share: each card carries
 * its own capture ref and a SHARE button that runs the SAME capture +
 * handoff contract as the now-playing card (PNG on native, honest text
 * share elsewhere). The parent owns the load; NULL summary ⇒ an honest
 * "not enough listening yet" state — never zeros dressed up as stats.
 */

import React, { useRef } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { WRAPPED } from '../ai/core/constants';
import { wrappedCardLines, wrappedShareText } from '../share/cardSpec';
import { shareWrappedNow } from '../share/share';
import { Brutal, MonoText } from './Brutal';
import { colors, fonts } from '../theme';
import type { WrappedSummary } from '../ai/wrapped';

const CARD_W = 260;
const CARD_H = 320;

export function RewindCards({ summary }: { summary: WrappedSummary }) {
  const cards = wrappedCardLines(summary);
  const refs = useRef<Array<React.RefObject<View>>>(cards.map(() => React.createRef<View>()));
  const busy = useRef(false);

  const shareCard = async (i: number) => {
    if (busy.current) return; // no stacked sheets (the share contract)
    busy.current = true;
    try {
      await shareWrappedNow(refs.current[i]!, wrappedShareText(summary));
    } finally {
      busy.current = false;
    }
  };

  return (
    <View>
      <View style={styles.secLabel}>
        <MonoText size={9.5} bold color={colors.ink60} style={{ letterSpacing: 2.2 }}>
          MONTHLY REWIND · ON THIS DEVICE
        </MonoText>
        <View style={styles.secRule} />
      </View>
      <ScrollView
        horizontal
        pagingEnabled={false}
        decelerationRate="fast"
        snapToInterval={CARD_W + 14}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 18, gap: 14 }}
      >
        {cards.map((c, i) => (
          <View key={c.kicker} style={{ width: CARD_W }}>
            {/* the capture stage: the card itself is what gets captured */}
            <View ref={refs.current[i]!} collapsable={false} style={styles.card}>
              <MonoText size={8.5} bold color={colors.orange} style={{ letterSpacing: 2 }}>
                {c.kicker}
              </MonoText>
              <Text style={styles.cardTitle} numberOfLines={3} allowFontScaling={false}>
                {c.title.toUpperCase()}
              </Text>
              <MonoText size={9.5} color={colors.ink60} style={{ marginTop: 8, letterSpacing: 0.6 }} numberOfLines={2}>
                {c.sub.toUpperCase()}
              </MonoText>
              <View style={styles.cardFoot}>
                <MonoText size={8} bold color={colors.ink40} style={{ letterSpacing: 1.6 }}>
                  TSF REWIND
                </MonoText>
              </View>
            </View>
            {/* WEB CARVE-OUT: view-shot capture cannot be trusted with
                remote (CORS-tainting) artwork on web — the lab gets the
                honest text share instead (same rule as shareMode). */}
            {Platform.OS === 'web' ? null : (
              <Brutal haptic shadow={0} pressOffset={1} onPress={() => void shareCard(i)} style={styles.shareBtn}>
                <Ionicons name="share-outline" size={13} color={colors.ink} />
                <MonoText size={8.5} bold color={colors.ink} style={{ letterSpacing: 1.4 }}>
                  SHARE
                </MonoText>
              </Brutal>
            )}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

/**
 * The UNAVAILABLE state — the ledger did not open. Distinct from the
 * honest empty (the two are never conflated; the smart-crate standard).
 */
export function RewindUnavailable() {
  return (
    <View>
      <View style={styles.secLabel}>
        <MonoText size={9.5} bold color={colors.ink60} style={{ letterSpacing: 2.2 }}>
          MONTHLY REWIND
        </MonoText>
        <View style={styles.secRule} />
      </View>
      <View style={[styles.card, styles.emptyCard]}>
        <MonoText size={8.5} bold color={colors.orange} style={{ letterSpacing: 2 }}>
          THE REWIND
        </MonoText>
        <Text style={[styles.cardTitle, { fontSize: 20 }]} allowFontScaling={false}>
          CAN'T READ THE LEDGER
        </Text>
        <MonoText size={9.5} color={colors.ink60} style={{ marginTop: 8, letterSpacing: 0.6 }}>
          YOUR REWIND IS SAFE ON THIS DEVICE — REOPEN YOUR SOUND TO TRY AGAIN
        </MonoText>
      </View>
    </View>
  );
}

/** The honest cold-start state — the rewind refuses to pretend. */
export function RewindEmpty() {
  return (
    <View>
      <View style={styles.secLabel}>
        <MonoText size={9.5} bold color={colors.ink60} style={{ letterSpacing: 2.2 }}>
          MONTHLY REWIND
        </MonoText>
        <View style={styles.secRule} />
      </View>
      <View style={[styles.card, styles.emptyCard]}>
        <MonoText size={8.5} bold color={colors.orange} style={{ letterSpacing: 2 }}>
          THE REWIND
        </MonoText>
        <Text style={[styles.cardTitle, { fontSize: 20 }]} allowFontScaling={false}>
          NOT ENOUGH LISTENING YET
        </Text>
        <MonoText size={9.5} color={colors.ink60} style={{ marginTop: 8, letterSpacing: 0.6 }}>
          PLAY {WRAPPED.minStreams}+ SONGS PAST THE 30-SECOND MARK AND THE REWIND WRITES ITSELF — LOCALLY, NEVER ON A SERVER
        </MonoText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  secLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 26,
    marginBottom: 12,
  },
  secRule: { flex: 1, height: 1, backgroundColor: colors.ink16 },
  card: {
    height: CARD_H,
    backgroundColor: colors.paper2,
    borderWidth: 2,
    borderColor: colors.ink,
    padding: 18,
    justifyContent: 'center',
    gap: 4,
    ...({ shadowColor: colors.ink, shadowOpacity: 1, shadowRadius: 0, shadowOffset: { width: 6, height: 6 }, elevation: 6 } as object),
  },
  cardTitle: {
    color: colors.ink,
    fontFamily: fonts.display,
    fontSize: 26,
    lineHeight: 28,
    marginTop: 6,
    letterSpacing: -0.2,
  },
  cardFoot: {
    position: 'absolute',
    bottom: 14,
    left: 18,
  },
  shareBtn: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 2,
    borderColor: colors.ink,
    paddingVertical: 8,
    backgroundColor: colors.acid,
  },
  emptyCard: { justifyContent: 'center' },
});
