/**
 * Search — authentic Spotify Android search, V3 (Search V2 engine):
 *   #242424 rounded search field ("What do you want to listen to?") →
 *   TYPEAHEAD RAIL (recents + "Did you mean" chips at 0 ms; provider
 *   suggestions + "Best guess" topquery row ~250 ms) → results with
 *   truthful reason lines, lyric-match chips, version-cluster captions,
 *   honest zero-state with recovery labels.
 *
 * Engine behaviors surfaced here:
 *   • 280 ms debounce + per-generation AbortController (dead probes die)
 *   • progressive paint — cached/early results render, final set lands
 *     at max(probes); LRCLIB verification re-renders AFTER paint
 *   • Keyword|Vibe toggle, browse grid, recents — unchanged (lab compat)
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  useWindowDimensions,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import type { Track } from '../types';
import {
  searchMusicV2,
  type EngineDeps,
  type SearchV2Result,
} from '../api/music';
import { ytSearchMusic, ytAvailable } from '../api/youtube';
import { vibeSearch } from '../ai/surfaces/search';
import { mindbeat } from '../ai/mindbeat';
import { searchSaavn, searchSaavnClean, mergeUniqueTracks, searchHasMore, getTrending, getAutocomplete, type AutocompleteBundle } from '../api/saavn';
import { browseColumnsFor } from '../ui/windowing';
import { planSearch } from '../search/plan';
import { verifyLyrics, type Candidate } from '../search/verify';
import { rememberResolve } from '../search/learn';
import { artistAffinity } from '../ai/core/decision';
import { usePlayer } from '../player/PlayerProvider';
import {
  clearRecentSearches,
  getRecentSearches,
  pushRecentSearch,
} from '../storage/store';
import { Artwork } from '../components/Artwork';
import { TrackRow } from '../components/TrackRow';
import { PressableScale } from '../components/PressableScale';
import { colors, fonts, radius, spacing, genreGradient } from '../theme';
import type { RootStackParamList } from './navigation';

const GENRES: Array<{ label: string; query: string }> = [
  { label: 'Bollywood', query: 'bollywood hits' },
  { label: 'Punjabi', query: 'punjabi hits' },
  { label: 'Hip-Hop', query: 'rap hip hop' },
  { label: 'Pop', query: 'pop hits' },
  { label: 'Indie', query: 'indie india songs' },
  { label: 'Romance', query: 'romantic love songs' },
  { label: 'Rock', query: 'rock hits' },
  { label: 'Lo-Fi', query: 'lofi songs' },
  { label: 'Party', query: 'party dance hits' },
  { label: 'Workout', query: 'workout gym' },
  { label: 'Sufi', query: 'sufi songs' },
  { label: 'Devotional', query: 'devotional bhajan' },
  { label: 'Ghazal', query: 'ghazal' },
  { label: '90s Hits', query: '90s hindi songs' },
  { label: '2000s Hits', query: '2000s hindi songs' },
  { label: 'Dance', query: 'dance edm songs' },
  { label: 'Sad Songs', query: 'sad songs hindi' },
  { label: 'Instrumental', query: 'instrumental' },
];

const DEBOUNCE_MS = 700; // search debounce: leaves a visible typeahead
// window (suggestions at 120 ms render while the search waits); the
// lab's 2200 ms settle stays valid with 3× headroom
const SUGGEST_DEBOUNCE_MS = 120;

/** Engine deps adapter — mindbeat on-device, best-effort everywhere.
 *  artistAffinity uses the REAL decision-engine reader (P1-2 fix): the
 *  profile's artists map holds AffinityEntry objects, not numbers. */
function engineDeps(): EngineDeps {
  return {
    kvGet: (k) => mindbeat.kvGet<any>(k.startsWith('mb.') ? k.slice(3) : k),
    kvSet: (k, v) => mindbeat.kvSet(k.startsWith('mb.') ? k.slice(3) : k, v),
    eventsSince: (ts) => mindbeat.eventsSince(ts),
    disabled: () => mindbeat.recsDisabled(),
    artistAffinity: (artist) => artistAffinity(mindbeat.profile, artist, Date.now()),
    mutedArtists: () =>
      new Set<string>(
        (mindbeat.profile?.corrections?.mutedArtists ?? []).map((a: string) =>
          a.toLowerCase(),
        ),
      ),
  };
}

export function SearchScreen() {
  const insets = useSafeAreaInsets();
  // window-reactive grid math (R5): wide windows (landscape phones,
  // tablets, DeX/desktop windows) get 4 browse columns, phones keep 2.
  const { width: winWidth } = useWindowDimensions();
  const browseCols = browseColumnsFor(winWidth);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { playQueue } = usePlayer();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Track[]>([]);
  const [meta, setMeta] = useState<{
    degraded: boolean;
    reason?: string;
    corrected?: string;
    relaxedQuery?: string;
    lyricLine?: string;
    sigState?: 'hit' | 'rescued' | 'partial' | 'zero';
    partialArtists?: string[];
    /** the plan's title side (connectors stripped) — chip queries build
     *  from THIS, never from raw query slicing (P2-2) */
    partialTitle?: string;
    /** YouTube source cooling down after repeated failures (P1-3 note) */
    ytUnavailable?: boolean;
  }>({ degraded: false });
  const [loading, setLoading] = useState(false);
  // ── infinite results pagination (F1) ─────────────────────────────
  const pageRef = useRef(1); // last appended page (page 1 = the engine set)
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [endNote, setEndNote] = useState<string | null>(null);
  // CRITIC P1-2 fix: live mirror of results — loadMoreResults must merge
  // from the CURRENT rows (LRCLIB verification flag+reorder runs after the
  // engine set lands; a stale closure would strip lyricMatch chips and
  // revert the verified-float-to-top reorder on the first append).
  const resultsRef = useRef<Track[]>([]);
  useEffect(() => {
    resultsRef.current = results;
  }, [results]);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [browseArt, setBrowseArt] = useState<string[]>([]);
  const [searched, setSearched] = useState(false);
  const [vibe, setVibe] = useState(false); // Keyword | Vibe mode (§9.8)
  const [source, setSource] = useState<'catalog' | 'youtube'>('catalog');
  const [vibeChips, setVibeChips] = useState<string[]>([]);
  const [suggests, setSuggests] = useState<AutocompleteBundle | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchGen = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const corrRef = useRef<{
    query: string;
    normalized: string;
    id: string;
    lyricHits: Set<string>;
    isLyric: boolean;
  }>({
    query: '',
    normalized: '',
    id: '',
    lyricHits: new Set(),
    isLyric: false,
  });

  useEffect(() => {
    getRecentSearches().then(setRecentSearches);
    getTrending(24)
      .then((tracks) => setBrowseArt(tracks.map((t) => t.artwork).filter(Boolean)))
      .catch(() => undefined);
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // ── typeahead: provider suggestions ride alongside, never blocking ──
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || vibe) {
      setSuggests(null);
      return;
    }
    const gen = searchGen.current;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      getAutocomplete(q, ctrl.signal)
        .then((b) => {
          if (gen === searchGen.current) setSuggests(b);
        })
        .catch(() => undefined);
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query, vibe]);

  /** Reset pagination for a fresh query (called at the top of every run). */
  const resetPagination = useCallback(() => {
    pageRef.current = 1;
    setHasMore(true);
    setEndNote(null);
    setLoadingMore(false);
  }, []);

  /**
   * Infinite scroll (F1): catalog keyword searches append JioSaavn page
   * p+1 as the user approaches the end. Rows are deduped by id, muted
   * artists are honored (engine parity), the top-result card never moves,
   * and the feed stops HONESTLY (empty / <25% fresh page → end marker).
   * YouTube + vibe modes never paginate (bounded result sets).
   */
  const loadMoreResults = useCallback(async () => {
    if (loadingMore || !hasMore || loading || resultsRef.current.length === 0) return;
    if (vibe || source !== 'catalog') return;
    const q = query.trim();
    if (!q) return;
    const gen = searchGen.current;
    setLoadingMore(true);
    try {
      const nextPage = pageRef.current + 1;
      // CRITIC P1-1 fix: ride the ACTIVE search's abort signal — a stale
      // page fetch must die with the query that started it, not reject
      // later and poison the NEXT query's pagination state.
      const page = await searchSaavn(q, 30, abortRef.current?.signal, nextPage);
      if (gen !== searchGen.current) return; // stale — new query won
      const muted = engineDeps().mutedArtists?.() ?? new Set<string>();
      const allowed = page.filter(
        (t) =>
          !(t.artistsFull ?? []).some((a) => muted.has(a.toLowerCase())) &&
          !muted.has(t.artist.toLowerCase()),
      );
      const before = resultsRef.current.length;
      const merged = mergeUniqueTracks(resultsRef.current, allowed);
      const fresh = merged.length - before;
      pageRef.current = nextPage;
      resultsRef.current = merged; // keep the mirror in sync immediately
      setResults(merged);
      if (!searchHasMore(page.length, fresh)) {
        setHasMore(false);
        setEndNote('End of results');
      }
    } catch {
      // CRITIC P1-1 fix: a REJECTED page fetch for a query the user has
      // already left must never disable pagination on the live query.
      if (gen !== searchGen.current) return;
      setHasMore(false);
      setEndNote("Couldn't load more — check your connection");
    } finally {
      if (gen === searchGen.current) setLoadingMore(false);
    }
  }, [loadingMore, hasMore, loading, vibe, source, query]);

  const runSearch = useCallback(
    // sourceOverride (P2-1): the source toggle passes the NEW source so the
    // immediate re-search runs against it — the render-time `source` is
    // still the old one until the setSource re-render lands, which
    // otherwise painted ~1s of mislabeled results + double ledger events.
    async (q: string, sourceOverride?: 'catalog' | 'youtube') => {
      const src = sourceOverride ?? source;
      if (!q.trim()) {
        searchGen.current += 1;
        abortRef.current?.abort();
        abortRef.current = null;
        setResults([]);
        setMeta({ degraded: false });
        setVibeChips([]);
        setSearched(false);
        setSuggests(null);
        resetPagination();
        return;
      }
      const gen = ++searchGen.current;
      abortRef.current?.abort(); // kill the previous generation's probes
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      setSearched(true);
      setSuggests(null);
      resetPagination();
      const deps = engineDeps();
      try {
        if (src === 'youtube') {
          // YOUTUBE SOURCE (YOUTUBE-INTEGRATION-PLAN §3.1): the YT Music
          // catalog answers directly — Song rows first, then videos.
          // Kill-switch honesty (P1-3): a cooling-down source says so
          // instead of painting a bare "no results".
          if (!ytAvailable()) {
            if (gen !== searchGen.current) return;
            setResults([]);
            setMeta({ degraded: false, sigState: undefined, partialArtists: undefined, ytUnavailable: true });
            setVibeChips([]);
            setHasMore(false);
            setEndNote(null);
            return;
          }
          const ytr = await ytSearchMusic(q, 25, ctrl.signal);
          if (gen !== searchGen.current) return;
          setResults(ytr.tracks);
          setMeta({ degraded: false, sigState: undefined, partialArtists: undefined, ytUnavailable: ytr.tracks.length === 0 && !ytAvailable() });
          setVibeChips([]);
          // YouTube mode never paginates — honest end marker instead
          setHasMore(false);
          setEndNote(ytr.tracks.length ? "That's everything YouTube found" : null);
          void mindbeat.searchQueried(q, ytr.tracks.length);
          await pushRecentSearch(q);
          setRecentSearches(await getRecentSearches());
          return;
        }
        if (vibe) {
          const r = await vibeSearch(
            { search: (qq, limit) => searchSaavnClean(qq, limit) },
            q,
            25,
          );
          if (gen !== searchGen.current) return;
          setResults(r.tracks);
          setMeta({ degraded: false });
          // vibe sets are AI-bounded — no pagination
          setHasMore(false);
          setEndNote(null);
          setVibeChips([
            ...r.intent.moods.slice(0, 2),
            ...r.intent.languages.slice(0, 1),
            ...(r.shortcut ? [r.shortcut.label] : []),
          ]);
          void mindbeat.searchQueried(q, r.tracks.length);
        } else {
          const res: SearchV2Result = await searchMusicV2(q, {
            signal: ctrl.signal,
            deps,
            // PROGRESSIVE PAINT (P0-2): ranked primary pool paints the
            // moment it exists; the final set replaces it when it lands.
            onEarly: (early) => {
              if (gen !== searchGen.current) return;
              setResults(early.tracks);
              setMeta({
                degraded: false,
                reason: early.tracks[0]?.reason,
                corrected: early.corrected,
                relaxedQuery: undefined,
                lyricLine: undefined,
              });
            },
          });
          if (gen !== searchGen.current) return; // stale — dropped
          corrRef.current = {
            query: q,
            normalized: res.plan.normalized,
            id: res.correlationId,
            lyricHits: new Set(),
            isLyric: res.plan.kind === 'lyric_fragment',
          };
          setResults(res.tracks);
          setMeta({
            degraded: res.degraded,
            reason: res.topReason,
            corrected: res.corrected,
            relaxedQuery: res.relaxedQuery,
            lyricLine: undefined,
            sigState: res.sigState,
            partialArtists: res.partialArtists,
            partialTitle: res.plan.titleTokens.join(' '),
          });
          setVibeChips([]);
          void mindbeat.searchQueriedV2({
            query: q,
            normalized: res.plan.normalized,
            resultCount: res.tracks.length,
            planKind: res.plan.kind,
            probes: res.probes ?? [q],
            latencyMs: res.latencyMs,
            corrections: res.plan.corrections,
            correlationId: res.correlationId,
          });

          // LRCLIB verification AFTER paint (S2 V2 — bounded, never blocks)
          if (res.plan.kind === 'lyric_fragment' && res.tracks.length > 0) {
            const cands: Candidate[] = res.tracks.slice(0, 5).map((t) => ({
              ...t,
              poolRank: 0,
              pool: 'post',
            }));
            void verifyLyrics(res.plan, cands, ctrl.signal).then((verdicts) => {
              if (gen !== searchGen.current || verdicts.size === 0) return;
              setResults((prev) => {
                let changed = false;
                const next = prev.map((t) => {
                  const v = verdicts.get(t.id);
                  if (v?.matched && !t.lyricMatch) {
                    changed = true;
                    return { ...t, lyricMatch: true, matchedLine: v.line };
                  }
                  return t;
                });
                return changed ? next : prev;
              });
              verdicts.forEach((v, id) => {
                if (v.matched) corrRef.current.lyricHits.add(id);
              });
              // re-order: verified lyric matches float to the top
              setResults((prev) => {
                const verified = prev.filter((t) => t.lyricMatch);
                if (verified.length === 0) return prev;
                const rest = prev.filter((t) => !t.lyricMatch);
                return [...verified, ...rest];
              });
            });
          }
        }
        await pushRecentSearch(q);
        setRecentSearches(await getRecentSearches());
      } catch {
        if (gen !== searchGen.current) return;
        setResults([]);
        setMeta({ degraded: true });
      } finally {
        if (gen === searchGen.current) setLoading(false);
      }
    },
    [vibe, source],
  );

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    const q = query;
    debounce.current = setTimeout(() => runSearch(q), DEBOUNCE_MS);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query, runSearch]);

  const play = (index: number) => {
    if (!results.length) return;
    const track = results[index];
    playQueue(results, index, 'search');
    Keyboard.dismiss();
    nav.navigate('Player');
    // S5 learn: correlated click (always) + fragment resolution — the
    // fragment→track cache is scoped to lyric searches (§5.6, P1-3 fix)
    const corr = corrRef.current;
    if (corr.query && !vibe) {
      void mindbeat.searchClickedV2({
        trackId: track.id,
        rankInResults: index,
        query: corr.query,
        normalizedQuery: corr.normalized,
        correlationId: corr.id,
        lyricVerified: corr.lyricHits.has(track.id) || track.lyricMatch === true,
      });
      if (corr.isLyric) {
        void rememberResolve(engineDeps(), corr.normalized, {
          id: track.id,
          saavnId: track.saavnId,
          title: track.title,
          artist: track.artist,
        });
      }
    } else {
      void mindbeat.searchClicked(track.id, index);
    }
  };

  const openGenre = (label: string, q: string) => {
    nav.navigate('Collection', {
      collection: {
        id: `genre-${label}`,
        title: label,
        subtitle: 'Browse',
        artwork: '',
        kind: 'search',
        query: q,
      },
    });
  };

  const showBrowse = !query && !searched;
  // Rail shows whenever suggestions exist for the current text (S4 bar:
  // "typing ≥2 chars shows a rail" — also AFTER a previous search; the
  // next runSearch clears suggests and swaps to results).
  const showSuggestRail =
    !vibe && !loading && suggests !== null && query.trim().length >= 2;
  const top = results[0];
  const rest = results.slice(1);
  // did-you-mean chips: memoized — planSearch runs SymSpell, never per
  // render (P2 fix)
  const didYouMean = useMemo(
    () =>
      !vibe && query.trim().length >= 3 && !loading && results.length === 0
        ? planSearch(query).corrections
        : [],
    [vibe, query, loading, results.length],
  );

  const renderSuggestRail = () => {
    if (!suggests) return null;
    const rows = [
      ...(suggests.topQuery
        ? [{ kind: 'topquery' as const, ...suggests.topQuery }]
        : []),
      ...suggests.songs.map((s) => ({ kind: 'song' as const, ...s })),
      ...suggests.artists.map((s) => ({ kind: 'artist' as const, ...s })),
    ].slice(0, 8);
    if (rows.length === 0) return null;
    return (
      <View style={styles.suggestWrap} testID="search-suggest-rail">
        {rows.map((r, i) => (
          <Pressable
            key={`${r.kind}-${r.id}-${i}`}
            testID="search-suggest-row"
            style={styles.suggestRow}
            onPress={() => {
              setQuery(r.title);
            }}
          >
            <View style={r.kind === 'artist' ? styles.suggestArtRound : styles.suggestArt}>
              {r.image ? (
                <Image source={{ uri: r.image }} style={styles.suggestImg} />
              ) : (
                <Ionicons
                  name={r.kind === 'artist' ? 'person' : 'musical-note'}
                  size={16}
                  color={colors.textDim}
                />
              )}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.suggestTitle} numberOfLines={1}>
                {r.title}
              </Text>
              {r.subtitle ? (
                <Text style={styles.suggestSub} numberOfLines={1}>
                  {r.subtitle}
                </Text>
              ) : null}
            </View>
            {r.kind === 'topquery' ? (
              <View style={styles.bestGuess} testID="search-suggest-topquery">
                <Text style={styles.bestGuessText}>Best guess</Text>
              </View>
            ) : (
              <Ionicons
                name="arrow-up"
                size={16}
                color={colors.textFaint}
              />
            )}
          </Pressable>
        ))}
      </View>
    );
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Spotify search field + Keyword|Vibe mode toggle (§9.8) */}
      <View style={styles.searchWrap}>
        <View style={styles.modeRow}>
          {([false, true] as const).map((v) => (
            <PressableScale
              key={v ? 'vibe' : 'kw'}
              haptic
              onPress={() => {
                setVibe(v);
                // no direct runSearch — the effect re-fires when runSearch's
                // identity changes with `vibe`, debouncing once (P2 fix:
                // the old code double-fired the pipeline)
              }}
              style={[styles.modeChip, vibe === v && styles.modeChipOn]}
            >
              <Ionicons
                name={v ? 'sparkles' : 'text'}
                size={12}
                color={vibe === v ? colors.textOnGreen : colors.textDim}
              />
              <Text style={[styles.modeChipText, vibe === v && styles.modeChipTextOn]}>{v ? 'Vibe' : 'Keyword'}</Text>
            </PressableScale>
          ))}
        </View>
        <View style={styles.inputRow}>
          <Ionicons name="search" size={21} color={colors.textDim} />
          <TextInput
            style={styles.input}
            placeholder="What do you want to listen to?"
            placeholderTextColor={colors.textDim}
            value={query}
            onChangeText={setQuery}
            returnKeyType="search"
            onSubmitEditing={() => runSearch(query)}
            autoCorrect={false}
          />
          {query.length > 0 ? (
            <Pressable hitSlop={8} onPress={() => setQuery('')}>
              <Ionicons name="close" size={20} color={colors.textDim} />
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* Vibe-mode parsed-intent chips (§9.8) */}
      {!showBrowse && vibeChips.length > 0 ? (
        <View style={styles.vibeChipsRow}>
          {vibeChips.map((c) => (
            <View key={c} style={styles.vibeChip}>
              <Text style={styles.vibeChipText} numberOfLines={1}>
                {c}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {/* ── Source toggle: Catalog | YouTube (YOUTUBE-INTEGRATION-PLAN §3.1) ── */}
      {!showBrowse ? (
        <View style={styles.sourceToggleRow}>
          {([
            { key: 'catalog', label: 'Catalog', icon: 'disc-outline' as const },
            { key: 'youtube', label: 'YouTube', icon: 'logo-youtube' as const },
          ] as const).map((opt) => {
            const active = source === opt.key;
            return (
              <PressableScale
                key={opt.key}
                haptic
                testID={`source-toggle-${opt.key}`}
                onPress={() => {
                  if (active) return;
                  setSource(opt.key);
                  // P2-1: search the NEW source immediately, not the stale
                  // render-time one
                  if (query.trim()) runSearch(query.trim(), opt.key);
                }}
                style={[styles.sourceChip, active && styles.sourceChipActive]}
              >
                <Ionicons
                  name={opt.icon}
                  size={14}
                  color={active ? '#101010' : colors.textDim}
                />
                <Text style={[styles.sourceChipText, active && styles.sourceChipTextActive]}>
                  {opt.label}
                </Text>
              </PressableScale>
            );
          })}
        </View>
      ) : null}

      {showBrowse ? (
        <FlatList
          key={`browse-${browseCols}`}
          data={GENRES}
          keyExtractor={(g) => g.label}
          numColumns={browseCols}
          columnWrapperStyle={styles.genreRow}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={{ paddingBottom: 170 }}
          ListHeaderComponent={
            <View>
              {recentSearches.length > 0 ? (
                <View style={styles.recentSection}>
                  <View style={styles.recentHeader}>
                    <Text style={styles.recentTitle}>Recent searches</Text>
                    <PressableScale
                      haptic
                      hitSlop={8}
                      onPress={() => {
                        void clearRecentSearches().then(() => setRecentSearches([]));
                      }}
                      accessibilityLabel="Clear recent searches"
                    >
                      <Ionicons name="trash-outline" size={17} color={colors.textDim} />
                    </PressableScale>
                  </View>
                  {recentSearches.slice(0, 4).map((s) => (
                    <Pressable
                      key={s}
                      style={styles.recentRow}
                      onPress={() => setQuery(s)}
                    >
                      <Ionicons name="time-outline" size={19} color={colors.textDim} />
                      <Text style={styles.recentText} numberOfLines={1}>
                        {s}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
              <Text style={styles.browseTitle}>Browse all</Text>
            </View>
          }
          renderItem={({ item, index }) => {
            const [c1] = genreGradient(index);
            const art = browseArt[index % Math.max(1, browseArt.length)];
            return (
              <PressableScale
                onPress={() => openGenre(item.label, item.query)}
                scaleTo={0.97}
                haptic
                style={[styles.genreTile, { backgroundColor: c1 }]}
              >
                <Text style={styles.genreLabel}>{item.label}</Text>
                {art ? (
                  <Image source={{ uri: art }} style={styles.genreArt} />
                ) : null}
              </PressableScale>
            );
          }}
          ListFooterComponent={
            <PressableScale
              onPress={() => nav.navigate('AI')}
              scaleTo={0.97}
              haptic
              style={[styles.genreTile, { backgroundColor: colors.aiStart }]}
            >
              <View style={{ flex: 1, justifyContent: 'center', paddingRight: 40 }}>
                <Text style={styles.genreLabel}>TSF AI</Text>
                <Text style={styles.aiTileSub} numberOfLines={2}>
                  Describe your vibe, get a playlist
                </Text>
              </View>
              <View style={styles.aiTileIcon}>
                <Ionicons name="sparkles" size={22} color="#fff" />
              </View>
            </PressableScale>
          }
        />
      ) : showSuggestRail ? (
        <View style={{ flex: 1 }}>
          {renderSuggestRail()}
          {recentSearches.length > 0 ? (
            <View style={styles.suggestWrap}>
              <Text style={styles.suggestSection}>Your recent searches</Text>
              {recentSearches
                .filter((s) => s.toLowerCase().includes(query.trim().toLowerCase()))
                .slice(0, 3)
                .map((s) => (
                  <Pressable key={s} style={styles.suggestRow} onPress={() => setQuery(s)}>
                    <Ionicons name="time-outline" size={17} color={colors.textDim} />
                    <Text style={styles.suggestTitle} numberOfLines={1}>
                      {s}
                    </Text>
                  </Pressable>
                ))}
            </View>
          ) : null}
        </View>
      ) : loading ? (
        <View style={styles.centerWrap}>
          <ActivityIndicator size="large" color={colors.accentBright} />
        </View>
      ) : results.length === 0 ? (
        <View style={styles.centerWrap}>
          <Ionicons name="musical-notes-outline" size={48} color={colors.textFaint} />
          <Text style={styles.noResults}>No results for “{query}”</Text>
          {didYouMean.length > 0 ? (
            <View style={styles.dymWrap}>
              <Text style={styles.dymLabel}>Did you mean</Text>
              <View style={styles.dymChips}>
                {didYouMean.slice(0, 2).map((c) => (
                  <PressableScale
                    key={c.to}
                    haptic
                    style={styles.dymChip}
                    onPress={() => setQuery(c.to)}
                  >
                    <Text style={styles.dymChipText}>{c.to}</Text>
                  </PressableScale>
                ))}
              </View>
            </View>
          ) : (
            <Text style={styles.noResultsSub}>Check the spelling or try something else</Text>
          )}
        </View>
      ) : (
        <FlatList
          key="results"
          data={rest}
          keyExtractor={(t) => t.id}
          renderItem={({ item, index }) => (
            <TrackRow
              track={item}
              onPress={() => play(index + 1)}
              showHeart={false}
            />
          )}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          onEndReachedThreshold={0.4}
          onEndReached={() => {
            void loadMoreResults();
          }}
          ListFooterComponent={
            loadingMore ? (
              <View style={styles.loadMoreFooter} testID="search-loading-more">
                <ActivityIndicator size="small" color={colors.accentBright} />
              </View>
            ) : endNote && results.length > 0 ? (
              <Text style={styles.endNote} testID="search-end-note">
                {endNote}
              </Text>
            ) : null
          }
          contentContainerStyle={{ paddingBottom: 170 }}
          ListHeaderComponent={
            <View>
              {meta.sigState === 'partial' ? (
                <View style={styles.sigNote}>
                  <Text style={styles.sigNoteTitle} numberOfLines={1}>
                    Songs matching “{query.trim()}”
                  </Text>
                  <Text style={styles.sigNoteSub}>
                    The artist version isn't available on JioSaavn right now
                  </Text>
                  {meta.partialArtists && meta.partialArtists.length > 0 ? (
                    <View style={styles.sigChips}>
                      {meta.partialArtists.slice(0, 5).map((a) => (
                        <Pressable
                          key={a}
                          style={styles.sigChip}
                          onPress={() => {
                            // P2-2: build from the plan's title side — raw
                            // query slicing only stripped " of " and let
                            // "... by atif aslam" queries grow unboundedly
                            const base = meta.partialTitle?.trim() || planSearch(query).titleTokens.join(' ');
                            const q2 = `${base} ${a}`.trim();
                            setQuery(q2);
                            runSearch(q2);
                          }}
                        >
                          <Text style={styles.sigChipText} numberOfLines={1}>
                            {a}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  ) : null}
                </View>
              ) : null}
              {meta.sigState === 'zero' ? (
                <Text style={styles.sigRescuedNote}>
                  Nothing on JioSaavn matches well — try the YouTube tab
                </Text>
              ) : null}
              {meta.ytUnavailable && source === 'youtube' ? (
                <Text style={styles.sigRescuedNote}>
                  YouTube is taking a break after repeated failures — try Catalog
                </Text>
              ) : null}
              {meta.sigState === 'rescued' && results[0]?.rescueRung === 'youtube' ? (
                <Text style={styles.sigRescuedNote}>
                  Found on YouTube · full song, ad-free
                </Text>
              ) : null}
              {meta.sigState === 'rescued' && results[0]?.rescueRung === 'itunes' ? (
                <Text style={styles.sigRescuedNote}>
                  Found via Apple Music · 30s preview
                </Text>
              ) : null}
              {meta.sigState === 'rescued' && results[0]?.rescueRung === 'variant' ? (
                <Text style={styles.sigRescuedNote}>
                  Found under a different spelling
                </Text>
              ) : null}
              {meta.sigState === 'rescued' && results[0]?.rescueRung === 'album' ? (
                <Text style={styles.sigRescuedNote}>
                  Found via its album · full song
                </Text>
              ) : null}
              {meta.degraded ? (
                <Text style={styles.degradedNote}>
                  Full-length streams unavailable — some results are 30s previews
                </Text>
              ) : null}
              {meta.relaxedQuery ? (
                <Text style={styles.relaxedNote} numberOfLines={1}>
                  Showing results for “{meta.relaxedQuery}”
                </Text>
              ) : null}
              {meta.corrected && meta.corrected !== query.trim().toLowerCase() ? (
                <Pressable
                  style={styles.relaxedNote}
                  onPress={() => setQuery(meta.corrected ?? query)}
                >
                  <Text style={styles.relaxedNoteText} numberOfLines={1}>
                    Did you mean “{meta.corrected}”? Tap to search
                  </Text>
                </Pressable>
              ) : null}
              {/* ── Top result — Spotify's hero card + truthful reason ── */}
              {top ? (
                <View style={styles.topResultWrap}>
                  <Text style={styles.songsHeader}>Top result</Text>
                  <PressableScale
                    testID="search-top-result"
                    haptic
                    onPress={() => play(0)}
                    style={styles.topCard}
                  >
                    <Artwork uri={top.artwork} seed={top.id} size={92} variant="card" />
                    <View style={styles.topCardInfo}>
                      <Text style={styles.topCardTitle} numberOfLines={2}>
                        {top.title}
                      </Text>
                      <View style={styles.topCardMetaRow}>
                        <View style={styles.topCardType}>
                          <Text style={styles.topCardTypeText}>
                            {top.source === 'youtube'
                              ? top.ytKind === 'video'
                                ? 'YT Video'
                                : 'YT Song'
                              : top.source === 'itunes'
                                ? 'Preview'
                                : 'Song'}
                          </Text>
                        </View>
                        <Text style={styles.topCardArtist} numberOfLines={1}>
                          {top.artist}
                        </Text>
                      </View>
                      {top.lyricMatch && top.matchedLine ? (
                        <View style={styles.lyricChip} testID="top-lyric-chip">
                          <Ionicons name="text-outline" size={11} color={colors.accentBright} />
                          <Text style={styles.lyricChipText} numberOfLines={1}>
                            Lyric match · “{top.matchedLine}”
                          </Text>
                        </View>
                      ) : top.reason ? (
                        <Text style={styles.reasonLine} numberOfLines={1}>
                          {top.reason}
                        </Text>
                      ) : null}
                    </View>
                    <View style={styles.topPlayFab}>
                      <Ionicons name="play" size={22} color="#000" />
                    </View>
                  </PressableScale>
                  <Text style={styles.songsHeader}>Songs</Text>
                </View>
              ) : null}
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  searchWrap: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md - 2 },
  modeRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  modeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: colors.cardDim,
  },
  modeChipOn: { backgroundColor: colors.accentBright },
  modeChipText: { color: colors.textDim, fontSize: 12, fontFamily: fonts.medium },
  modeChipTextOn: { color: colors.textOnGreen, fontWeight: '700', fontFamily: fonts.bold },
  vibeChipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: spacing.lg, paddingBottom: 6 },
  vibeChip: {
    backgroundColor: colors.surface,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  vibeChipText: { color: colors.aiEnd, fontSize: 11, fontFamily: fonts.medium },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.card, // Spotify #242424 field
    borderRadius: radius.full,
    paddingHorizontal: spacing.lg,
    height: 48,
  },
  input: { flex: 1, color: colors.text, fontSize: 15.5, fontFamily: fonts.regular },
  // ── typeahead rail ───────────────────────────────────────────────────
  suggestWrap: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    gap: 2,
  },
  suggestSection: {
    color: colors.textDim,
    fontSize: 11,
    fontFamily: fonts.bold,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    paddingVertical: 8,
  },
  suggestRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
  },
  suggestArt: {
    width: 34,
    height: 34,
    borderRadius: 4,
    backgroundColor: colors.cardDim,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  suggestArtRound: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.cardDim,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  suggestImg: { width: '100%', height: '100%' },
  suggestTitle: { color: colors.text, fontSize: 14.5, fontFamily: fonts.medium, flexShrink: 1 },
  suggestSub: { color: colors.textDim, fontSize: 12, fontFamily: fonts.regular },
  bestGuess: {
    backgroundColor: colors.accentBright,
    borderRadius: 3,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  bestGuessText: {
    color: colors.textOnGreen,
    fontSize: 10,
    fontWeight: '800',
    fontFamily: fonts.extrabold,
  },
  // ── zero-state / did-you-mean ────────────────────────────────────────
  dymWrap: { alignItems: 'center', gap: 10, paddingTop: 4 },
  dymLabel: { color: colors.textDim, fontSize: 13, fontFamily: fonts.medium },
  dymChips: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', justifyContent: 'center' },
  dymChip: {
    backgroundColor: colors.cardDim,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  dymChipText: { color: colors.accentBright, fontSize: 13.5, fontFamily: fonts.bold },
  // ── results chrome ───────────────────────────────────────────────────
  recentSection: { paddingTop: spacing.md, paddingBottom: spacing.lg, gap: 2 },
  recentHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  recentTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
    fontFamily: fonts.bold,
    marginBottom: 6,
  },
  recentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 12,
  },
  recentText: { flex: 1, color: colors.text, fontSize: 15, fontFamily: fonts.medium },
  browseTitle: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '700',
    fontFamily: fonts.bold,
    letterSpacing: -0.3,
    paddingBottom: spacing.md,
  },
  genreRow: { gap: 8, marginBottom: 8 },
  genreTile: {
    flex: 1,
    flexDirection: 'row',
    height: 100,
    borderRadius: 8,
    padding: spacing.md,
    overflow: 'hidden',
  },
  genreLabel: {
    color: '#fff',
    fontSize: 19,
    fontWeight: '700',
    fontFamily: fonts.bold,
    letterSpacing: -0.3,
    maxWidth: '80%',
  },
  /** Spotify's signature: album art rotated ~25° peeking out the corner */
  genreArt: {
    position: 'absolute',
    bottom: -14,
    right: -8,
    width: 74,
    height: 74,
    borderRadius: 4,
    transform: [{ rotate: '25deg' }],
  },
  aiTileSub: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 12,
    fontFamily: fonts.medium,
    marginTop: 4,
    maxWidth: '95%',
  },
  aiTileIcon: {
    position: 'absolute',
    bottom: 10,
    right: 12,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // ── Top result hero ─────────────────────────────────────────────────
  topResultWrap: { paddingHorizontal: spacing.lg },
  songsHeader: {
    color: colors.text,
    fontSize: 19,
    fontWeight: '800',
    fontFamily: fonts.extrabold,
    letterSpacing: -0.3,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm + 2,
  },
  topCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#181818',
    borderRadius: 6,
    padding: 12,
    marginBottom: 6,
    overflow: 'hidden',
  },
  topCardInfo: { flex: 1, gap: 6 },
  topCardTitle: {
    color: colors.text,
    fontSize: 19,
    fontWeight: '800',
    fontFamily: fonts.extrabold,
    letterSpacing: -0.3,
    lineHeight: 23,
  },
  topCardMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  topCardType: {
    backgroundColor: '#2e2e2e',
    borderRadius: 3,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  topCardTypeText: { color: colors.text, fontSize: 11.5, fontWeight: '700', fontFamily: fonts.bold },
  topCardArtist: { color: colors.textDim, fontSize: 13, fontFamily: fonts.medium, flexShrink: 1 },
  topPlayFab: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.accentBright,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
  },
  reasonLine: {
    color: colors.textDim,
    fontSize: 11.5,
    fontFamily: fonts.medium,
  },
  lyricChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(29,185,84,0.12)',
    borderRadius: 4,
    paddingHorizontal: 7,
    paddingVertical: 4,
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  lyricChipText: {
    color: colors.accentBright,
    fontSize: 11,
    fontFamily: fonts.semibold ?? fonts.medium,
    flexShrink: 1,
  },
  relaxedNote: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  relaxedNoteText: {
    color: colors.textDim,
    fontSize: 12,
    fontFamily: fonts.medium,
  },
  centerWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, padding: spacing.xl },
  // ── infinite results footer (F1) ─────────────────────────────────────
  loadMoreFooter: { paddingVertical: 22, alignItems: 'center' },
  endNote: {
    color: colors.textFaint,
    fontSize: 13,
    fontFamily: fonts.medium,
    textAlign: 'center',
    paddingVertical: 20,
  },
  noResults: { color: colors.text, fontSize: 18, fontWeight: '700', fontFamily: fonts.bold },
  noResultsSub: { color: colors.textDim, fontSize: 13, fontFamily: fonts.regular },
  degradedNote: {
    color: colors.textDim,
    fontSize: 11,
    fontFamily: fonts.medium,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  // ── source toggle (Catalog | YouTube) ──
  sourceToggleRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  sourceChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    height: 30,
    borderRadius: radius.full,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  sourceChipActive: {
    backgroundColor: colors.accentBright,
  },
  sourceChipText: {
    color: colors.textDim,
    fontSize: 12,
    fontFamily: fonts.semibold,
  },
  sourceChipTextActive: {
    color: '#101010',
  },
  // ── SIG states (§3.1) ──
  sigNote: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    padding: 12,
    borderRadius: radius.md,
    backgroundColor: colors.card,
  },
  sigNoteTitle: {
    color: colors.text,
    fontSize: 14,
    fontFamily: fonts.semibold,
  },
  sigNoteSub: {
    color: colors.textDim,
    fontSize: 12,
    fontFamily: fonts.regular,
    marginTop: 2,
  },
  sigChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  sigChip: {
    paddingHorizontal: 10,
    height: 26,
    borderRadius: radius.full,
    backgroundColor: '#2a2a2a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sigChipText: {
    color: colors.text,
    fontSize: 11,
    fontFamily: fonts.medium,
  },
  sigRescuedNote: {
    color: colors.accentBright,
    fontSize: 12,
    fontFamily: fonts.medium,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
});
