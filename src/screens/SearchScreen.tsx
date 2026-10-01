/**
 * Search — PULSE "The Index" (v4.0 editorial brutalism), Search V2 engine:
 *   bordered square field with the hard ink shadow (orange on focus) →
 *   TYPEAHEAD RAIL (recents + "Did you mean" chips at 0 ms; provider
 *   suggestions + "Best guess" topquery row ~250 ms) → `N VERIFIED` tag,
 *   rows with mono index + acid reason chips + source badges, dashed
 *   zero-state, numbered Browse-the-stacks grid.
 *
 * Engine behaviors surfaced here (UNCHANGED — locked by tests):
 *   • 700 ms debounce + per-generation AbortController
 *   • progressive paint — cached/early results render, final set lands
 *     at max(probes); LRCLIB verification re-renders AFTER paint
 *   • Keyword|Vibe toggle, browse grid, recents — unchanged (lab compat)
 *   • YouTube continuation pagination via YtAppendController (R8-P3)
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  ScrollView,
  useWindowDimensions,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
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
import { ytSearchMusic, ytSearchMusicMore, ytAvailable } from '../api/youtube';
import { YtAppendController, YT_END_NOTE } from '../search/ytAppend';
import { useStableField } from '../hooks/useStableField';
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
import { Brutal, MonoText, OutlineText } from '../components/Brutal';
import { colors, fonts, genreGradient } from '../theme';
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

/** Engine deps adapter — mindbeat on-device, best-effort everywhere. */
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
  const { width: winWidth } = useWindowDimensions();
  const browseCols = browseColumnsFor(winWidth);
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { playQueue } = usePlayer();
  // ── the field is UNCONTROLLED (v4.0.1 "hihiz" fix) ────────────────
  // Native text is the source of truth while typing; `query` state is a
  // throttled commit (useStableField) that drives the search debounce and
  // UI conditions. A controlled value prop raced its own commits under
  // load and duplicated fast keystrokes — see src/hooks/useStableField.ts.
  const [query, setQuery] = useState('');
  const field = useStableField({ onCommit: setQuery });
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
    /** YouTube already searched this spelling ("showing results for") */
    ytCorrectedTo?: string;
  }>({ degraded: false });
  const [loading, _setLoading] = useState(false);
  const loadingRef = useRef(false);
  const setLoading = useCallback((v: boolean) => {
    loadingRef.current = v;
    _setLoading(v);
  }, []);
  // ── infinite results pagination (F1) ─────────────────────────────
  const pageRef = useRef(1); // last appended page (page 1 = the engine set)
  const [loadingMore, _setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const setLoadingMore = useCallback((v: boolean) => {
    loadingMoreRef.current = v;
    _setLoadingMore(v);
  }, []);
  const [hasMore, setHasMore] = useState(true);
  /** ref mirror — the eager top-up runs from a closure that would
   *  otherwise read a stale hasMore (PULSE-FIX). */
  const hasMoreRef = useRef(true);
  const setHasMoreBoth = useCallback((v: boolean) => {
    hasMoreRef.current = v;
    setHasMore(v);
  }, []);
  const [endNote, setEndNote] = useState<string | null>(null);
  // CRITIC P1-2 fix: live mirror of results — loadMoreResults must merge
  // from the CURRENT rows (LRCLIB verification flag+reorder runs after the
  // engine set lands; a stale closure would strip lyricMatch chips and
  // revert the verified-float-to-top reorder on the first append).
  const resultsRef = useRef<Track[]>([]);
  useEffect(() => {
    resultsRef.current = results;
  }, [results]);
  /** PULSE-FIX (race): page-2+ rows appended while the ENGINE is still
   *  settling. The engine's final paint composes these back in instead
   *  of stomping them (a fast page-2 fetch used to be erased by the
   *  final setResults, permanently killing the appends for the query). */
  const appendedPagesRef = useRef<Track[]>([]);
  /** YouTube search continuation token — page 2+ of the songs-filter
   *  catalog (R8-P3: the deep list, not 6-8 rows and done). */
  const ytContRef = useRef<string | null>(null);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [browseArt, setBrowseArt] = useState<string[]>([]);
  const [searched, setSearched] = useState(false);
  const [vibe, setVibe] = useState(false); // Keyword | Vibe mode (§9.8)
  const [source, setSource] = useState<'catalog' | 'youtube'>('catalog');
  const [vibeChips, setVibeChips] = useState<string[]>([]);
  const [suggests, setSuggests] = useState<AutocompleteBundle | null>(null);
  const [fieldFocus, setFieldFocus] = useState(false);
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
    appendedPagesRef.current = [];
    setHasMoreBoth(true);
    setEndNote(null);
    setLoadingMore(false);
  }, []);

  /** R8-P3 append: the single-flighted continuation walk (page 2+ of
   *  YouTube Music's catalog list), shared by the scroll hook and the
   *  eager top-up. The state machine lives in YtAppendController
   *  (src/search/ytAppend.ts — behaviorally locked); the ports below
   *  are stable refs/setters so the controller instance is created once. */
  const ytAppendRef = useRef<YtAppendController | null>(null);
  if (!ytAppendRef.current) {
    ytAppendRef.current = new YtAppendController({
      fetchMore: (cont, signal) => ytSearchMusicMore(cont, 30, signal),
      getCont: () => ytContRef.current,
      setCont: (c) => {
        ytContRef.current = c;
      },
      getRows: () => resultsRef.current,
      publishRows: (rows) => {
        resultsRef.current = rows;
        setResults(rows);
      },
      publishState: (s) => {
        setHasMoreBoth(s.hasMore);
        setEndNote(s.endNote);
      },
      isCurrentGen: (gen) => gen === searchGen.current,
      getSignal: () => abortRef.current?.signal,
      setBusy: setLoadingMore,
    });
  }
  const appendYtPage = useCallback(
    (gen: number, opts?: { silent?: boolean }) => ytAppendRef.current!.append(gen, opts),
    [],
  );

  /**
   * Infinite scroll (F1): catalog keyword searches append JioSaavn page
   * p+1 as the user approaches the end. Rows are deduped by id AND
   * recording key (R8-P4), muted artists are honored (engine parity),
   * the top-result card never moves, and the feed stops HONESTLY.
   * YouTube mode walks the songs-filter continuation (R8-P3).
   */
  const loadMoreResults = useCallback(async () => {
    // all gate inputs read from refs — this runs from stale closures
    // (the eager top-up, the scroll probe) and must see FRESH values
    if (loadingMoreRef.current || !hasMoreRef.current || loadingRef.current || resultsRef.current.length === 0) return;
    if (vibe) return;
    if (source === 'youtube') {
      if (!ytContRef.current) {
        setHasMoreBoth(false);
        setEndNote(YT_END_NOTE);
        return;
      }
      const q = field.getValue().trim();
      if (!q) return;
      void appendYtPage(searchGen.current);
      return;
    }
    if (source !== 'catalog') return;
    const q = field.getValue().trim();
    if (!q) return;
    const gen = searchGen.current;
    setLoadingMore(true);
    try {
      const nextPage = pageRef.current + 1;
      const page = await searchSaavn(q, 30, abortRef.current?.signal, nextPage);
      if (gen !== searchGen.current) {
        setLoadingMore(false); // PULSE-FIX: never leak a stuck busy flag
        return; // stale — new query won
      }
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
      appendedPagesRef.current = mergeUniqueTracks(appendedPagesRef.current, allowed);
      resultsRef.current = merged; // keep the mirror in sync immediately
      setResults(merged);
      if (!searchHasMore(page.length, fresh)) {
        setHasMoreBoth(false);
        setEndNote('END OF RESULTS');
      }
    } catch {
      if (gen !== searchGen.current) return;
      setHasMoreBoth(false);
      setEndNote("COULDN'T LOAD MORE — CHECK YOUR CONNECTION");
    } finally {
      setLoadingMore(false); // unconditional: false can never disable a newer query
    }
  }, [vibe, source, appendYtPage]);

  const runSearch = useCallback(
    // sourceOverride (P2-1): the source toggle passes the NEW source so the
    // immediate re-search runs against it.
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
          if (!ytAvailable()) {
            if (gen !== searchGen.current) return;
            setResults([]);
            setMeta({ degraded: false, sigState: undefined, partialArtists: undefined, ytUnavailable: true });
            setVibeChips([]);
            setHasMoreBoth(false);
            setEndNote(null);
            return;
          }
          const ytr = await ytSearchMusic(q, 25, ctrl.signal);
          if (gen !== searchGen.current) return;
          setResults(ytr.tracks);
          setMeta({
            degraded: false,
            sigState: undefined,
            partialArtists: undefined,
            ytUnavailable: ytr.tracks.length === 0 && !ytAvailable(),
            ytCorrectedTo: ytr.correctedTo,
          });
          setVibeChips([]);
          ytContRef.current = ytr.continuation ?? null;
          setHasMoreBoth(!!ytr.continuation);
          setEndNote(null);
          if (ytr.continuation && ytr.tracks.length < 20) {
            resultsRef.current = ytr.tracks;
            void appendYtPage(gen, { silent: true });
          }
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
          setHasMoreBoth(false);
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
          // PULSE-FIX: compose the final engine set with any page-2+ rows
          // that already appended while the engine was settling — the final
          // paint must never erase an append (see appendedPagesRef).
          const finalTracks = appendedPagesRef.current.length
            ? mergeUniqueTracks(res.tracks, appendedPagesRef.current)
            : res.tracks;
          resultsRef.current = finalTracks;
          setResults(finalTracks);
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
              setResults((prev) => {
                const verified = prev.filter((t) => t.lyricMatch);
                if (verified.length === 0) return prev;
                const rest = prev.filter((t) => !t.lyricMatch);
                return [...verified, ...rest];
              });
            });
          }
          // EAGER TOP-UP (catalog): a thin first page walks page 2 in the
          // background so the user lands on a BIG list (YouTube parity).
          if (finalTracks.length < 15 && hasMoreRef.current) {
            setTimeout(() => void loadMoreResults(), 0);
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
    // KNOWN TRADE-OFF (v4.0.1 triage): pressing Enter inside the field's
    // 120ms commit window runs the search immediately (fresh text), then
    // the pending commit lands, flips `query`, and THIS effect schedules
    // one identical re-run 700ms later. Harmless: runSearch is
    // generation-guarded (stale gens drop), same query → same results —
    // only the spinner restarts. Not worth a same-text skip that would
    // also suppress legitimate "edited away and back" re-searches.
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
    // S5 learn: correlated click (always) + fragment resolution
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
  const showSuggestRail =
    !vibe && !loading && suggests !== null && query.trim().length >= 2;
  const top = results[0];
  const rest = results.slice(1);
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
            style={({ pressed }) => [styles.suggestRow, pressed && { backgroundColor: colors.paper2 }]}
            onPress={() => {
              field.setValue(r.title);
            }}
          >
            <View style={[styles.suggestArt, r.kind === 'artist' && styles.suggestArtSquare]}>
              {r.image ? (
                <Image source={{ uri: r.image }} style={styles.suggestImg} />
              ) : (
                <Ionicons
                  name={r.kind === 'artist' ? 'person' : 'musical-note'}
                  size={16}
                  color={colors.ink60}
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
                <MonoText size={8.5} bold color={colors.ink}>
                  BEST GUESS
                </MonoText>
              </View>
            ) : (
              <Ionicons name="arrow-up" size={15} color={colors.ink40} />
            )}
          </Pressable>
        ))}
      </View>
    );
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* masthead + field */}
      <View style={styles.searchWrap}>
        <View style={styles.mastRow}>
          <OutlineText style={styles.mastTitle} outline={1.5}>
            The Index
          </OutlineText>
        </View>
        <View style={styles.editionRow}>
          <View style={styles.edDot} />
          <MonoText size={9.5} bold color={colors.ink60} style={{ letterSpacing: 1.6 }}>
            TYPO-TOLERANT · LYRIC-VERIFIED · SIX-STAGE ENGINE
          </MonoText>
        </View>
        <View style={styles.modeRow}>
          {([false, true] as const).map((v) => (
            <Brutal
              key={v ? 'vibe' : 'kw'}
              haptic={vibe !== v}
              shadow={2}
              onPress={() => setVibe(v)}
              style={[styles.modeChip, vibe === v && styles.chipOn]}
            >
              <MonoText size={10.5} bold color={vibe === v ? colors.ink : colors.ink60} style={{ letterSpacing: 0.8 }}>
                {v ? 'VIBE' : 'KEYWORD'}
              </MonoText>
            </Brutal>
          ))}
        </View>
        <View style={[styles.inputRow, fieldFocus && styles.inputRowFocus]}>
          <Ionicons name="search" size={18} color={colors.ink60} />
          <TextInput
            style={styles.input}
            testID="search-input"
            placeholder="TYPE A SONG, ARTIST, OR A LINE YOU REMEMBER"
            placeholderTextColor={colors.ink40}
            ref={field.inputRef}
            onChangeText={field.handleChange}
            returnKeyType="search"
            onSubmitEditing={() => runSearch(field.getValue())}
            autoCorrect={false}
            onFocus={() => setFieldFocus(true)}
            onBlur={() => setFieldFocus(false)}
          />
          {query.length > 0 ? (
            <Pressable hitSlop={8} testID="search-clear" onPress={() => field.setValue('')}>
              <Ionicons name="close" size={18} color={colors.ink60} />
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* Vibe-mode parsed-intent chips (§9.8) */}
      {!showBrowse && vibeChips.length > 0 ? (
        <View style={styles.vibeChipsRow}>
          {vibeChips.map((c) => (
            <View key={c} style={styles.vibeChip}>
              <MonoText size={9.5} bold color={colors.ink} numberOfLines={1}>
                {c.toUpperCase()}
              </MonoText>
            </View>
          ))}
        </View>
      ) : null}

      {/* ── Source toggle: Catalog | YouTube ── */}
      {!showBrowse ? (
        <View style={styles.sourceToggleRow}>
          {([
            { key: 'catalog', label: 'CATALOG' },
            { key: 'youtube', label: 'YOUTUBE' },
          ] as const).map((opt) => {
            const active = source === opt.key;
            return (
              <Brutal
                key={opt.key}
                haptic={!active}
                shadow={2}
                testID={`source-toggle-${opt.key}`}
                onPress={() => {
                  if (active) return;
                  setSource(opt.key);
                  // read the FRESH field text — committed `query` can lag a
                  // throttle cycle behind the visible field (v4.0.1)
                  const q = field.getValue().trim();
                  if (q) runSearch(q, opt.key);
                }}
                style={[styles.sourceChip, active && styles.chipOn]}
              >
                <MonoText size={10} bold color={active ? colors.ink : colors.ink60} style={{ letterSpacing: 1 }}>
                  {opt.label}
                </MonoText>
              </Brutal>
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
                    <MonoText size={9.5} bold color={colors.ink60} style={{ letterSpacing: 2 }}>
                      RECENT SEARCHES
                    </MonoText>
                    <Pressable
                      hitSlop={8}
                      onPress={() => {
                        void clearRecentSearches().then(() => setRecentSearches([]));
                      }}
                      accessibilityLabel="Clear recent searches"
                    >
                      <Ionicons name="trash-outline" size={16} color={colors.ink40} />
                    </Pressable>
                  </View>
                  <View style={styles.recentsChips}>
                    {recentSearches.slice(0, 6).map((s) => (
                      <Brutal key={s} shadow={2} haptic onPress={() => field.setValue(s)} style={styles.recentChip}>
                        <MonoText size={10.5} bold color={colors.ink60} style={{ letterSpacing: 0.4 }}>
                          {s}
                        </MonoText>
                      </Brutal>
                    ))}
                  </View>
                </View>
              ) : null}
              <View style={styles.secLabel}>
                <MonoText size={9.5} bold color={colors.ink60} style={{ letterSpacing: 2.2 }}>
                  BROWSE THE STACKS
                </MonoText>
                <View style={styles.secRule} />
              </View>
            </View>
          }
          renderItem={({ item, index }) => {
            return (
              <Brutal
                onPress={() => openGenre(item.label, item.query)}
                shadow={3}
                haptic
                style={styles.gcard}
              >
                <Text style={styles.gcardLabel} numberOfLines={1}>
                  {item.label}
                </Text>
                <MonoText size={9} color={colors.ink40} style={styles.gcardNum}>
                  {String(index + 1).padStart(2, '0')} STACK
                </MonoText>
              </Brutal>
            );
          }}
          ListFooterComponent={
            <Brutal
              onPress={() => nav.navigate('AI')}
              shadow={3}
              haptic
              style={[styles.gcard, styles.gcardWide, { backgroundColor: colors.acid }]}
            >
              <Text style={styles.gcardLabel}>MINDBEAT WIRE</Text>
              <MonoText size={9} color={colors.ink60} style={styles.gcardNum}>
                TYPE A VIBE · GET 25
              </MonoText>
            </Brutal>
          }
        />
      ) : showSuggestRail ? (
        <View style={{ flex: 1 }}>
          {renderSuggestRail()}
          {recentSearches.length > 0 ? (
            <View style={styles.suggestWrap}>
              <MonoText size={9.5} bold color={colors.ink60} style={{ letterSpacing: 2, paddingVertical: 8 }}>
                YOUR RECENT SEARCHES
              </MonoText>
              {recentSearches
                .filter((s) => s.toLowerCase().includes(query.trim().toLowerCase()))
                .slice(0, 3)
                .map((s) => (
                  <Pressable key={s} style={styles.suggestRow} onPress={() => field.setValue(s)}>
                    <Ionicons name="time-outline" size={16} color={colors.ink40} />
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
          <ActivityIndicator size="large" color={colors.orange} />
          <MonoText size={10} bold color={colors.ink60} style={{ letterSpacing: 2, marginTop: 12 }}>
            SEARCHING THE STACKS…
          </MonoText>
        </View>
      ) : results.length === 0 ? (
        <View style={styles.zero}>
          <Text style={styles.zeroTitle}>NOT IN THE STACKS</Text>
          {didYouMean.length > 0 ? (
            <View style={styles.dymWrap}>
              <MonoText size={9.5} bold color={colors.ink60} style={{ letterSpacing: 2 }}>
                DID YOU MEAN
              </MonoText>
              <View style={styles.dymChips}>
                {didYouMean.slice(0, 2).map((c) => (
                  <Brutal key={c.to} haptic shadow={2} style={styles.dymChip} onPress={() => field.setValue(c.to)}>
                    <MonoText size={10.5} bold color={colors.ink}>
                      {c.to.toUpperCase()}
                    </MonoText>
                  </Brutal>
                ))}
              </View>
            </View>
          ) : (
            <MonoText size={10.5} color={colors.ink60} style={styles.zeroSub}>
              {'Nothing verified matches that query. MINDBEAT filed it — results may land as the catalog updates.'}
            </MonoText>
          )}
        </View>
      ) : (
        <ScrollView
          scrollEventThrottle={16}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
            // bottom-of-list probe: results cap at ~3 deep pages, so a plain
            // scroller beats windowing here (the FlatList contract + its
            // locks live on the Home endless feed, not search)
            const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
            if (layoutMeasurement.height + contentOffset.y >= contentSize.height - 480) {
              void loadMoreResults();
            }
          }}
          contentContainerStyle={{ paddingBottom: 170 }}
        >
          <View>
              {meta.sigState === 'partial' ? (
                <View style={styles.sigNote}>
                  <MonoText size={10} bold color={colors.ink} style={{ letterSpacing: 0.8 }} numberOfLines={1}>
                    SONGS MATCHING “{query.trim().toUpperCase()}”
                  </MonoText>
                  <MonoText size={9.5} color={colors.ink60} style={{ marginTop: 4, lineHeight: 15 }}>
                    The artist version isn't available on JioSaavn right now
                  </MonoText>
                  {meta.partialArtists && meta.partialArtists.length > 0 ? (
                    <View style={styles.sigChips}>
                      {meta.partialArtists.slice(0, 5).map((a) => (
                        <Brutal
                          key={a}
                          shadow={2}
                          haptic
                          style={styles.sigChip}
                          onPress={() => {
                            const base = meta.partialTitle?.trim() || planSearch(query).titleTokens.join(' ');
                            const q2 = `${base} ${a}`.trim();
                            field.setValue(q2);
                            runSearch(q2);
                          }}
                        >
                          <MonoText size={9.5} bold color={colors.ink} numberOfLines={1}>
                            {a.toUpperCase()}
                          </MonoText>
                        </Brutal>
                      ))}
                    </View>
                  ) : null}
                </View>
              ) : null}
              {meta.sigState === 'zero' ? (
                <RescueNote>NOTHING VERIFIED HERE — TRY THE YOUTUBE TAB</RescueNote>
              ) : null}
              {meta.ytUnavailable && source === 'youtube' ? (
                <RescueNote>YOUTUBE IS COOLING DOWN AFTER FAILURES — TRY CATALOG</RescueNote>
              ) : null}
              {meta.ytCorrectedTo && source === 'youtube' ? (
                <RescueNote>SHOWING RESULTS FOR “{meta.ytCorrectedTo.toUpperCase()}”</RescueNote>
              ) : null}
              {meta.sigState === 'rescued' && results[0]?.rescueRung === 'youtube' ? (
                <RescueNote acid>FOUND ON YOUTUBE · FULL SONG, AD-FREE</RescueNote>
              ) : null}
              {meta.sigState === 'rescued' && results[0]?.rescueRung === 'itunes' ? (
                <RescueNote>FOUND VIA APPLE MUSIC · 30S PREVIEW</RescueNote>
              ) : null}
              {meta.sigState === 'rescued' && results[0]?.rescueRung === 'variant' ? (
                <RescueNote>FOUND UNDER A DIFFERENT SPELLING</RescueNote>
              ) : null}
              {meta.sigState === 'rescued' && results[0]?.rescueRung === 'album' ? (
                <RescueNote>FOUND VIA ITS ALBUM · FULL SONG</RescueNote>
              ) : null}
              {meta.degraded ? (
                <RescueNote>FULL STREAMS UNAVAILABLE — SOME RESULTS ARE 30S PREVIEWS</RescueNote>
              ) : null}
              {meta.relaxedQuery ? (
                <RescueNote>SHOWING RESULTS FOR “{meta.relaxedQuery.toUpperCase()}”</RescueNote>
              ) : null}
              {meta.corrected && meta.corrected !== query.trim().toLowerCase() ? (
                <Pressable style={styles.sigRescuedNote} onPress={() => field.setValue(meta.corrected ?? query)}>
                  <MonoText size={9.5} bold color={colors.orangeDeep} style={{ letterSpacing: 1 }} numberOfLines={1}>
                    DID YOU MEAN “{meta.corrected.toUpperCase()}”? TAP TO SEARCH
                  </MonoText>
                </Pressable>
              ) : null}
              {/* ── Top result — the verified hero ── */}
              {top ? (
                <View style={styles.topResultWrap}>
                  <View style={styles.resTag}>
                    <View style={styles.resTagCount}>
                      <MonoText size={10} bold color={colors.acid}>
                        {results.length} VERIFIED
                      </MonoText>
                    </View>
                    <MonoText size={10} color={colors.ink60} style={{ letterSpacing: 0.8 }}>
                      {' '}FOR “{query.trim().toUpperCase()}”
                    </MonoText>
                  </View>
                  <Brutal testID="search-top-result" haptic shadow={4} onPress={() => play(0)} style={styles.topCard}>
                    <Artwork uri={top.artwork} seed={top.id} size={92} />
                    <View style={styles.topCardInfo}>
                      <Text style={styles.topCardTitle} numberOfLines={2}>
                        {top.title.toUpperCase()}
                      </Text>
                      <View style={styles.topTypeRow}>
                        <View style={styles.topTypeChip}>
                          <MonoText size={8.5} bold color={colors.ink} style={{ letterSpacing: 1 }}>
                            {top.source === 'youtube'
                              ? top.ytKind === 'video'
                                ? 'YT VIDEO'
                                : 'YT SONG'
                              : top.source === 'itunes'
                                ? 'PREVIEW'
                                : 'SONG'}
                          </MonoText>
                        </View>
                        <MonoText size={9.5} color={colors.ink60} style={{ flex: 1, minWidth: 0 }} numberOfLines={1}>
                          {top.artist.toUpperCase()}
                        </MonoText>
                      </View>
                      {top.lyricMatch && top.matchedLine ? (
                        <View style={styles.lyricChip} testID="top-lyric-chip">
                          <MonoText size={8.5} bold color={colors.ink} numberOfLines={1} style={{ letterSpacing: 0.6 }}>
                            LYRIC MATCH · “{top.matchedLine.toUpperCase()}”
                          </MonoText>
                        </View>
                      ) : top.reason ? (
                        <View style={styles.reasonChip}>
                          <MonoText size={8.5} bold color={colors.ink} numberOfLines={1} style={{ letterSpacing: 0.6 }}>
                            {top.reason.toUpperCase()}
                          </MonoText>
                        </View>
                      ) : null}
                    </View>
                    <View style={styles.topPlayFab}>
                      <Ionicons name="play" size={20} color={colors.acid} />
                    </View>
                  </Brutal>
                  <View style={styles.secLabel}>
                    <MonoText size={9.5} bold color={colors.ink60} style={{ letterSpacing: 2.2 }}>
                      SONGS
                    </MonoText>
                    <View style={styles.secRule} />
                  </View>
                </View>
              ) : null}
          </View>
          {rest.map((item, index) => (
            <TrackRow
              key={item.id}
              track={item}
              index={index + 1}
              showArtwork
              onPress={() => play(index + 1)}
              showHeart={false}
              reasonLabel={item.reason}
              showSource
            />
          ))}
          {loadingMore ? (
            <View style={styles.loadMoreFooter} testID="search-loading-more">
              <ActivityIndicator size="small" color={colors.orange} />
            </View>
          ) : endNote && results.length > 0 ? (
            <View style={styles.endNoteWrap} testID="search-end-note">
              <MonoText size={9.5} bold color={colors.ink40} style={{ letterSpacing: 1.6 }}>
                {endNote.toUpperCase()}
              </MonoText>
            </View>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

/** Honest state note under the top result. */
function RescueNote({ children, acid = false }: { children: React.ReactNode; acid?: boolean }) {
  return (
    <View style={[styles.sigRescuedNote, acid && { backgroundColor: colors.acid, borderColor: colors.ink }]}>
      <MonoText size={9.5} bold color={colors.ink} style={{ letterSpacing: 1 }} numberOfLines={2}>
        {children}
      </MonoText>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  searchWrap: { paddingHorizontal: 18, paddingTop: 14 },
  mastRow: { marginBottom: 8 },
  mastTitle: {
    fontFamily: fonts.display,
    fontSize: 34,
    textTransform: 'uppercase',
    letterSpacing: -0.2,
    lineHeight: 36,
  },
  editionRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 },
  edDot: { width: 7, height: 7, backgroundColor: colors.orange },
  modeRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  modeChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: colors.paper,
    borderWidth: 1.5,
    borderColor: colors.ink,
  },
  chipOn: { backgroundColor: colors.acid },
  vibeChipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 18, paddingBottom: 6 },
  vibeChip: {
    backgroundColor: colors.paper,
    borderWidth: 1.5,
    borderColor: colors.ink,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    backgroundColor: colors.paper,
    borderWidth: 2,
    borderColor: colors.ink,
    paddingHorizontal: 14,
    height: 48,
    ...{ shadowColor: colors.ink, shadowOpacity: 1, shadowRadius: 0, shadowOffset: { width: 4, height: 4 }, elevation: 4 },
  },
  inputRowFocus: {
    ...({ shadowColor: colors.orange, shadowOpacity: 1, shadowRadius: 0, shadowOffset: { width: 4, height: 4 }, elevation: 4 } as object),
  },
  input: {
    flex: 1,
    color: colors.ink,
    fontFamily: fonts.monoBold,
    fontSize: 11.5,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    paddingVertical: 0,
  },
  // ── typeahead rail ──
  suggestWrap: { paddingHorizontal: 18, paddingTop: 8, gap: 2 },
  suggestRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 9,
    paddingHorizontal: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.ink16,
  },
  suggestArt: {
    width: 34,
    height: 34,
    borderWidth: 1.5,
    borderColor: colors.ink,
    backgroundColor: colors.paper2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  suggestArtSquare: {},
  suggestImg: { width: '100%', height: '100%' },
  suggestTitle: { color: colors.ink, fontSize: 13.5, fontFamily: fonts.bold, textTransform: 'uppercase', flexShrink: 1, letterSpacing: 0.2 },
  suggestSub: { color: colors.ink40, fontSize: 10, fontFamily: fonts.mono, textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 2 },
  bestGuess: {
    backgroundColor: colors.acid,
    borderWidth: 1.5,
    borderColor: colors.ink,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  // ── zero-state / did-you-mean ──
  zero: {
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.ink40,
    marginHorizontal: 18,
    marginTop: 22,
    padding: 30,
    alignItems: 'center',
    gap: 8,
  },
  zeroTitle: {
    fontFamily: fonts.display,
    fontSize: 17,
    color: colors.ink,
    textTransform: 'uppercase',
  },
  zeroSub: { textAlign: 'center', lineHeight: 16, letterSpacing: 0.3 },
  dymWrap: { alignItems: 'center', gap: 10, paddingTop: 4 },
  dymChips: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', justifyContent: 'center' },
  dymChip: {
    backgroundColor: colors.paper,
    borderWidth: 1.5,
    borderColor: colors.ink,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  // ── results chrome ──
  recentSection: { paddingTop: 12, paddingBottom: 14 },
  recentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    marginBottom: 10,
  },
  recentsChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 18 },
  recentChip: {
    backgroundColor: colors.paper,
    borderWidth: 1.5,
    borderColor: colors.ink,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  secLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 8,
  },
  secRule: { flex: 1, height: 2, backgroundColor: colors.ink },
  sourceToggleRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  sourceChip: {
    paddingHorizontal: 13,
    paddingVertical: 6,
    backgroundColor: colors.paper,
    borderWidth: 1.5,
    borderColor: colors.ink,
  },
  genreRow: { gap: 10, marginBottom: 10, paddingHorizontal: 18 },
  gcard: {
    flex: 1,
    aspectRatio: 2.4,
    borderWidth: 1.5,
    borderColor: colors.ink,
    backgroundColor: colors.paper,
    paddingHorizontal: 11,
    paddingTop: 9,
    paddingBottom: 7,
  },
  gcardWide: { aspectRatio: 2.4 },
  gcardLabel: {
    color: colors.ink,
    fontFamily: fonts.display,
    fontSize: 13.5,
    textTransform: 'uppercase',
    letterSpacing: 0.2,
  },
  gcardNum: { position: 'absolute', right: 9, bottom: 7 },
  centerWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4, paddingTop: 40 },
  sigNote: {
    marginHorizontal: 18,
    marginTop: 12,
    borderWidth: 1.5,
    borderColor: colors.ink,
    backgroundColor: colors.paper2,
    padding: 12,
  },
  sigChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  sigChip: {
    backgroundColor: colors.paper,
    borderWidth: 1.5,
    borderColor: colors.ink,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  sigRescuedNote: {
    marginHorizontal: 18,
    marginTop: 12,
    borderWidth: 1.5,
    borderColor: colors.ink,
    paddingHorizontal: 10,
    paddingVertical: 7,
    alignSelf: 'flex-start',
  },
  topResultWrap: { paddingTop: 10 },
  resTag: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    paddingHorizontal: 18,
    paddingTop: 8,
    paddingBottom: 10,
  },
  resTagCount: { backgroundColor: colors.ink, paddingHorizontal: 7, paddingVertical: 2 },
  topCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginHorizontal: 18,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.paper,
    padding: 12,
  },
  topCardInfo: { flex: 1, minWidth: 0 },
  topCardTitle: {
    color: colors.ink,
    fontFamily: fonts.display,
    fontSize: 17,
    lineHeight: 18,
    textTransform: 'uppercase',
  },
  topTypeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  topTypeChip: {
    borderWidth: 1.5,
    borderColor: colors.ink,
    paddingHorizontal: 6,
    paddingVertical: 2,
    alignSelf: 'flex-start',
  },
  topPlayFab: {
    width: 44,
    height: 44,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reasonChip: {
    alignSelf: 'flex-start',
    backgroundColor: colors.acid,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginTop: 6,
  },
  lyricChip: {
    alignSelf: 'flex-start',
    backgroundColor: colors.acid,
    borderWidth: 1.5,
    borderColor: colors.ink,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginTop: 6,
  },
  loadMoreFooter: { paddingVertical: 18, alignItems: 'center' },
  endNoteWrap: { alignItems: 'center', paddingVertical: 18 },
});
