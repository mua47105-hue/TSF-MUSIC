/**
 * Onboarding (§9.9) — Spotify-faithful first run, v3.2.
 *
 * Step 1  "What's your name?"        — signup-style name capture
 * Step 2  "Choose 3 or more artists you like." — REAL artist photos:
 *         48 curated A-lister seeds (verified JioSaavn portraits, instant)
 *         + "More" chunks (seeds → live category batches: Bollywood,
 *         Punjabi, Hip-Hop, Romance, Indie, Sufi, Retro, Pop) + artist
 *         search with photos. Photo-less artists get an initials circle.
 * Step 3  "What kind of music do you like?" — colorful genre tiles.
 *
 * v3.2 persistence (end-to-end fix — the re-ask bug):
 *  • Gate awaits mindbeat.ready() BEFORE reading onboardingDone (the old
 *    race read kv before the SQLite store opened → null → re-ask).
 *  • The done-flag is dual-written: mindbeat kv AND plain AsyncStorage
 *    (tsf.onboardingDone) — either satisfies the gate, so even a broken
 *    ledger can never re-trap the user.
 *  • Progress (step/name/picks/genres) is checkpointed to AsyncStorage on
 *    every step change — a kill mid-flow resumes where it left off.
 *  • finish() awaits BOTH durable writes before closing the modal.
 *
 * Feeds MINDBEAT instantly: artists → weight 3.0 seeds, genres → 2.2 hints.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ARTIST_CATEGORIES,
  ARTIST_SEEDS,
  getArtistPhoto,
  searchSaavnArtists,
  type ArtistInfo,
} from '../api/artists';
import { useStableField } from '../hooks/useStableField';
import { mindbeat } from '../ai/mindbeat';
import { Artwork } from './Artwork';
import { Brutal, MonoText } from './Brutal';
import { PressableScale } from './PressableScale';
import { colors, fonts } from '../theme';

/**
 * Genre tiles — keys match GENRE_PRIORS so affinity lines up exactly.
 * Palette rotated for pairwise separability and bottom-scrimmed for
 * WCAG-large label contrast.
 */
const GENRES: Array<{ key: string; label: string; icon: keyof typeof Ionicons.glyphMap; from: string; to: string }> = [
  { key: 'bollywood', label: 'Bollywood', icon: 'film', from: '#e13300', to: '#ff8a00' },
  { key: 'punjabi', label: 'Punjabi', icon: 'musical-notes', from: '#ca8a04', to: '#facc15' },
  { key: 'indie', label: 'Indie', icon: 'leaf', from: '#158a56', to: '#1ed760' },
  { key: 'rap', label: 'Hip-Hop', icon: 'mic', from: '#6d28d9', to: '#a21caf' },
  { key: 'pop', label: 'Pop', icon: 'sparkles', from: '#db2777', to: '#f472b6' },
  { key: 'sufi', label: 'Sufi & Qawwali', icon: 'infinite', from: '#1e1b4b', to: '#4338ca' },
  { key: 'retro', label: 'Retro', icon: 'time', from: '#7c2d12', to: '#a16207' },
  { key: 'romantic', label: 'Romantic', icon: 'heart', from: '#e11d48', to: '#fb7185' },
  { key: 'lofi', label: 'Lofi & Chill', icon: 'headset', from: '#0f172a', to: '#475569' },
  { key: 'workout', label: 'Workout', icon: 'barbell', from: '#b91c1c', to: '#ef4444' },
  { key: 'ghazal', label: 'Ghazal', icon: 'book', from: '#4c1d95', to: '#7c3aed' },
  { key: 'devotional', label: 'Devotional', icon: 'flower', from: '#c2410c', to: '#fb923c' },
];

const MIN_ARTISTS = 3;
const MAX_ARTISTS = 12;
const SEED_CHUNK = 15; // artists per "More" expansion (seeds are instant)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Mirrors WhatsNewDialog's dismissal flag (plain AsyncStorage). */
const whatsNewDismissed = async (): Promise<boolean> => {
  try {
    return (await AsyncStorage.getItem('tsf.whatsNewDismissed')) != null;
  } catch {
    return true; // storage unavailable → don't trap the user
  }
};

interface Progress {
  step: 'artists' | 'genres';
  name: string;
  picked: string[];
  genres: string[];
}

type Step = 'name' | 'artists' | 'genres';

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState<Step>('name');

  // collected answers
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [genres, setGenres] = useState<Set<string>>(new Set());

  // artist catalog state
  const [shownCount, setShownCount] = useState(SEED_CHUNK);
  const [livePool, setLivePool] = useState<ArtistInfo[]>([]);
  const [catIdx, setCatIdx] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState('');
  // Uncontrolled field (v4.0.1): the artist-search box used a controlled
  // value prop that raced result-grid re-renders and duplicated fast
  // keystrokes — the same class as the SearchScreen "hihiz" bug.
  const field = useStableField({ onCommit: setQuery });
  const [searchHits, setSearchHits] = useState<ArtistInfo[] | null>(null);
  const [nameFocus, setNameFocus] = useState(false);
  const nameInput = useRef<TextInput>(null);

  const { width: winW } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  /** Checkpoint progress so a mid-flow kill resumes instead of restarting. */
  const checkpoint = (s: Step, n: string, p: Set<string>, g: Set<string>) => {
    if (s === 'name') return;
    const prog: Progress = { step: s, name: n, picked: [...p], genres: [...g] };
    AsyncStorage.setItem('tsf.onboardingProgress', JSON.stringify(prog)).catch(() => undefined);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // ① Wait for the ledger store to OPEN before reading the flag — the
      //    v3.1 bug read kv during async init (store null → "not done").
      await Promise.race([mindbeat.ready(), sleep(4000)]);
      if (cancelled) return;
      // ② Dual-source done flag: kv OR plain AsyncStorage (belt + braces).
      let done = false;
      try {
        done =
          (await mindbeat.kvGet<boolean>('onboardingDone')) === true ||
          (await AsyncStorage.getItem('tsf.onboardingDone')) != null;
      } catch {
        done = false;
      }
      if (done || cancelled) return;
      // ③ Resume a killed mid-flow run (progress checkpoint).
      try {
        const raw = await AsyncStorage.getItem('tsf.onboardingProgress');
        if (raw) {
          const p = JSON.parse(raw) as Progress;
          setName(p.name ?? '');
          setPicked(new Set(p.picked ?? []));
          setGenres(new Set(p.genres ?? []));
          if (p.step === 'genres' || p.step === 'artists') setStep(p.step);
        }
      } catch {
        /* fresh start */
      }
      // ④ Fresh installs also show the What's-new dialog first — wait for
      //    its dismissal so the two modals never stack (600ms polls, 30s cap).
      if (!(await whatsNewDismissed())) {
        for (let i = 0; i < 50 && !cancelled; i++) {
          await sleep(600);
          if (await whatsNewDismissed()) break;
        }
      }
      if (!cancelled) setVisible(true);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const doSearch = async () => {
    const q = field.getValue().trim();
    if (!q) {
      setSearchHits(null);
      return;
    }
    setSearchHits([]); // spinner state
    try {
      const found = await searchSaavnArtists(q, 36);
      setSearchHits(found);
      // Enrich photo-less hits via artist-id lookups (top 6, parallel).
      const missing = found.filter((a) => !a.image && a.id).slice(0, 6);
      missing.forEach((a) => {
        getArtistPhoto(a.id)
          .then((img) => {
            if (img) setSearchHits((prev) => (prev ? prev.map((x) => (x.id === a.id ? { ...x, image: img } : x)) : prev));
          })
          .catch(() => undefined);
      });
    } catch {
      setSearchHits([]);
    }
  };

  /** Spotify's grid-end "More" tile — seeds first (instant), then live
   *  category batches (Bollywood → Punjabi → Hip-Hop → …), endlessly. */
  const loadMore = async () => {
    if (loadingMore) return;
    if (shownCount < ARTIST_SEEDS.length) {
      setShownCount((c) => Math.min(c + SEED_CHUNK, ARTIST_SEEDS.length));
      return;
    }
    if (catIdx >= ARTIST_CATEGORIES.length) return;
    setLoadingMore(true);
    try {
      const cat = ARTIST_CATEGORIES[catIdx]!;
      const found = await searchSaavnArtists(cat.query, 12);
      setLivePool((prev) => {
        // dedupe against the FULL seed list (not just the shown chunk) so a
        // later seed expansion can never re-introduce the same artist.
        const seen = new Set<string>([
          ...ARTIST_SEEDS.map((a) => a.name.toLowerCase()),
          ...prev.map((a) => a.name.toLowerCase()),
        ]);
        return [...prev, ...found.filter((a) => !seen.has(a.name.toLowerCase()))];
      });
      setCatIdx((i) => i + 1);
    } catch {
      setCatIdx((i) => i + 1); // skip a broken category, keep the grid moving
    } finally {
      setLoadingMore(false);
    }
  };

  const toggleArtist = (artist: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(artist)) next.delete(artist);
      else if (next.size < MAX_ARTISTS) next.add(artist);
      return next;
    });
  };

  const toggleGenre = (key: string) => {
    setGenres((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /** Finish — durable writes FIRST (AsyncStorage + kv), then close.
   *  The AsyncStorage flag is written before anything else so no failure
   *  downstream can ever re-trap the user in onboarding. */
  const finish = async () => {
    const cleanName = name.trim().slice(0, 24);
    try {
      await AsyncStorage.setItem('tsf.onboardingDone', '1');
      await AsyncStorage.removeItem('tsf.onboardingProgress');
      if (cleanName) await AsyncStorage.setItem('tsf.userName', cleanName);
    } catch {
      /* even if this fails, try the kv write below */
    }
    try {
      await mindbeat.ready();
      if (cleanName) await mindbeat.kvSet('userName', cleanName);
      await mindbeat.setOnboardingSeeds([...picked], [...genres]);
      await mindbeat.kvSet('onboardingDone', true);
    } catch {
      /* best-effort — the AsyncStorage flag already guarantees no re-ask */
    }
    setVisible(false);
    onDone();
  };

  const goStep = (s: Step) => {
    checkpoint(s, name, picked, genres);
    setStep(s);
  };

  /** The grid: seeds (chunked) + live batches, or search hits. */
  const shown = useMemo(() => {
    if (searchHits) return searchHits;
    const base = ARTIST_SEEDS.slice(0, shownCount);
    const seen = new Set(ARTIST_SEEDS.map((a) => a.name.toLowerCase()));
    const live = livePool.filter((a) => !seen.has(a.name.toLowerCase()));
    return [...base, ...live];
  }, [searchHits, shownCount, livePool]);

  const moreLabel =
    shownCount < ARTIST_SEEDS.length
      ? 'More artists'
      : catIdx < ARTIST_CATEGORIES.length
        ? `More ${ARTIST_CATEGORIES[catIdx]!.label}`
        : '';
  const inSearch = !!searchHits;

  if (!visible) return null;

  const tileW = Math.floor((winW - 32 - 20) / 3);
  const artistsReady = picked.size >= MIN_ARTISTS;
  const ctaLabel =
    step === 'artists'
      ? picked.size === 0
        ? `Choose ${MIN_ARTISTS} artists`
        : picked.size < MIN_ARTISTS
          ? `Choose ${MIN_ARTISTS - picked.size} more`
          : 'Continue'
      : genres.size === 0
        ? 'Pick at least one'
        : 'Continue';
  const ctaDisabled = step === 'artists' ? !artistsReady : genres.size === 0;

  return (
    <Modal visible transparent={false} animationType="fade" onRequestClose={() => undefined}>
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        {step === 'name' ? (
          <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={styles.nameWrap}>
              {/* the broadsheet nameplate */}
              <View style={styles.logo}>
                <Text style={styles.logoText}>TSF·MUSIC</Text>
                <MonoText size={8} bold color={colors.onInk60} style={{ letterSpacing: 2.4, marginTop: 5 }}>
                  PULSE EDITION
                </MonoText>
              </View>
              <Text style={styles.bigTitle}>What&apos;s your name?</Text>
              <MonoText size={10} color={colors.ink60} style={{ textAlign: 'center', lineHeight: 16, letterSpacing: 0.6 }}>
                YOUR NAME SHAPES YOUR MIXES, STATS AND WIRE DISPATCHES.
              </MonoText>
              <View style={[styles.inputWrap, nameFocus && styles.inputWrapFocus]}>
                <TextInput
                  testID="onb-name-input"
                  ref={nameInput}
                  autoFocus
                  style={styles.input as never}
                  placeholder="YOUR NAME"
                  placeholderTextColor={colors.ink40}
                  value={name}
                  onChangeText={setName}
                  maxLength={24}
                  returnKeyType="done"
                  onSubmitEditing={() => name.trim() && goStep('artists')}
                  onFocus={() => setNameFocus(true)}
                  onBlur={() => setNameFocus(false)}
                  selectionColor={colors.orange}
                />
              </View>
            </View>
            <View style={[styles.footer, { paddingBottom: Math.max(24, insets.bottom + 8) }]}>
              <Brutal
                testID="onb-continue"
                haptic
                disabled={!name.trim()}
                onInk
                shadow={4}
                onPress={() => goStep('artists')}
                style={name.trim() ? styles.cta : styles.ctaDim}
              >
                <MonoText size={11.5} bold color={colors.acid} style={{ letterSpacing: 2 }}>
                  CONTINUE ▸
                </MonoText>
              </Brutal>
            </View>
          </KeyboardAvoidingView>
        ) : step === 'artists' ? (
          <View style={styles.flex}>
            <View style={styles.topBar}>
              <Brutal haptic shadow={0} pressOffset={1} onPress={() => goStep('name')} style={styles.backBtn} accessibilityLabel="Back">
                <Ionicons name="chevron-back" size={16} color={colors.ink} />
              </Brutal>
              <MonoText size={9.5} bold color={colors.ink60} style={{ flex: 1, textAlign: 'center', letterSpacing: 2 }}>
                {`PICKED ${picked.size} · MIN ${MIN_ARTISTS}`}
              </MonoText>
              <View style={{ width: 38 }} />
            </View>
            <Text style={styles.stepTitle}>Choose 3 or more artists you like.</Text>
            <View style={styles.searchWrap}>
              <Ionicons name="search" size={16} color={colors.ink60} />
              <TextInput
                testID="onb-search"
                ref={field.inputRef}
                style={styles.searchInput as never}
                placeholder="SEARCH ARTISTS"
                placeholderTextColor={colors.ink40}
                onChangeText={(t) => {
                  field.handleChange(t);
                  if (!t.trim()) setSearchHits(null);
                }}
                returnKeyType="search"
                onSubmitEditing={doSearch}
                selectionColor={colors.orange}
              />
              {query.length > 0 ? (
                <PressableScale haptic onPress={() => { field.setValue(''); setSearchHits(null); }} hitSlop={8}>
                  <Ionicons name="close" size={16} color={colors.ink60} />
                </PressableScale>
              ) : null}
            </View>
            <ScrollView contentContainerStyle={styles.gridPad} showsVerticalScrollIndicator={false}>
              {searchHits && searchHits.length === 0 ? (
                <View style={styles.loadingWrap}>
                  <MonoText size={10} color={colors.ink60} style={{ letterSpacing: 1 }}>
                    {`NO ARTISTS FOUND FOR "${query.trim().toUpperCase()}"`}
                  </MonoText>
                </View>
              ) : (
                <View style={styles.grid}>
                  {shown.map((a) => {
                    const on = picked.has(a.name);
                    const dim = picked.size > 0 && !on;
                    return (
                      <PressableScale
                        key={a.name}
                        testID="onb-artist"
                        haptic
                        onPress={() => toggleArtist(a.name)}
                        accessibilityState={{ selected: on }}
                        style={[styles.artistCell, { width: tileW, opacity: dim ? 0.4 : 1 }]}
                      >
                        <View style={styles.artWrap}>
                          <Artwork uri={a.image} seed={a.name} initials={a.name} size={tileW} />
                          {on ? (
                            <>
                              <View style={styles.ring} />
                              <View style={styles.checkBadge}>
                                <Ionicons name="checkmark" size={13} color={colors.ink} />
                              </View>
                            </>
                          ) : null}
                        </View>
                        <Text style={styles.artistName} numberOfLines={2}>
                          {a.name.toUpperCase()}
                        </Text>
                      </PressableScale>
                    );
                  })}
                  {!inSearch && moreLabel ? (
                    <PressableScale
                      testID="onb-more"
                      haptic
                      onPress={() => void loadMore()}
                      accessibilityLabel={moreLabel}
                      style={[styles.artistCell, { width: tileW }]}
                    >
                      <View style={[styles.moreSquare, { width: tileW, height: tileW }]}>
                        {loadingMore ? (
                          <ActivityIndicator color={colors.ink} />
                        ) : (
                          <Text style={styles.moreText} numberOfLines={2}>
                            {moreLabel.replace('More ', 'More\n').toUpperCase()}
                          </Text>
                        )}
                      </View>
                      <Text style={styles.artistName} numberOfLines={2}>
                        {' '}
                      </Text>
                    </PressableScale>
                  ) : null}
                </View>
              )}
            </ScrollView>
            <View style={[styles.footer, { paddingBottom: Math.max(24, insets.bottom + 8) }]}>
              <Brutal
                testID="onb-continue"
                haptic
                disabled={!artistsReady}
                onInk
                shadow={4}
                onPress={() => goStep('genres')}
                style={artistsReady ? styles.cta : styles.ctaDim}
              >
                <MonoText size={11.5} bold color={colors.acid} style={{ letterSpacing: 2 }}>
                  {ctaLabel.toUpperCase()}
                </MonoText>
              </Brutal>
              <PressableScale haptic onPress={() => goStep('genres')} style={styles.skip} hitSlop={12}>
                <MonoText size={10} bold color={colors.ink60} style={{ letterSpacing: 1.6 }}>
                  SKIP
                </MonoText>
              </PressableScale>
            </View>
          </View>
        ) : (
          <View style={styles.flex}>
            <View style={styles.topBar}>
              <Brutal haptic shadow={0} pressOffset={1} onPress={() => goStep('artists')} style={styles.backBtn} accessibilityLabel="Back">
                <Ionicons name="chevron-back" size={16} color={colors.ink} />
              </Brutal>
              <MonoText size={9.5} bold color={colors.ink60} style={{ flex: 1, textAlign: 'center', letterSpacing: 2 }}>
                {`PICKED ${genres.size}`}
              </MonoText>
              <View style={{ width: 38 }} />
            </View>
            <Text style={styles.stepTitle}>What kind of music do you like?</Text>
            <ScrollView contentContainerStyle={styles.gridPad} showsVerticalScrollIndicator={false}>
              <View style={styles.genreGrid}>
                {GENRES.map((g) => {
                  const on = genres.has(g.key);
                  return (
                    <PressableScale
                      key={g.key}
                      testID="onb-genre"
                      haptic
                      onPress={() => toggleGenre(g.key)}
                      accessibilityState={{ selected: on }}
                      style={[styles.genreTile, { width: (winW - 36 - 12) / 2 }, on && styles.genreTileOn]}
                    >
                      <LinearGradient
                        colors={[g.from, g.to]}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                        style={StyleSheet.absoluteFill}
                      />
                      <Text style={styles.genreLabel}>{g.label.toUpperCase()}</Text>
                      <View style={styles.genreIcon}>
                        <Ionicons name={g.icon} size={34} color="rgba(22,21,19,0.85)" />
                      </View>
                      {on ? (
                        <View style={styles.genreCheck}>
                          <Ionicons name="checkmark" size={13} color={colors.ink} />
                        </View>
                      ) : null}
                    </PressableScale>
                  );
                })}
              </View>
            </ScrollView>
            <View style={[styles.footer, { paddingBottom: Math.max(24, insets.bottom + 8) }]}>
              <Brutal
                testID="onb-continue"
                haptic
                disabled={ctaDisabled}
                onInk
                shadow={4}
                onPress={() => void finish()}
                style={ctaDisabled ? styles.ctaDim : styles.cta}
              >
                <MonoText size={11.5} bold color={colors.acid} style={{ letterSpacing: 2 }}>
                  {ctaLabel.toUpperCase()}
                </MonoText>
              </Brutal>
              <PressableScale haptic onPress={() => void finish()} style={styles.skip} hitSlop={12}>
                <MonoText size={10} bold color={colors.ink60} style={{ letterSpacing: 1.6 }}>
                  SKIP
                </MonoText>
              </PressableScale>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  flex: { flex: 1 },
  // — step: name —
  nameWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, gap: 12 },
  logo: {
    backgroundColor: colors.ink,
    paddingHorizontal: 20,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 10,
    ...({ shadowColor: colors.orange, shadowOpacity: 1, shadowRadius: 0, shadowOffset: { width: 4, height: 4 }, elevation: 4 } as object),
  },
  logoText: { color: colors.paper, fontFamily: fonts.display, fontSize: 22, letterSpacing: 0.5 },
  bigTitle: {
    color: colors.ink,
    fontFamily: fonts.display,
    fontSize: 26,
    textAlign: 'center',
    textTransform: 'uppercase',
    lineHeight: 27,
  },
  inputWrap: {
    width: '100%',
    backgroundColor: colors.paper,
    borderWidth: 2,
    borderColor: colors.ink,
    marginTop: 10,
    ...({ shadowColor: colors.ink, shadowOpacity: 1, shadowRadius: 0, shadowOffset: { width: 4, height: 4 }, elevation: 4 } as object),
  },
  inputWrapFocus: {
    ...({ shadowColor: colors.orange, shadowOpacity: 1, shadowRadius: 0, shadowOffset: { width: 4, height: 4 }, elevation: 4 } as object),
  },
  input: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: colors.ink,
    fontSize: 13,
    fontFamily: fonts.monoBold,
    letterSpacing: 1,
    textTransform: 'uppercase',
    outlineWidth: 0,
  } as never,
  // — shared chrome —
  topBar: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    borderBottomWidth: 2,
    borderBottomColor: colors.ink,
  },
  backBtn: {
    width: 38,
    height: 38,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.paper,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepTitle: {
    color: colors.ink,
    fontFamily: fonts.display,
    fontSize: 20,
    textAlign: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    textTransform: 'uppercase',
    lineHeight: 22,
  },
  footer: { padding: 18, gap: 8, backgroundColor: colors.paper, borderTopWidth: 2, borderTopColor: colors.ink },
  cta: {
    backgroundColor: colors.ink,
    paddingVertical: 16,
    alignItems: 'center',
  },
  ctaDim: {
    backgroundColor: colors.ink40,
    paddingVertical: 16,
    alignItems: 'center',
  },
  skip: { alignItems: 'center', paddingVertical: 6 },
  // — step: artists —
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.paper,
    borderWidth: 2,
    borderColor: colors.ink,
    marginHorizontal: 18,
    paddingHorizontal: 14,
    height: 44,
  },
  searchInput: { flex: 1, color: colors.ink, fontSize: 12, fontFamily: fonts.monoBold, letterSpacing: 1, textTransform: 'uppercase', outlineWidth: 0 } as never,
  loadingWrap: { paddingVertical: 60, alignItems: 'center' },
  gridPad: { padding: 18, paddingBottom: 150 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  artistCell: { alignItems: 'center' },
  artWrap: { position: 'relative' },
  ring: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 2.5,
    borderColor: colors.orange,
  },
  checkBadge: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 24,
    height: 24,
    backgroundColor: colors.acid,
    borderWidth: 1.5,
    borderColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  artistName: {
    color: colors.ink,
    fontSize: 11,
    fontFamily: fonts.bold,
    textAlign: 'center',
    marginTop: 7,
    height: 30,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  moreSquare: {
    backgroundColor: colors.orange,
    borderWidth: 1.5,
    borderColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 10,
  },
  moreText: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '800',
    fontFamily: fonts.display,
    textAlign: 'center',
    lineHeight: 16,
    textTransform: 'uppercase',
  },
  // — step: genres —
  genreGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  genreTile: {
    aspectRatio: 1.75,
    overflow: 'hidden',
    padding: 12,
    justifyContent: 'flex-end',
    borderWidth: 1.5,
    borderColor: colors.ink,
  },
  genreTileOn: {
    borderWidth: 3,
    borderColor: colors.ink,
    ...({ shadowColor: colors.orange, shadowOpacity: 1, shadowRadius: 0, shadowOffset: { width: 3, height: 3 }, elevation: 3 } as object),
  },
  genreLabel: { color: colors.ink, fontSize: 13, fontWeight: '900', fontFamily: fonts.display, textTransform: 'uppercase' },
  genreIcon: { position: 'absolute', top: 8, right: 10, opacity: 0.9 },
  genreCheck: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    backgroundColor: colors.acid,
    borderWidth: 1.5,
    borderColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
