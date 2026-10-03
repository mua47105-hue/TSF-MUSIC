/**
 * TasteScreen — "Taste DNA" (§6.6): the transparency surface.
 *
 * The user sees the ENTIRE model and can act on it:
 *   • top artists / genres / languages with visible weight bars
 *   • the daypart matrix — "what the app thinks your 11pm sounds like"
 *   • exploration stats (how adventurous the engine currently is)
 *   • per-artist Boost / Mute that change the very next recommendation
 *   • export the full profile + ledger as JSON (their data, literally)
 *   • reset the taste model (one button, honest summary)
 *   • kill switch: disable all recommendations
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as FileSystem from 'expo-file-system';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { mindbeat } from '../ai/mindbeat';
import { topArtists } from '../ai/core/profile';
import { reasonLine } from '../ai/core/decision';
import type { TasteProfile } from '../ai/core/types';
import { useToast } from '../components/Toast';
import { PressableScale } from '../components/PressableScale';
import { dataSaverActive, setDataSaverActive, subscribeDataSaver } from '../player/audioQuality';
import { colors, fonts, radius, spacing } from '../theme';
import type { RootStackParamList } from './navigation';

const BLOCK_LABELS: Array<[string, string]> = [
  ['morning', 'Morning'],
  ['afternoon', 'Afternoon'],
  ['evening', 'Evening'],
  ['night', 'Night'],
  ['lateNight', 'Late night'],
];

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function TasteScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const toast = useToast();
  const [profile, setProfile] = useState<TasteProfile | null>(null);
  const [recsOff, setRecsOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dataSaver, setDataSaver] = useState(dataSaverActive());

  useEffect(() => subscribeDataSaver(setDataSaver), []);

  const reload = useCallback(() => {
    mindbeat.onProfile(() => undefined); // ensure listeners path is warm
    setProfile({ ...mindbeat.profile });
    void mindbeat.isDisabled().then(setRecsOff);
  }, []);

  useEffect(() => {
    const unsub = mindbeat.onProfile(() => setProfile({ ...mindbeat.profile }));
    reload();
    void mindbeat.rebuildProfile().then(() => setProfile({ ...mindbeat.profile }));
    return unsub;
  }, [reload]);

  const act = async (fn: () => Promise<void>, message: string) => {
    setBusy(true);
    try {
      await fn();
      toast.show({ message, icon: 'checkmark-circle' });
      setProfile({ ...mindbeat.profile });
    } finally {
      setBusy(false);
    }
  };

  const exportProfile = async () => {
    try {
      const json = await mindbeat.exportJSON();
      const path = `${FileSystem.documentDirectory}tsf-taste-profile.json`;
      await FileSystem.writeAsStringAsync(path, json, { encoding: FileSystem.EncodingType.UTF8 });
      toast.show({ message: `Exported to ${path.split('/').pop()} (in app storage)`, icon: 'download' });
    } catch {
      toast.show({ message: 'Export failed', icon: 'alert-circle-outline' });
    }
  };

  const resetProfile = () => {
    Alert.alert(
      'Reset taste model?',
      'TSF AI forgets every artist, mood and daypart it learned. Your downloads, playlists and liked songs stay. Onboarding runs again on next launch.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: () =>
            act(async () => {
              await mindbeat.resetProfile();
              await mindbeat.kvSet('onboardingDone', false);
            }, 'Taste model reset — starting fresh'),
        },
      ],
    );
  };

  const artists = profile ? topArtists(profile, Date.now(), 8) : [];
  const genres = profile
    ? Object.entries(profile.genres)
        .filter(([g]) => !g.startsWith('__'))
        .sort((a, b) => b[1].w - a[1].w)
        .slice(0, 5)
    : [];
  const langs = profile
    ? Object.entries(profile.languages).sort((a, b) => b[1].w - a[1].w).slice(0, 4)
    : [];
  const maxArtistW = Math.max(0.001, ...artists.map((a) => a.w));
  const muted = profile?.corrections.mutedArtists ?? [];
  const epsilon = profile?.exploration.epsilon ?? 0;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        <PressableScale hitSlop={12} onPress={() => nav.goBack()}>
          <Ionicons name="chevron-back" size={22} color={colors.ink} />
        </PressableScale>
        <Text style={styles.topLabel}>Taste DNA</Text>
        <View style={{ width: 26 }} />
      </View>

      {!profile ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={colors.orange} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: 170 }} showsVerticalScrollIndicator={false}>
          {/* The model at a glance */}
          <View style={styles.glanceCard}>
            <Text style={styles.glanceTitle}>What TSF AI believes about you</Text>
            <Text style={styles.glanceSub}>
              {profile.sessionCount} sessions learned · {Object.keys(profile.artists).length} artists ·{' '}
              {Math.round(epsilon * 100)}% exploration
            </Text>
            <View style={styles.barRow}>
              <View style={[styles.bar, { flex: Math.max(0.08, epsilon) }]} />
              <View style={[styles.barDim, { flex: Math.max(0.08, 1 - epsilon) }]} />
            </View>
            <Text style={styles.barCaption}>
              Exploration {Math.round(epsilon * 100)}% — how often the engine risks a fresh find for you
            </Text>
          </View>

          {/* Top artists with weights + boost/mute */}
          <Text style={styles.sectionTitle}>Artists</Text>
          {artists.length ? (
            artists.map((a) => {
              const isMuted = muted.includes(a.artist);
              return (
                <View key={a.artist} style={styles.artistCard}>
                  <View style={{ flex: 1 }}>
                    <View style={styles.artistHead}>
                      <Text style={[styles.artistName, isMuted && { color: colors.textFaint }]} numberOfLines={1}>
                        {titleCase(a.artist)}
                      </Text>
                      {isMuted ? (
                        <View style={styles.mutedTag}>
                          <Text style={styles.mutedTagText}>MUTED</Text>
                        </View>
                      ) : null}
                    </View>
                    <View style={styles.weightTrack}>
                      <View style={[styles.weightBar, { width: `${Math.max(6, (a.w / maxArtistW) * 100)}%` }]} />
                    </View>
                  </View>
                  <View style={styles.artistActions}>
                    <PressableScale
                      hitSlop={8}
                      disabled={busy}
                      onPress={() => act(() => mindbeat.boostArtist(a.artist), `${titleCase(a.artist)} boosted`)}
                      style={styles.miniBtn}
                    >
                      <Ionicons name="trending-up-outline" size={17} color={colors.orange} />
                    </PressableScale>
                    <PressableScale
                      hitSlop={8}
                      disabled={busy}
                      onPress={() =>
                        act(
                          () => (isMuted ? mindbeat.unmuteArtist(a.artist) : mindbeat.muteArtist(a.artist)),
                          isMuted ? `${titleCase(a.artist)} un-muted` : `${titleCase(a.artist)} muted`,
                        )
                      }
                      style={styles.miniBtn}
                    >
                      <Ionicons
                        name={isMuted ? 'volume-high-outline' : 'volume-mute-outline'}
                        size={17}
                        color={isMuted ? colors.orange : colors.ink40}
                      />
                    </PressableScale>
                  </View>
                </View>
              );
            })
          ) : (
            <Text style={styles.emptyText}>Play a few songs — the model builds itself from your listens.</Text>
          )}

          {/* Genres + languages */}
          {genres.length || langs.length ? (
            <View style={styles.pillGridWrap}>
              {genres.length ? (
                <>
                  <Text style={styles.sectionTitle}>Moods & genres</Text>
                  <View style={styles.pillGrid}>
                    {genres.map(([g, e]) => (
                      <View key={g} style={styles.pill}>
                        <Text style={styles.pillText}>{titleCase(g.replace('__', ''))}</Text>
                        <Text style={styles.pillW}>{e.w.toFixed(1)}</Text>
                      </View>
                    ))}
                  </View>
                </>
              ) : null}
              {langs.length ? (
                <>
                  <Text style={styles.sectionTitle}>Languages</Text>
                  <View style={styles.pillGrid}>
                    {langs.map(([l, e]) => (
                      <View key={l} style={styles.pill}>
                        <Text style={styles.pillText}>{titleCase(l)}</Text>
                        <Text style={styles.pillW}>{e.w.toFixed(1)}</Text>
                      </View>
                    ))}
                  </View>
                </>
              ) : null}
            </View>
          ) : null}

          {/* Daypart matrix — "what your 11pm sounds like" */}
          <Text style={styles.sectionTitle}>Your day, by sound</Text>
          <View style={styles.dayGrid}>
            {BLOCK_LABELS.map(([block, label]) => {
              const cell = profile.daypart[`${block}|weekday`];
              const top = cell
                ? Object.entries(cell.artistWeights).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([a]) => titleCase(a))
                : [];
              return (
                <View key={block} style={styles.dayCard}>
                  <Text style={styles.dayLabel}>{label}</Text>
                  {top.length ? (
                    <>
                      <Text style={styles.dayArtists} numberOfLines={2}>
                        {top.join(' · ')}
                      </Text>
                      <Text style={styles.dayEnergy}>
                        energy {cell!.energyMean.toFixed(2)} · {cell!.sessionCount} sessions
                      </Text>
                    </>
                  ) : (
                    <Text style={styles.dayEmpty}>Not learned yet</Text>
                  )}
                </View>
              );
            })}
          </View>

          {/* Reason vocabulary — honesty on display (§8.5) */}
          <Text style={styles.sectionTitle}>How TSF AI explains picks</Text>
          <View style={styles.reasonList}>
            {(['BECAUSE_PLAYED', 'BECAUSE_HEARTED', 'NEIGHBOR', 'FITS_BLOCK', 'SESSION_CONTINUITY', 'FRESH_FIND', 'BACK_FOR_MORE'] as const).map(
              (code) => (
                <View key={code} style={styles.reasonRow}>
                  <Ionicons name="sparkles-outline" size={12} color={colors.aiEnd} />
                  <Text style={styles.reasonText}>"{reasonLine(code, 'an artist')}"</Text>
                </View>
              ),
            )}
            <Text style={styles.reasonFoot}>
              Every line is backed by evidence the app actually has. No "fans also like" — there are no other fans,
              and fake social proof is banned.
            </Text>
          </View>

          {/* Controls: kill switch, export, reset */}
          <Text style={styles.sectionTitle}>Controls</Text>
          <PressableScale
            haptic
            style={styles.controlCard}
            onPress={() =>
              act(async () => {
                await mindbeat.setDisabled(!recsOff);
                setRecsOff(!recsOff);
              }, recsOff ? 'Recommendations back on' : 'Recommendations off — your music only')
            }
          >
            <Ionicons name={recsOff ? 'close-circle-outline' : 'sparkles-outline'} size={20} color={recsOff ? colors.ink40 : colors.orange} />
            <View style={{ flex: 1 }}>
              <Text style={styles.controlTitle}>Disable all recommendations</Text>
              <Text style={styles.controlSub}>Classic shuffle + your own music only. Nothing changes until you turn it back on.</Text>
            </View>
            <View style={[styles.switchTrack, recsOff && styles.switchOn]}>
              <View style={[styles.switchThumb, recsOff && { backgroundColor: colors.accentBright }]} />
            </View>
          </PressableScale>
          <PressableScale haptic style={styles.controlCard} onPress={exportProfile}>
            <Ionicons name="download-outline" size={20} color={colors.textDim} />
            <View style={{ flex: 1 }}>
              <Text style={styles.controlTitle}>Export my data</Text>
              <Text style={styles.controlSub}>Full taste profile + listening ledger as JSON — your data, literally.</Text>
            </View>
          </PressableScale>
          <PressableScale
            haptic
            style={styles.controlCard}
            onPress={() =>
              act(async () => {
                await setDataSaverActive(!dataSaver);
                setDataSaver(!dataSaver);
              }, dataSaver ? 'Full quality restored — 320 kbps' : 'Data saver on — about a third of the data per song')
            }
          >
            <Ionicons name={dataSaver ? 'speedometer-outline' : 'musical-notes-outline'} size={20} color={dataSaver ? colors.orange : colors.textDim} />
            <View style={{ flex: 1 }}>
              <Text style={styles.controlTitle}>Data saver</Text>
              <Text style={styles.controlSub}>
                {dataSaver
                  ? 'Streaming at the catalog\'s native 96/160 kbps. Your mobile data says thanks.'
                  : 'Streaming at full 320 kbps. Turn on to use about a third of the data.'}
              </Text>
            </View>
            <View style={[styles.switchTrack, dataSaver && styles.switchOn]}>
              <View style={[styles.switchThumb, dataSaver && { backgroundColor: colors.accentBright }]} />
            </View>
          </PressableScale>
          <PressableScale haptic style={styles.controlCard} onPress={resetProfile}>
            <Ionicons name="refresh-outline" size={20} color="#e06c5a" />
            <View style={{ flex: 1 }}>
              <Text style={[styles.controlTitle, { color: colors.orangeDeep }]}>Reset taste model</Text>
              <Text style={styles.controlSub}>Forgets everything learned. Playlists, likes and downloads stay.</Text>
            </View>
          </PressableScale>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: colors.ink,
  },
  topLabel: {
    color: colors.ink,
    fontFamily: fonts.display,
    fontSize: 16,
    textTransform: 'uppercase',
    letterSpacing: 0.2,
  },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  glanceCard: {
    margin: 18,
    marginBottom: 6,
    backgroundColor: colors.paper,
    borderWidth: 2,
    borderColor: colors.ink,
    padding: 16,
    gap: 8,
    ...({ shadowColor: colors.ink, shadowOpacity: 1, shadowRadius: 0, shadowOffset: { width: 4, height: 4 }, elevation: 4 } as object),
  },
  glanceTitle: { color: colors.ink, fontFamily: fonts.display, fontSize: 15, textTransform: 'uppercase' },
  glanceSub: { color: colors.ink60, fontSize: 10, fontFamily: fonts.mono, letterSpacing: 0.5, textTransform: 'uppercase' },
  barRow: { flexDirection: 'row', height: 10, borderWidth: 1.5, borderColor: colors.ink, overflow: 'hidden', marginTop: 4 },
  bar: { backgroundColor: colors.orange },
  barDim: { backgroundColor: colors.paper2 },
  barCaption: { color: colors.ink40, fontSize: 9.5, fontFamily: fonts.mono, textTransform: 'uppercase', letterSpacing: 0.6 },
  sectionTitle: {
    color: colors.ink,
    fontFamily: fonts.display,
    fontSize: 14,
    textTransform: 'uppercase',
    paddingHorizontal: 18,
    paddingTop: 20,
    paddingBottom: 8,
  },
  artistCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 18,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1.5,
    borderColor: colors.ink,
    backgroundColor: colors.paper,
  },
  artistHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  artistName: { color: colors.ink, fontSize: 13, fontWeight: '700', fontFamily: fonts.bold, textTransform: 'uppercase', letterSpacing: 0.2, flexShrink: 1 },
  mutedTag: {
    backgroundColor: colors.ink,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  mutedTagText: { color: colors.paper, fontSize: 8, fontWeight: '800', fontFamily: fonts.monoBold, letterSpacing: 1 },
  weightTrack: {
    height: 8,
    borderWidth: 1,
    borderColor: colors.ink,
    backgroundColor: colors.paper2,
    marginTop: 6,
    overflow: 'hidden',
  },
  weightBar: { height: '100%', backgroundColor: colors.acid },
  artistActions: { flexDirection: 'row', gap: 6 },
  miniBtn: {
    width: 34,
    height: 34,
    borderWidth: 1.5,
    borderColor: colors.ink,
    backgroundColor: colors.paper,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillGridWrap: { gap: 0 },
  pillGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 18 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.paper,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderWidth: 1.5,
    borderColor: colors.ink,
  },
  pillText: { color: colors.ink, fontSize: 11, fontFamily: fonts.bold, textTransform: 'uppercase', letterSpacing: 0.4 },
  pillW: { color: colors.ink40, fontSize: 10, fontFamily: fonts.monoBold },
  dayGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingHorizontal: 18 },
  dayCard: {
    width: '48%',
    backgroundColor: colors.paper2,
    borderWidth: 1.5,
    borderColor: colors.ink,
    padding: 12,
    gap: 4,
  },
  dayLabel: { color: colors.orangeDeep, fontSize: 9.5, fontWeight: '800', fontFamily: fonts.monoBold, textTransform: 'uppercase', letterSpacing: 1.4 },
  dayArtists: { color: colors.ink, fontSize: 12.5, fontFamily: fonts.bold, lineHeight: 16, textTransform: 'uppercase' },
  dayEnergy: { color: colors.ink40, fontSize: 9.5, fontFamily: fonts.mono, textTransform: 'uppercase', letterSpacing: 0.4 },
  dayEmpty: { color: colors.ink40, fontSize: 10.5, fontFamily: fonts.mono, textTransform: 'uppercase' },
  reasonList: { paddingHorizontal: 18, gap: 7 },
  reasonRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: 1, borderBottomColor: colors.ink16, paddingBottom: 7 },
  reasonText: { color: colors.ink60, fontSize: 11.5, fontFamily: fonts.medium, flex: 1 },
  reasonFoot: { color: colors.ink40, fontSize: 9.5, fontFamily: fonts.mono, marginTop: 6, lineHeight: 15, textTransform: 'uppercase', letterSpacing: 0.4 },
  controlCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 18,
    marginBottom: 8,
    backgroundColor: colors.paper,
    borderWidth: 1.5,
    borderColor: colors.ink,
    padding: 14,
  },
  controlTitle: { color: colors.ink, fontSize: 13, fontWeight: '700', fontFamily: fonts.bold, textTransform: 'uppercase', letterSpacing: 0.3 },
  controlSub: { color: colors.ink60, fontSize: 10.5, fontFamily: fonts.mono, marginTop: 3, lineHeight: 15, letterSpacing: 0.3 },
  switchTrack: {
    width: 40,
    height: 22,
    borderWidth: 1.5,
    borderColor: colors.ink,
    backgroundColor: colors.paper2,
    padding: 2,
  },
  switchOn: { backgroundColor: colors.acid },
  switchThumb: { width: 15, height: 15, backgroundColor: colors.ink, alignSelf: 'flex-end' },
  emptyText: {
    color: colors.ink60,
    fontSize: 10.5,
    fontFamily: fonts.mono,
    paddingHorizontal: 18,
    paddingBottom: 8,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    lineHeight: 16,
  },
});
