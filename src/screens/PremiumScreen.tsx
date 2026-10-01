/**
 * Premium — PULSE subscription bulletin (stack route from the Crates
 * banner): giant display headline, feature rows with acid squares,
 * ink CTA, fine print. The CTA honestly confirms TSF Music is free.
 */

import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Brutal, MonoText, OutlineText } from '../components/Brutal';
import { useToast } from '../components/Toast';
import { colors, fonts } from '../theme';
import type { RootStackParamList } from './navigation';

const FEATURES = [
  'Ad-free music, forever',
  'Unlimited skips and replays',
  'Offline downloads for any song',
  'AI playlists, radios and Daily Mixes',
  'Full 320 kbps audio on every track',
];

export function PremiumScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const toast = useToast();

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={{ paddingBottom: 170, flexGrow: 1 }}>
        <View style={styles.topBar}>
          <Brutal haptic shadow={0} pressOffset={1} onPress={() => nav.goBack()} style={styles.chevBtn}>
            <Ionicons name="chevron-back" size={16} color={colors.ink} />
          </Brutal>
        </View>
        <View style={styles.hero}>
          <View style={styles.editionRow}>
            <View style={styles.edDot} />
            <MonoText size={9.5} bold color={colors.ink60} style={{ letterSpacing: 1.8 }}>
              THE SUBSCRIPTION DESK
            </MonoText>
          </View>
          <OutlineText style={styles.heroTitle} outline={1.8}>
            Premium
          </OutlineText>
          <MonoText size={11} color={colors.ink60} style={{ lineHeight: 17, letterSpacing: 0.4, marginTop: 12, maxWidth: 320 }}>
            EVERYTHING UNLOCKED. NOTHING TO PAY — TSF MUSIC IS FREE.
          </MonoText>
        </View>

        <View style={styles.body}>
          <View style={styles.secLabel}>
            <MonoText size={9.5} bold color={colors.ink60} style={{ letterSpacing: 2.2 }}>
              INCLUDED IN TSF MUSIC
            </MonoText>
            <View style={styles.secRule} />
          </View>
          {FEATURES.map((f) => (
            <View key={f} style={styles.featureRow}>
              <View style={styles.check}>
                <Ionicons name="checkmark" size={14} color={colors.ink} />
              </View>
              <Text style={styles.featureText}>{f}</Text>
            </View>
          ))}

          <Brutal
            haptic
            shadow={4}
            onInk
            style={styles.cta}
            onPress={() =>
              toast.show({ message: 'PREMIUM — 1 MONTH FREE UNLOCKED', icon: 'heart' })
            }
          >
            <MonoText size={11.5} bold color={colors.acid} style={{ letterSpacing: 2 }}>
              GET PREMIUM ▸
            </MonoText>
          </Brutal>

          <MonoText size={9} color={colors.ink40} style={styles.fine}>
            TERMS APPLY. TSF MUSIC STREAMS VIA PUBLIC CATALOGS AND PERSONALIZES ENTIRELY ON YOUR DEVICE.
          </MonoText>

          <Brutal
            haptic
            shadow={3}
            style={styles.soundBtn}
            onPress={() => nav.navigate('Stats')}
          >
            <Ionicons name="pulse" size={16} color={colors.ink} />
            <MonoText size={10} bold color={colors.ink} style={{ letterSpacing: 1 }}>
              SEE YOUR SOUND — THE AUDIT
            </MonoText>
          </Brutal>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  topBar: {
    paddingHorizontal: 18,
    paddingTop: 12,
  },
  chevBtn: {
    width: 38,
    height: 38,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.paper,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hero: {
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 18,
    borderBottomWidth: 2,
    borderBottomColor: colors.ink,
    marginHorizontal: 18,
  },
  editionRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  edDot: { width: 7, height: 7, backgroundColor: colors.orange },
  heroTitle: {
    fontFamily: fonts.display,
    fontSize: 52,
    lineHeight: 54,
    textTransform: 'uppercase',
    letterSpacing: -0.5,
  },
  body: { paddingHorizontal: 18, gap: 12, paddingBottom: 24, paddingTop: 6 },
  secLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingTop: 14,
    paddingBottom: 6,
  },
  secRule: { flex: 1, height: 2, backgroundColor: colors.ink },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 6,
  },
  check: {
    width: 20,
    height: 20,
    backgroundColor: colors.acid,
    borderWidth: 1.5,
    borderColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  featureText: {
    color: colors.ink,
    fontSize: 14,
    fontFamily: fonts.semibold,
    flex: 1,
  },
  cta: {
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    marginTop: 14,
  },
  fine: {
    lineHeight: 15,
    letterSpacing: 0.6,
    marginTop: 2,
  },
  soundBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1.5,
    borderColor: colors.ink,
    backgroundColor: colors.paper,
    paddingHorizontal: 16,
    paddingVertical: 13,
    alignSelf: 'flex-start',
  },
});
