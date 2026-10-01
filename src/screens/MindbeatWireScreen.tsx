/**
 * MindbeatWireScreen — the PULSE "Wire" tab (prototype: Mindbeat Wire).
 *
 * The wire desk: ai-hero with the live pulse, vibe input + send, idea
 * chips, the 5-stage ink pipeline that lights acid as MINDBEAT works,
 * the narrated dispatch card, and the Your Sound audit box (links the
 * full Stats screen). All logic is the shipped MINDBEAT generator —
 * only the surface is PULSE.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Animated,
  Easing,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { generatePlaylist, PROMPT_IDEAS } from '../ai/generator';
import { generatePlaylistV2, type GeneratedPlaylistV2 } from '../ai/surfaces/playlist';
import { mindbeat } from '../ai/mindbeat';
import { hash32 } from '../ai/core/time';
import { searchSaavnClean } from '../api/saavn';
import { createPlaylist } from '../storage/store';
import { getStats } from '../storage/store';
import type { ListeningStats } from '../types';
import { usePlayer } from '../player/PlayerProvider';
import { useToast } from '../components/Toast';
import { TrackRow } from '../components/TrackRow';
import { Brutal, MonoText, OutlineText, PulseDot } from '../components/Brutal';
import { Artwork } from '../components/Artwork';
import { colors, fonts } from '../theme';
import type { RootStackParamList } from './navigation';

type Stage = 0 | 1 | 2 | 3 | 4 | 5; // 5 = done

const STAGES = [
  'Understanding your vibe',
  'Hunting the catalog',
  'Scoring against your taste',
  'Polishing the sequence',
  'Naming the mix',
];

const PHASE_TO_STAGE: Record<string, Stage> = {
  understanding: 0,
  hunting: 1,
  searching: 1,
  curating: 2,
  scoring: 2,
  polishing: 3,
  narrating: 4,
  done: 5,
};

export function MindbeatWireScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { playQueue } = usePlayer();
  const toast = useToast();

  const [prompt, setPrompt] = useState('');
  const [stage, setStage] = useState<Stage>(5);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GeneratedPlaylistV2 | null>(null);
  const [variant, setVariant] = useState(0);
  const [sound, setSound] = useState<{ minutes: number; streakDays?: number; skipRate?: number; topArtist?: string; topArtistPlays?: number; streams: number } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [ledger, legacy] = await Promise.all([
          mindbeat.stats().catch(() => null),
          getStats().catch(() => null as ListeningStats | null),
        ]);
        const ledgerUsable = !!ledger && (ledger.streams ?? 0) > 0;
        const top = ledgerUsable ? ledger?.topArtists?.[0] : legacy?.topArtists?.[0];
        setSound({
          minutes: ledgerUsable ? (ledger!.minutes ?? 0) : (legacy?.minutesEstimate ?? 0),
          streakDays: ledgerUsable ? ledger?.streakDays : undefined,
          skipRate: ledgerUsable ? ledger?.skipRate : undefined,
          topArtist: (top as { artist?: string } | undefined)?.artist,
          topArtistPlays: (top as { plays?: number } | undefined)?.plays,
          streams: ledgerUsable ? (ledger!.streams ?? 0) : (legacy?.totalPlays ?? 0),
        });
      } catch {
        setSound(null);
      }
    })();
  }, []);

  const run = useCallback(
    async (text: string, v = 0) => {
      const p = text.trim();
      if (!p || busy) return;
      Keyboard.dismiss();
      setResult(null);
      setBusy(true);
      setStage(0);
      try {
        const generated = await generatePlaylistV2(
          { search: (q, limit) => searchSaavnClean(q, limit) },
          p,
          (s) => setStage(PHASE_TO_STAGE[s.phase] ?? 0),
          v,
        );
        let final = generated;
        if (final.tracks.length < 8) {
          const legacy = await generatePlaylist(p);
          if (legacy.tracks.length > final.tracks.length) {
            final = { ...final, name: legacy.name, description: legacy.description, tracks: legacy.tracks };
          }
        }
        if (!final.tracks.length) {
          toast.show({ message: 'NO SONGS MATCHED — TRY DIFFERENT WORDS', icon: 'alert-circle' });
          setStage(5);
          setBusy(false);
          return;
        }
        if (v > 0) void mindbeat.ledgerApi?.aiRegenerated(`h${hash32(p)}`, v);
        setResult(final);
        setVariant(v);
        toast.show({ message: `DISPATCH FILED — ${final.name.toUpperCase()}`, icon: 'checkmark-circle' });
      } catch {
        toast.show({ message: 'NETWORK HICCUP — TRY AGAIN', icon: 'cloud-offline' });
      } finally {
        setStage(5);
        setBusy(false);
      }
    },
    [busy, toast],
  );

  const save = useCallback(async () => {
    if (!result) return;
    try {
      await createPlaylist(result.name, result.tracks);
      toast.show({ message: `SAVED — ${result.name.toUpperCase()}`, icon: 'checkmark-circle' });
      void mindbeat.ledgerApi?.aiPlaylistSaved(result.name, `h${hash32(prompt)}`);
    } catch {
      toast.show({ message: 'COULD NOT SAVE', icon: 'alert-circle' });
    }
  }, [result, toast, prompt]);

  const playAll = (shuffle: boolean) => {
    if (!result?.tracks.length) return;
    const list = shuffle ? [...result.tracks].sort(() => Math.random() - 0.5) : result.tracks;
    playQueue(list, 0, 'ai_playlist');
    nav.navigate('Player');
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={{ paddingBottom: 150 }} keyboardShouldPersistTaps="handled">
        {/* ── ai-hero ── */}
        <View style={styles.hero}>
          <View style={styles.kickInline}>
            <PulseDot size={8} />
            <MonoText size={9.5} bold color={colors.orangeDeep} style={{ letterSpacing: 2.2 }}>
              MINDBEAT WIRE SERVICE · ON DEVICE · NEVER UPLOADED
            </MonoText>
          </View>
          <Text style={styles.heroTitle}>
            File a vibe.{'\n'}
            <OutlineText style={styles.heroOutline}>Get the mix.</OutlineText>
          </Text>
          <MonoText size={11} color={colors.ink60} style={{ lineHeight: 17, letterSpacing: 0.3, marginTop: 10 }}>
            The wire desk reads your ledger — every play, skip and save — then files a narrated 25-track dispatch. Computed locally in under 35 ms.
          </MonoText>
        </View>

        {/* ── input ── */}
        <View style={styles.inputRow}>
          <View style={styles.field}>
            <Ionicons name="sparkles-outline" size={16} color={colors.ink60} />
            <TextInput
              style={styles.input}
              placeholder="E.G. PUNJABI GYM BANGERS"
              placeholderTextColor={colors.ink40}
              value={prompt}
              onChangeText={setPrompt}
              returnKeyType="go"
              onSubmitEditing={() => run(prompt)}
              editable={!busy}
              autoCapitalize="none"
            />
          </View>
          <Brutal
            onPress={() => (prompt.trim() ? run(prompt, variant + (result ? 1 : 0)) : toast.show({ message: 'FILE A VIBE FIRST' }))}
            onInk
            shadow={3}
            haptic
            disabled={busy}
            style={[styles.send, busy && { opacity: 0.5 }]}
          >
            <Ionicons name="arrow-forward" size={17} color={colors.acid} />
          </Brutal>
        </View>

        {/* ── idea chips ── */}
        <View style={styles.ideas}>
          {PROMPT_IDEAS.slice(0, 5).map((idea) => (
            <Brutal
              key={idea}
              onPress={() => {
                setPrompt(idea);
                run(idea);
              }}
              shadow={2}
              haptic
              disabled={busy}
              style={styles.idea}
            >
              <MonoText size={10} bold color={colors.ink} style={{ letterSpacing: 0.4 }}>
                {idea}
              </MonoText>
            </Brutal>
          ))}
        </View>

        {/* ── pipeline (ink panel) ── */}
        {busy ? (
          <View style={styles.pipeline}>
            {STAGES.map((label, i) => {
              const done = stage > i;
              const active = stage === i;
              return (
                <View key={label} style={[styles.pipeRow, (active || done) && { opacity: 1 }]}>
                  <MonoText size={10.5} bold color={active ? colors.acid : done ? colors.onInk : 'rgba(244,241,234,0.36)'} style={{ letterSpacing: 1 }}>
                    {label}
                  </MonoText>
                  <MonoText size={9} bold color={active ? colors.orange : 'rgba(244,241,234,0.36)'}>
                    {done ? '✓ ' : ''}
                    {String(i + 1).padStart(2, '0')}
                  </MonoText>
                </View>
              );
            })}
          </View>
        ) : null}

        {/* ── result dispatch card ── */}
        {result && !busy ? (
          <Animated.View style={styles.result} pointerEvents="box-none">
            <View style={styles.arCard}>
              <View style={styles.arTop}>
                <Artwork uri={result.tracks[0]?.artwork} seed={result.tracks[0]?.id ?? 'ai'} size={76} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <MonoText size={8.5} bold color={colors.orange} style={{ letterSpacing: 1.6 }}>
                    MINDBEAT DISPATCH · GENERATED ON DEVICE
                  </MonoText>
                  <Text style={styles.arTitle} numberOfLines={2}>
                    {result.name}
                  </Text>
                  <MonoText size={9.5} color={colors.ink40} style={{ marginTop: 4 }}>
                    {result.tracks.length} of 25 tracks
                  </MonoText>
                </View>
                <Brutal onPress={() => playAll(false)} haptic style={styles.arPlay}>
                  <Ionicons name="play" size={16} color={colors.acid} />
                </Brutal>
              </View>
              <View style={styles.arNarr}>
                <MonoText size={10.5} color={colors.ink60} style={{ lineHeight: 17, letterSpacing: 0.3 }}>
                  {result.description}
                </MonoText>
              </View>
              <View style={styles.arActions}>
                <Brutal onPress={() => playAll(true)} shadow={2} haptic style={styles.arActionBtn}>
                  <MonoText size={10} bold color={colors.ink}>
                    SHUFFLE ▸
                  </MonoText>
                </Brutal>
                <Brutal onPress={save} shadow={2} haptic style={styles.arActionBtn}>
                  <MonoText size={10} bold color={colors.ink}>
                    SAVE TO CRATES
                  </MonoText>
                </Brutal>
              </View>
            </View>
            {result.tracks.map((t, i) => (
              <TrackRow
                key={t.id}
                track={t}
                index={i}
                onPress={() => {
                  playQueue(result.tracks, i, 'ai_playlist');
                  nav.navigate('Player');
                }}
              />
            ))}
          </Animated.View>
        ) : null}

        {/* ── Your Sound audit box ── */}
        <Pressable onPress={() => nav.navigate('Stats')} style={styles.yourSound}>
          <View style={styles.ysHead}>
            <MonoText size={10} bold color={colors.ink} style={{ letterSpacing: 2 }}>
              YOUR SOUND
            </MonoText>
            <MonoText size={10} bold color={colors.ink} style={{ letterSpacing: 2 }}>
              {sound?.streams ? `${sound.streams} STREAMS` : 'LEDGER WARMING UP'}
            </MonoText>
          </View>
          <View style={styles.ysGrid}>
            <View style={styles.ysCell}>
              <Text style={styles.ysNum}>{sound ? fmtMinutes(sound.minutes) : '0'}</Text>
              <MonoText size={8.5} bold color={colors.ink40} style={{ letterSpacing: 1.4, marginTop: 4 }}>
                MINUTES
              </MonoText>
            </View>
            <View style={[styles.ysCell, styles.ysCellMid]}>
              <Text style={styles.ysNum}>{sound?.streakDays != null ? `${sound.streakDays}D` : '0D'}</Text>
              <MonoText size={8.5} bold color={colors.ink40} style={{ letterSpacing: 1.4, marginTop: 4 }}>
                STREAK
              </MonoText>
            </View>
            <View style={styles.ysCell}>
              <Text style={styles.ysNum}>{sound?.skipRate != null ? `${Math.round(sound.skipRate)}%` : '0%'}</Text>
              <MonoText size={8.5} bold color={colors.ink40} style={{ letterSpacing: 1.4, marginTop: 4 }}>
                SKIP RATE
              </MonoText>
            </View>
          </View>
          <View style={styles.ysFoot}>
            <View style={styles.ysArtist}>
              <Text style={styles.ysArtistName} numberOfLines={1}>
                {sound?.topArtist ?? 'The ledger is listening'}
              </Text>
              <MonoText size={9.5} style={{ marginTop: 2 }} numberOfLines={1}>
                {sound?.topArtistPlays
                  ? `${sound.topArtistPlays} plays · full audit inside`
                  : 'LEDGER WARMING UP — PLAY SOMETHING TO FILE DATA'}
              </MonoText>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.ink40} />
          </View>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function fmtMinutes(mins: number): string {
  if (!mins) return '0';
  if (mins < 60) return `${mins}`;
  return `${Math.floor(mins / 60)}H${mins % 60 ? ` ${mins % 60}M` : ''}`;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  hero: {
    paddingHorizontal: 18,
    paddingTop: 24,
    paddingBottom: 6,
    borderBottomWidth: 2,
    borderBottomColor: colors.ink,
    marginHorizontal: 18,
  },
  kickInline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  heroTitle: {
    fontFamily: fonts.display,
    fontSize: 34,
    lineHeight: 33,
    color: colors.ink,
    textTransform: 'uppercase',
    marginTop: 10,
    letterSpacing: -0.2,
  },
  heroOutline: { fontSize: 34, lineHeight: 33 },
  inputRow: {
    flexDirection: 'row',
    gap: 9,
    marginHorizontal: 18,
    marginTop: 18,
  },
  field: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.paper,
    paddingHorizontal: 14,
    height: 47,
    ...{ shadowColor: colors.ink, shadowOpacity: 1, shadowRadius: 0, shadowOffset: { width: 4, height: 4 }, elevation: 4 },
  },
  input: {
    flex: 1,
    fontFamily: fonts.monoBold,
    fontSize: 11.5,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: colors.ink,
    paddingVertical: 0,
  },
  send: {
    width: 47,
    height: 47,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ideas: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 18,
    paddingTop: 14,
  },
  idea: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: colors.paper,
    borderWidth: 1.5,
    borderColor: colors.ink,
  },
  pipeline: {
    marginHorizontal: 18,
    marginTop: 20,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.ink,
  },
  pipeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(244,241,234,0.16)',
    opacity: 0.75,
  },
  result: { marginHorizontal: 18, marginTop: 20 },
  arCard: {
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.paper,
    ...{ shadowColor: colors.ink, shadowOpacity: 1, shadowRadius: 0, shadowOffset: { width: 6, height: 6 }, elevation: 6 },
    marginBottom: 6,
  },
  arTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 16,
    borderBottomWidth: 2,
    borderBottomColor: colors.ink,
  },
  arTitle: {
    fontFamily: fonts.display,
    fontSize: 19,
    color: colors.ink,
    textTransform: 'uppercase',
    marginTop: 4,
    lineHeight: 20,
  },
  arPlay: { width: 46, height: 46, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  arNarr: {
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderBottomWidth: 2,
    borderBottomColor: colors.ink,
  },
  arActions: { flexDirection: 'row', gap: 8, padding: 12 },
  arActionBtn: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    backgroundColor: colors.paper,
    borderWidth: 1.5,
    borderColor: colors.ink,
  },
  yourSound: {
    marginHorizontal: 18,
    marginVertical: 24,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.paper,
    ...{ shadowColor: colors.ink, shadowOpacity: 1, shadowRadius: 0, shadowOffset: { width: 5, height: 5 }, elevation: 5 },
  },
  ysHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: colors.ink,
    backgroundColor: colors.acid,
  },
  ysGrid: { flexDirection: 'row' },
  ysCell: { flex: 1, alignItems: 'center', paddingVertical: 15, paddingHorizontal: 6 },
  ysCellMid: {
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: colors.ink16,
  },
  ysNum: {
    fontFamily: fonts.display,
    fontSize: 19,
    color: colors.ink,
  },
  ysFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderTopWidth: 2,
    borderTopColor: colors.ink,
  },
  ysArtist: { flex: 1, minWidth: 0 },
  ysArtistName: {
    fontFamily: fonts.bold,
    fontSize: 13,
    color: colors.ink,
    textTransform: 'uppercase',
  },
});
