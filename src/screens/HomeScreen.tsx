/**
 * Home — PULSE Front Page (v4.0 editorial brutalism):
 *
 *   masthead (edition + huge greeting w/ outlined name + avatar) →
 *   filter chips → Now Sound daypart hero (ink card + acid play) →
 *   broadsheet ticker → numbered quick tiles → Made for {name} →
 *   Jump back in → Popular artists (grayscale square stamps) →
 *   Trending (numbered chart) → On the Rise → Because you listened →
 *   New releases → Featured playlists → charts → endless feed.
 *
 * R8-P1 architecture intact: the feed renders through a windowed
 * FlatList with memo'd FeedSongRow / FeedAlbumShelf / HomeHeader —
 * appends re-render only the new rows. Every algorithmic shelf stays
 * safety-filtered; editorial shelves render through collectionIsClean.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Collection, DailyMix, Track, WeeklyCrate } from '../types';
import {
  collectionIsClean,
  getCharts,
  getCollectionTracks,
  getHomepageFeed,
  getTrending,
  primaryArtistName,
  searchAlbumCollections,
  searchSaavn,
} from '../api/saavn';
import { EndlessFeedPager, type FeedBatch } from '../api/feed';
import { ARTIST_SEEDS, cleanArtistName, lookupArtistPhoto, type ArtistInfo } from '../api/artists';
import { getBecauseYouListened, getDailyMixes } from '../ai/engine';
import { mindbeat } from '../ai/mindbeat';
import type { NowSoundCard } from '../ai/surfaces/daylist';
import type { OnTheRiseCard } from '../ai/surfaces/ontherise';
import {
  getChartsCache,
  getFavorites,
  getHomeFeedCache,
  getRecents,
  getReducedHaptics,
  setChartsCache,
  setHomeFeedCache,
} from '../storage/store';
import { usePlayer } from '../player/PlayerProvider';
import { hapticEvent, fireHaptic } from '../player/haptics';
import { QuickTile, Shelf, ShelfCard, ArtistCard } from '../components/Shelf';
import { TrackRow } from '../components/TrackRow';
import { Artwork } from '../components/Artwork';
import { ShelfSkeleton } from '../components/ShelfSkeleton';
import { Brutal, MonoText, OutlineText, Ticker } from '../components/Brutal';
import { colors, fonts } from '../theme';
import type { RootStackParamList } from './navigation';
import { perfMark } from '../perf/perf';

type Chip = 'all' | 'music' | 'ai';

const POPULAR_ARTIST_COUNT = 10;

function daypart(): [string, string] {
  const h = new Date().getHours();
  if (h >= 23 || h < 5) return ['Late Night Frequencies', 'Quiet-hours dispatch — lo-fi, medleys, long drives.'];
  if (h < 12) return ['Morning Momentum', 'Front-loaded openers — devotional calm into easy anthems.'];
  if (h < 17) return ['Afternoon Drift', 'Mid-tempo flow to carry the day. No skips filed.'];
  return ['Evening Glow', 'Golden-hour energy, rebuilt from the mixes you outgrew.'];
}

export function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { width: winWidth } = useWindowDimensions();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { playQueue } = usePlayer();
  const [chip, setChip] = useState<Chip>('all');

  const [mixes, setMixes] = useState<DailyMix[] | null>(null);
  const [crate, setCrate] = useState<WeeklyCrate | null>(null);
  const [trending, setTrending] = useState<Track[] | null>(null);
  const [because, setBecause] = useState<Array<{ artist: string; seedTrack?: Track }>>([]);
  const [charts, setCharts] = useState<Collection[]>([]);
  const [recents, setRecents] = useState<Track[]>([]);
  const [favorites, setFavorites] = useState<Track[]>([]);
  const [nowSound, setNowSound] = useState<NowSoundCard | null>(null);
  const [onTheRise, setOnTheRise] = useState<OnTheRiseCard | null>(null);
  const [newAlbums, setNewAlbums] = useState<Collection[]>([]);
  const [featured, setFeatured] = useState<Collection[]>([]);
  const [popularArtists, setPopularArtists] = useState<ArtistInfo[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [offline, setOffline] = useState(false);
  const [userName, setUserName] = useState('');

  // ── Endless feed state (F2) ───────────────────────────────────────
  const [feedBatches, setFeedBatches] = useState<FeedBatch[]>([]);
  const [feedState, setFeedState] = useState<'idle' | 'loading' | 'retry' | 'exhausted'>('idle');
  const pagerRef = useRef<EndlessFeedPager | null>(null);
  const feedSongsRef = useRef<Track[]>([]); // one long queue across batches (F3)
  // F10 — the crate haptic must not buzz after the screen is gone
  const loadAliveRef = useRef(true);
  useEffect(() => {
    loadAliveRef.current = true;
    return () => {
      loadAliveRef.current = false;
    };
  }, []);
  const feedBusyRef = useRef(false);
  // CRITIC P2-1 fix: pull-to-refresh epoch — a batch fetched by the OLD
  // pager must never append into the freshly-reset feed.
  const feedEpochRef = useRef(0);
  // CRITIC P2-4 fix: the feed only starts after the fixed shelves settled
  // (trending loaded or failed) so prime() sees them and the feed never
  // duplicates rows the shelves are about to render.
  const feedPrimedRef = useRef(false);

  const play = useCallback(
    (tracks: Track[], index: number) => {
      if (tracks.length) {
        playQueue(tracks, index);
        nav.navigate('Player');
      }
    },
    [playQueue, nav],
  );

  const openTrackCollection = useCallback(
    (title: string, tracks: Track[]) => {
      nav.navigate('Collection', {
        collection: { id: `local-${title}`, title, artwork: tracks[0]?.artwork ?? '' },
        tracks,
      });
    },
    [nav],
  );

  /** Popular artists: profile top artists first, onboarding seeds next,
   *  curated A-listers filling the rail. Photos resolve from the seed
   *  map; unknown names get at most 6 live lookups + honest initials. */
  const loadPopularArtists = useCallback(async () => {
    try {
      await mindbeat.ready();
    } catch {
      /* rail still renders from seeds */
    }
    let names: string[] = [];
    try {
      names = mindbeat.topArtistNames(8);
    } catch {
      names = [];
    }
    try {
      const seeds = (await mindbeat.kvGet<string[]>('onboardingSeeds')) ?? [];
      names = [...names, ...seeds];
    } catch {
      /* seeds optional */
    }
    const seen = new Set<string>();
    for (const s of ARTIST_SEEDS) {
      if (names.length >= POPULAR_ARTIST_COUNT) break;
      if (!seen.has(s.name.toLowerCase())) names.push(s.name);
    }
    const unique: string[] = [];
    for (const n of names) {
      const k = n.trim().toLowerCase();
      if (k && !seen.has(k)) {
        seen.add(k);
        unique.push(n.trim());
      }
      if (unique.length >= POPULAR_ARTIST_COUNT) break;
    }
    const seedMap = new Map(ARTIST_SEEDS.map((a) => [a.name.toLowerCase(), a]));
    const rail: ArtistInfo[] = unique.map(
      (n) => seedMap.get(n.toLowerCase()) ?? { name: n },
    );
    setPopularArtists(rail);
    rail
      .filter((a) => !a.image)
      // every photo-less rail name gets a lookup (the old 6-cap starved
      // the tail of a 10-name rail — tiles wore initials unnecessarily);
      // lookupArtistPhoto memoizes negatives, so repeats are free
      .slice(0, POPULAR_ARTIST_COUNT)
      .forEach((a) => {
        lookupArtistPhoto(a.name)
          .then((img) => {
            if (!img) return;
            setPopularArtists((prev) => prev.map((x) => (x.name === a.name ? { ...x, image: img } : x)));
          })
          .catch(() => undefined);
      });
  }, []);

  const loadFeed = useCallback(async (force = false) => {
    if (!force) {
      const cached = await getHomeFeedCache();
      if (cached) {
        setNewAlbums(cached.newAlbums.filter(collectionIsClean));
        setFeatured(cached.featured.filter(collectionIsClean));
      }
    }
    try {
      const feed = await getHomepageFeed();
      const cleanAlbums = feed.newAlbums.filter(collectionIsClean).slice(0, 12);
      const cleanFeatured = feed.featured.filter(collectionIsClean).slice(0, 12);
      if (cleanAlbums.length) setNewAlbums(cleanAlbums);
      if (cleanFeatured.length) setFeatured(cleanFeatured);
      if (cleanAlbums.length || cleanFeatured.length) {
        void setHomeFeedCache({ newAlbums: cleanAlbums, featured: cleanFeatured });
      }
    } catch {
      /* cached shelves (if any) stay up */
    }
  }, []);

  const load = useCallback(
    async (force = false) => {
      const [rec, favs] = await Promise.all([getRecents(), getFavorites()]);
      setRecents(rec);
      setFavorites(favs);

      if (!force) {
        const cached = await getChartsCache();
        if (cached && cached.length) setCharts(cached.map((s) => s.collection));
      }

      mindbeat
        .dailyMixes()
        .then((v2) => (v2.length ? setMixes(v2) : getDailyMixes().then(setMixes)))
        .catch(() => getDailyMixes().then(setMixes).catch(() => setMixes([])));
      getBecauseYouListened(2)
        .then(setBecause)
        .catch(() => setBecause([]));
      mindbeat.nowSound().then(setNowSound).catch(() => undefined);
      mindbeat.onTheRise().then(setOnTheRise).catch(() => undefined);
      mindbeat
        .weeklyCrate()
        .then((c) => {
          setCrate(c);
          // MAGNUM OPUS F10 — the crate-generate haptic: a fresh edition
          // landed. Fires on FORCE refreshes only (a pull-to-refresh that
          // actually rebuilt the crate), never on the silent cached load,
          // only when the user's reducedHaptics switch allows it, and
          // never after this screen unmounted (blind-critic P2).
          if (c && force) {
            getReducedHaptics()
              .then((reduced) => {
                if (!loadAliveRef.current) return;
                const decision = hapticEvent('crate-generate', {}, 0, { reducedHaptics: reduced, lastBeatIndex: 0 });
                if (decision) void fireHaptic(decision.spec);
              })
              .catch(() => undefined);
          }
        })
        .catch(() => setCrate(null));
      void loadPopularArtists();
      void loadFeed(force);

      try {
        const [trend, chartList] = await Promise.all([
          getTrending(14).catch(() => [] as Track[]),
          getCharts().catch(() => [] as Collection[]),
        ]);
        if (trend.length) setTrending(trend);
        if (chartList.length) {
          const cleanCharts = chartList.filter(collectionIsClean);
          setCharts(cleanCharts);
          getCollectionTracks(cleanCharts[0]?.id ?? '')
            .then((tracks) => {
              if (cleanCharts.length && tracks.length) {
                setChartsCache(cleanCharts.map((collection) => ({ collection, tracks: [] })));
              }
            })
            .catch(() => undefined);
        }
        setOffline(false);
        if (!trend.length && !chartList.length) setOffline(true);
      } catch {
        setOffline(true);
      } finally {
        feedPrimedRef.current = true;
      }
    },
    [loadFeed, loadPopularArtists],
  );

  useEffect(() => {
    load();
  }, [load]);

  // [TSF-PERF] first real content on the Front Page — the lab's
  // time-to-first-content marker (scripts/e2e/parse_perf.py).
  const homePaintedRef = useRef(false);
  useEffect(() => {
    if (homePaintedRef.current) return;
    if (feedBatches.length > 0 || popularArtists.length > 0) {
      homePaintedRef.current = true;
      perfMark('home-first-data', String(feedBatches.length + popularArtists.length));
    }
  }, [feedBatches, popularArtists]);

  const resetFeed = useCallback(() => {
    feedEpochRef.current += 1;
    pagerRef.current = null;
    feedSongsRef.current = [];
    feedBusyRef.current = false;
    feedPrimedRef.current = false;
    setFeedBatches([]);
    setFeedState('idle');
  }, []);

  const ensurePager = useCallback((): EndlessFeedPager => {
    if (!pagerRef.current) {
      pagerRef.current = new EndlessFeedPager(
        {
          searchSongs: (q, page, signal) => searchSaavn(q, 30, signal, page),
          searchAlbums: (q, page, signal) => searchAlbumCollections(q, page, 20, signal),
        },
        // BAR 3.7 — the feed reads the room: MINDBEAT yields dynamic
        // queries from profile genres/moods + session vibe; an empty
        // yield (cold start / kill switch) keeps the legacy ladder.
        { songQueryGenerator: () => mindbeat.feedSongQueries() },
      );
      pagerRef.current.prime({
        songs: trending ?? undefined,
        albums: [...newAlbums, ...featured, ...charts],
      });
    }
    return pagerRef.current;
  }, [trending, newAlbums, featured, charts]);

  const loadFeedMore = useCallback(async () => {
    if (feedBusyRef.current || feedState === 'retry' || feedState === 'exhausted') return;
    if (!feedPrimedRef.current) return;
    const pager = ensurePager();
    if (pager.isExhausted) return;
    const epoch = feedEpochRef.current;
    feedBusyRef.current = true;
    setFeedState('loading');
    try {
      const batch = await pager.next();
      if (epoch !== feedEpochRef.current) return;
      if (batch === null) {
        setFeedState('exhausted');
      } else if (batch.kind === 'retry') {
        setFeedState('retry');
      } else {
        if (batch.kind === 'songs') {
          feedSongsRef.current = [...feedSongsRef.current, ...batch.songs];
        }
        setFeedBatches((prev) => [...prev, batch]);
        setFeedState('idle');
      }
    } catch {
      if (epoch === feedEpochRef.current) setFeedState('retry');
    } finally {
      feedBusyRef.current = false;
    }
  }, [ensurePager, feedState]);

  const retryFeed = useCallback(() => {
    if (feedState !== 'retry') return;
    setFeedState('idle');
    void loadFeedMore();
  }, [feedState, loadFeedMore]);

  /** Play an endless-feed song with ALL loaded feed songs as the queue (F3). */
  const playFeedSong = useCallback(
    (track: Track) => {
      const queue = feedSongsRef.current;
      const idx = queue.findIndex((t) => t.id === track.id);
      if (queue.length) {
        playQueue(queue, Math.max(0, idx), 'home_feed');
        nav.navigate('Player');
      }
    },
    [playQueue, nav],
  );

  useEffect(() => {
    AsyncStorage.getItem('tsf.userName')
      .then((n) => n && setUserName(n))
      .catch(() => undefined);
    mindbeat
      .kvGet<string>('userName')
      .then((n) => n && setUserName(n))
      .catch(() => undefined);
    return mindbeat.onProfile(() => {
      mindbeat
        .kvGet<string>('userName')
        .then((n) => n && setUserName(n))
        .catch(() => undefined);
    });
  }, []);

  const hasMixes = !!mixes && mixes.length > 0;
  const loading = mixes === null && trending === null;
  const showAI = chip !== 'music';

  const openArtist = useCallback(
    (artist: string) =>
      nav.navigate('Collection', {
        collection: {
          id: `artist-${artist}`,
          title: artist,
          subtitle: 'Artist',
          artwork: popularArtists.find((a) => a.name === artist)?.image ?? '',
          kind: 'artist',
          // joined credit strings search 0 rows on the provider — the
          // radio must be seeded with the PRIMARY name (probe-verified)
          query: primaryArtistName(artist) || artist,
        },
      }),
    [nav, popularArtists],
  );
  const openCollection = useCallback(
    (c: Collection) => nav.navigate('Collection', { collection: c }),
    [nav],
  );
  const onGoAI = useCallback(() => nav.navigate('AI'), [nav]);

  // ── Endless feed → windowed FlatList rows (R8-P1) ──────────────────
  const feedItems = useMemo<FeedItem[]>(() => {
    const items: FeedItem[] = [];
    feedBatches.forEach((batch, bi) => {
      if (batch.kind === 'songs') {
        items.push({ k: 'header', key: `fh-${bi}`, title: batch.title });
        batch.songs.forEach((t) => items.push({ k: 'song', key: t.id, track: t }));
      } else if (batch.kind === 'albums') {
        items.push({ k: 'albumShelf', key: `fa-${bi}`, title: batch.title, albums: batch.albums });
      }
    });
    return items;
  }, [feedBatches]);

  const feedKeyExtractor = useCallback((item: FeedItem) => item.key, []);
  const renderFeedItem = useCallback(
    ({ item }: { item: FeedItem }) => {
      if (item.k === 'header') return <FeedHeaderRow title={item.title} />;
      if (item.k === 'song') return <FeedSongRow track={item.track} onPlay={playFeedSong} />;
      return <FeedAlbumShelf title={item.title} albums={item.albums} onOpen={openCollection} />;
    },
    [playFeedSong, openCollection],
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <FlatList
        data={feedItems}
        scrollEventThrottle={16}
        keyExtractor={feedKeyExtractor}
        renderItem={renderFeedItem}
        ListHeaderComponent={
          <HomeHeader
            chip={chip}
            setChip={setChip}
            userName={userName}
            offline={offline}
            loading={loading}
            showAI={showAI}
            hasMixes={hasMixes}
            mixes={mixes}
            crate={crate}
            favorites={favorites}
            nowSound={nowSound}
            recents={recents}
            popularArtists={popularArtists}
            trending={trending}
            onTheRise={onTheRise}
            because={because}
            newAlbums={newAlbums}
            featured={featured}
            charts={charts}
            winWidth={winWidth}
            play={play}
            openTrackCollection={openTrackCollection}
            openArtist={openArtist}
            onGoAI={onGoAI}
          />
        }
        ListFooterComponent={
          <FeedFooter
            loading={loading}
            feedState={feedState}
            onRetry={retryFeed}
            showEmpty={!hasMixes && recents.length === 0 && (!trending || trending.length === 0)}
            onGoAI={onGoAI}
          />
        }
        onEndReached={() => {
          if (!loading) void loadFeedMore();
        }}
        onEndReachedThreshold={1}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              resetFeed();
              load(true).finally(() => setRefreshing(false));
            }}
            tintColor={colors.orange}
            colors={[colors.orange]}
          />
        }
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 190 }}
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={9}
        updateCellsBatchingPeriod={40}
      />
    </View>
  );
}

// ── R8-P1 windowed-feed primitives ─────────────────────────────────────────

type FeedItem =
  | { k: 'header'; key: string; title: string }
  | { k: 'song'; key: string; track: Track }
  | { k: 'albumShelf'; key: string; title: string; albums: Collection[] };

/** Feed section header — editorial sec-label with the hard rule. */
const FeedHeaderRow = React.memo(function FeedHeaderRow({ title }: { title: string }) {
  return (
    <View style={styles.feedSection} testID="endless-feed-songs">
      <View style={styles.secLabel}>
        <Text style={styles.secLabelText}>{title}</Text>
        <View style={styles.secLabelRule} />
      </View>
    </View>
  );
});

/** A feed song row — memo holds across feed appends (stable track ref +
 *  stable onPlay), so TrackRow re-renders only on player changes. */
const FeedSongRow = React.memo(function FeedSongRow({
  track,
  onPlay,
}: {
  track: Track;
  onPlay: (t: Track) => void;
}) {
  return (
    <View testID="endless-feed-song">
      <TrackRow track={track} onPress={() => onPlay(track)} />
    </View>
  );
});

/** A feed album shelf batch (cards in a horizontal rail). */
const FeedAlbumShelf = React.memo(function FeedAlbumShelf({
  title,
  albums,
  onOpen,
}: {
  title: string;
  albums: Collection[];
  onOpen: (c: Collection) => void;
}) {
  return (
    <Shelf title={title}>
      {albums.map((c, i) => (
        <ShelfCard
          key={c.id}
          title={c.title}
          subtitle={c.subtitle}
          artwork={c.artwork}
          seed={`feed-album-${c.id}`}
          size={150}
          index={String(i + 1).padStart(2, '0')}
          onPress={() => onOpen(c)}
        />
      ))}
    </Shelf>
  );
});

/** Spinner / retry row / honest end marker + the broadsheet colophon. */
const FeedFooter = React.memo(function FeedFooter({
  loading,
  feedState,
  onRetry,
  showEmpty,
  onGoAI,
}: {
  loading: boolean;
  feedState: 'idle' | 'loading' | 'retry' | 'exhausted';
  onRetry: () => void;
  showEmpty: boolean;
  onGoAI: () => void;
}) {
  if (loading) return null;
  return (
    <>
      {feedState === 'loading' ? (
        <ActivityIndicator color={colors.orange} style={styles.feedSpinner} />
      ) : null}
      {feedState === 'retry' ? (
        <Brutal haptic shadow={2} onPress={onRetry} style={styles.feedRetry}>
          <MonoText size={10.5} bold color={colors.ink60}>
            COULDN'T LOAD MORE — TAP TO RETRY
          </MonoText>
        </Brutal>
      ) : null}
      {feedState === 'exhausted' ? (
        <View style={styles.feedEndWrap} testID="endless-feed-end">
          <MonoText size={10} color={colors.ink40} style={{ letterSpacing: 1.6 }}>
            — END OF THE EDITION —
          </MonoText>
        </View>
      ) : null}
      {showEmpty ? <EmptyHome onGoAI={onGoAI} /> : null}
      <View style={styles.footerDivider}>
        <View style={styles.footerRule} />
        <MonoText size={9} color={colors.ink40} style={{ letterSpacing: 1.4 }}>
          TSF MUSIC · PULSE EDITION · 320 KBPS ALWAYS
        </MonoText>
      </View>
    </>
  );
});

/** The fixed shelves. Memo'd: feed appends and feed-state flips CANNOT
 *  re-render this subtree — only actual shelf data changes do. */
const HomeHeader = React.memo(function HomeHeader({
  chip,
  setChip,
  userName,
  offline,
  loading,
  showAI,
  hasMixes,
  mixes,
  crate,
  favorites,
  nowSound,
  recents,
  popularArtists,
  trending,
  onTheRise,
  because,
  newAlbums,
  featured,
  charts,
  winWidth,
  play,
  openTrackCollection,
  openArtist,
  onGoAI,
}: {
  chip: Chip;
  setChip: (c: Chip) => void;
  userName: string;
  offline: boolean;
  loading: boolean;
  showAI: boolean;
  hasMixes: boolean;
  mixes: DailyMix[] | null;
  crate: WeeklyCrate | null;
  favorites: Track[];
  nowSound: NowSoundCard | null;
  recents: Track[];
  popularArtists: ArtistInfo[];
  trending: Track[] | null;
  onTheRise: OnTheRiseCard | null;
  because: Array<{ artist: string; seedTrack?: Track }>;
  newAlbums: Collection[];
  featured: Collection[];
  charts: Collection[];
  winWidth: number;
  play: (tracks: Track[], index: number) => void;
  openTrackCollection: (title: string, tracks: Track[]) => void;
  openArtist: (artist: string) => void;
  onGoAI: () => void;
}) {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  // ── On The Rise wears the ARTIST's photo (v4.0.1) ──────────────────
  // The cards used to borrow the SONG's album cover while labeled as the
  // artist — the wrong-image class the sanitize gate rejects everywhere
  // else. Real photos resolve like the Popular Artists rail (seed cache →
  // live lookup); artists with no photo wear an honest initials stamp.
  const [riseArt, setRiseArt] = useState<Record<string, string>>({});
  const riseKeys = useMemo(
    () =>
      (onTheRise?.tracks.slice(0, 10) ?? [])
        .map((t) => cleanArtistName(t.artist))
        .filter(Boolean) as string[],
    [onTheRise],
  );
  useEffect(() => {
    const unique = [...new Set(riseKeys)].slice(0, 6);
    unique.forEach((name) => {
      if (riseArt[name] !== undefined) return;
      lookupArtistPhoto(name)
        .then((img) => setRiseArt((prev) => ({ ...prev, [name]: img ?? '' })))
        .catch(() => undefined);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [riseKeys]);

  const h = new Date().getHours();
  const dayWord = h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening';
  const greeting = h < 12 ? 'Good morning,' : h < 17 ? 'Good afternoon,' : 'Good evening,';
  const [dpTitle, dpSub] = daypart();

  // ticker items — memo'd so the marquee never restarts on re-render
  const tickerItems = useMemo(() => {
    const items = [
      trending?.[0] ? `NOW CHARTING · ${trending[0].title.toUpperCase()}` : '320 KBPS · ALWAYS',
      'MINDBEAT · RECOMMENDATIONS EXPLAIN THEMSELVES',
      newAlbums[0] ? `NEW DROP · ${newAlbums[0].title.toUpperCase()}` : 'JIOSAAVN · FULL CATALOG',
      'SEARCH · TYPO-TOLERANT · LYRIC-VERIFIED',
      favorites.length ? `YOUR CRATES · ${favorites.length} LIKED` : 'PULL TO REFRESH THE EDITION',
    ];
    return items;
  }, [trending, newAlbums, favorites.length]);

  const quickTiles: Array<{
    title: string;
    subtitle?: string;
    artwork?: string;
    seed: string;
    icon?: keyof typeof Ionicons.glyphMap;
    liked?: boolean;
    acid?: boolean;
    onPress: () => void;
  }> = [];
  if (favorites.length > 0)
    quickTiles.push({
      title: 'Liked Songs',
      subtitle: `${favorites.length} filed`,
      seed: 'liked-songs',
      liked: true,
      onPress: () => openTrackCollection('Liked Songs', favorites),
    });
  if (hasMixes)
    mixes!.slice(0, 3).forEach((m) =>
      quickTiles.push({
        title: m.title,
        subtitle: m.subtitle,
        artwork: m.artwork,
        seed: m.id,
        onPress: () => openTrackCollection(m.title, m.tracks),
      }),
    );
  if (trending && trending.length > 0)
    quickTiles.push({
      title: 'Trending',
      subtitle: 'Hot hits',
      artwork: trending[0].artwork,
      seed: 'trending',
      onPress: () => openTrackCollection('Trending now', trending),
    });
  recents.slice(0, 2).forEach((t) =>
    quickTiles.push({
      title: t.title,
      subtitle: t.artist,
      artwork: t.artwork,
      seed: `recent-${t.id}`,
      onPress: () => play(recents, Math.max(0, recents.findIndex((r) => r.id === t.id))),
    }),
  );
  if (quickTiles.length > 0)
    quickTiles.push({
      title: 'AI Playlists',
      subtitle: 'File with the Wire',
      seed: 'ai-tile',
      icon: 'sparkles-outline',
      acid: true,
      onPress: onGoAI,
    });
  const quickTileList = quickTiles.slice(0, 8);

  const heroTracks = nowSound && nowSound.tracks.length > 0 ? nowSound.tracks : trending?.length ? trending : null;
  const heroTitle = nowSound && nowSound.tracks.length > 0 ? nowSound.title : dpTitle;
  const heroSub = nowSound && nowSound.tracks.length > 0 ? nowSound.subtitle : dpSub;

  const runHero = () => {
    if (heroTracks) {
      play(heroTracks as unknown as Track[], 0);
    } else {
      onGoAI();
    }
  };

  return (
    <>
      {/* ── masthead ── */}
      <View style={styles.masthead}>
        <View style={styles.mastRow}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={styles.editionRow}>
              <View style={styles.edDot} />
              <MonoText size={9.5} bold color={colors.ink60} style={{ letterSpacing: 1.8 }}>
                {dayWord.toUpperCase()} EDITION
              </MonoText>
              <MonoText size={9.5} color={colors.ink40} style={{ letterSpacing: 1.8 }}>
                VOL. 34
              </MonoText>
            </View>
            <Text style={styles.huge} allowFontScaling={false}>
              {greeting}
            </Text>
            <OutlineText style={styles.hugeOutline} outline={1.6}>
              {(userName || 'Reader').toUpperCase()}
            </OutlineText>
          </View>
          <Brutal
            haptic
            shadow={3}
            onInk
            onPress={() => nav.navigate('Stats')}
            style={styles.avatar}
            testID="home-avatar"
          >
            <Text style={styles.avatarText}>{(userName || 'T').slice(0, 1).toUpperCase()}</Text>
          </Brutal>
        </View>
      </View>

      {offline ? (
        <View style={styles.offlineChip}>
          <Ionicons name="cloud-offline-outline" size={13} color={colors.ink60} />
          <MonoText size={9.5} bold color={colors.ink60}>
            OFFLINE — PULL TO RETRY
          </MonoText>
        </View>
      ) : null}

      {/* ── chips ── */}
      <View style={styles.chipRow}>
        {(['all', 'music', 'ai'] as Chip[]).map((c) => (
          <Brutal
            key={c}
            haptic={chip !== c}
            shadow={2}
            onPress={() => setChip(c)}
            style={[styles.chip, chip === c && styles.chipActive]}
          >
            <MonoText size={11.5} bold color={chip === c ? colors.ink : colors.ink60} style={{ letterSpacing: 0.8 }}>
              {c === 'all' ? 'All' : c === 'music' ? 'Music' : 'AI'}
            </MonoText>
          </Brutal>
        ))}
      </View>

      {/* ── Now Sound hero ── */}
      {showAI && heroTitle ? (
        <View style={styles.heroShelf}>
          <View style={styles.shelfHeadRow}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <MonoText size={9} bold color={colors.orangeDeep} style={{ letterSpacing: 2 }} numberOfLines={1}>
                MINDBEAT FEATURE · UPDATES WITH YOUR DAY
              </MonoText>
              <Text style={styles.shelfHeadTitle}>Now Sound</Text>
            </View>
            <Brutal haptic shadow={0} pressOffset={1} onPress={runHero} style={styles.heroRun}>
              <MonoText size={10} bold color={colors.ink60}>
                RUN IT ▸
              </MonoText>
            </Brutal>
          </View>
          <Brutal haptic shadow={5} onInk onPress={runHero} style={styles.heroCard}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.heroTitle} allowFontScaling={false}>
                {heroTitle.toUpperCase()}
              </Text>
              <MonoText size={10.5} color={colors.onInk60} style={{ lineHeight: 16, marginTop: 8 }} numberOfLines={2}>
                {heroSub}
              </MonoText>
            </View>
            <View style={styles.heroPlay}>
              <Ionicons name="play" size={18} color={colors.ink} />
            </View>
          </Brutal>
        </View>
      ) : null}

      {/* ── the ticker ── */}
      <Ticker items={tickerItems} />

      {/* ── numbered quick tiles ── */}
      {quickTileList.length > 0 && (
        <View style={styles.quickGrid}>
          {quickTileList.map((t, i) => (
            <QuickTile
              key={t.seed}
              title={t.title}
              subtitle={t.subtitle}
              artwork={t.artwork}
              seed={t.seed}
              icon={t.icon}
              liked={t.liked}
              acid={t.acid}
              width={quickTileWidth(winWidth)}
              onPress={t.onPress}
            />
          ))}
        </View>
      )}

      {loading ? (
        <ShelfSkeleton />
      ) : (
        <>
          {crate && showAI ? (
            <Shelf
              kicker={userName ? `MADE FOR ${userName.toUpperCase()} · NEW EVERY MONDAY` : 'MADE FOR YOU · NEW EVERY MONDAY'}
              title="The Weekly Crate"
            >
              <ShelfCard
                title={crate.title}
                subtitle={crate.subtitle}
                artwork={crate.artwork}
                seed={crate.id}
                size={275}
                onPress={() => openTrackCollection('The Weekly Crate', crate.tracks)}
              />
            </Shelf>
          ) : null}

          {hasMixes && showAI ? (
            <Shelf kicker={userName ? `MADE FOR ${userName.toUpperCase()}` : 'MADE FOR YOU'} title="Daily Mixes">
              {mixes!.map((mix) => (
                <ShelfCard
                  key={mix.id}
                  title={mix.title}
                  subtitle={mix.subtitle}
                  artwork={mix.artwork}
                  seed={mix.id}
                  size={150}
                  onPress={() => openTrackCollection(mix.title, mix.tracks)}
                />
              ))}
              <AICreateCard onPress={() => nav.navigate('AI')} />
            </Shelf>
          ) : null}

          {recents.length > 0 ? (
            <Shelf kicker="THE REWIND DESK" title="Jump Back In">
              {recents.slice(0, 10).map((t) => (
                <ShelfCard
                  key={t.id}
                  title={t.title}
                  subtitle={t.artist}
                  artwork={t.artwork}
                  seed={t.id}
                  size={150}
                  onPress={() => play(recents, Math.max(0, recents.findIndex((r) => r.id === t.id)))}
                />
              ))}
            </Shelf>
          ) : null}

          {popularArtists.length > 0 ? (
            <Shelf kicker="THE PHOTO DESK" title="Popular Artists">
              {popularArtists.map((a) => (
                <ArtistCard
                  key={a.name}
                  name={a.name}
                  meta="Artist"
                  artwork={a.image}
                  seed={a.name}
                  onPress={() => openArtist(a.name)}
                />
              ))}
            </Shelf>
          ) : null}

          {trending && trending.length > 0 ? (
            <Shelf
              kicker={`CHART · WEEK ${weekNumber()}`}
              title="Trending Now"
              actionLabel="Full list"
              onAction={() => openTrackCollection('Trending now', trending)}
            >
              {trending.slice(0, 10).map((t, i) => (
                <ShelfCard
                  key={t.id}
                  title={t.title}
                  subtitle={t.artist}
                  artwork={t.artwork}
                  seed={t.id}
                  size={150}
                  index={String(i + 1).padStart(2, '0')}
                  onPress={() => play(trending, Math.max(0, trending.findIndex((x) => x.id === t.id)))}
                />
              ))}
            </Shelf>
          ) : null}

          {onTheRise && onTheRise.tracks.length > 2 && showAI ? (
            <Shelf kicker="DISCOVERY DESK" title="On The Rise">
              {onTheRise.tracks.slice(0, 10).map((t) => {
                const key = cleanArtistName(t.artist) || t.artist;
                const railArt = popularArtists.find((a) => a.name === t.artist)?.image;
                return (
                  <ArtistCard
                    key={t.id}
                    name={t.artist}
                    meta={`via ${t.viaArtist}`}
                    artwork={railArt ?? riseArt[key]}
                    seed={`rise-${t.id}`}
                    onPress={() =>
                      openTrackCollection('On the Rise', onTheRise.tracks as unknown as Track[])
                    }
                  />
                );
              })}
            </Shelf>
          ) : null}

          {because.map(({ artist, seedTrack }) => (
            <Shelf key={artist} kicker={`FROM THE ${artist.toUpperCase()} LEDGER`} title="Because You Listened">
              <ArtistCard
                name={artist}
                meta="Artist radio"
                artwork={popularArtists.find((a) => a.name === artist)?.image}
                seed={`because-${artist}`}
                onPress={() => openArtist(artist)}
              />
              {seedTrack ? (
                <ShelfCard
                  title={seedTrack.title}
                  subtitle={seedTrack.artist}
                  artwork={seedTrack.artwork}
                  seed={`because-${seedTrack.id}`}
                  size={150}
                  onPress={() =>
                    nav.navigate('Collection', {
                      collection: {
                        id: `artist-${artist}`,
                        title: artist,
                        subtitle: 'Artist radio',
                        artwork: popularArtists.find((a) => a.name === artist)?.image ?? '',
                        kind: 'artist',
                        query: primaryArtistName(artist) || artist,
                      },
                    })
                  }
                />
              ) : null}
            </Shelf>
          ))}

          {newAlbums.length > 0 ? (
            <Shelf kicker="FRESH INK" title="New Releases">
              {newAlbums.map((c) => (
                <ShelfCard
                  key={c.id}
                  title={c.title}
                  subtitle={c.subtitle}
                  artwork={c.artwork}
                  seed={`album-${c.id}`}
                  size={150}
                  onPress={() => nav.navigate('Collection', { collection: c })}
                />
              ))}
            </Shelf>
          ) : null}

          {featured.length > 0 ? (
            <Shelf kicker="FROM THE EDITORS" title="Featured Playlists">
              {featured.map((c) => (
                <ShelfCard
                  key={c.id}
                  title={c.title}
                  subtitle={c.subtitle}
                  artwork={c.artwork}
                  seed={`feat-${c.id}`}
                  size={150}
                  onPress={() => nav.navigate('Collection', { collection: c })}
                />
              ))}
            </Shelf>
          ) : null}

          {charts.length > 0 ? (
            <Shelf kicker="THE COUNTING HOUSE" title="Popular Charts">
              {charts.map((c, i) => (
                <ShelfCard
                  key={c.id}
                  title={c.title}
                  subtitle={c.subtitle}
                  artwork={c.artwork}
                  seed={c.id}
                  size={150}
                  index={String(i + 1).padStart(2, '0')}
                  onPress={() => nav.navigate('Collection', { collection: c })}
                />
              ))}
            </Shelf>
          ) : null}
        </>
      )}
    </>
  );
});

function weekNumber(): number {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  return Math.max(1, Math.ceil(((now.getTime() - start.getTime()) / 86400000 + start.getDay() + 1) / 7));
}

// window-reactive two-column width (W2 — tablets re-measure live)
function quickTileWidth(winWidth: number): number {
  return Math.floor((winWidth - 36 - 9) / 2);
}

/** The "create with AI" acid card capping the Made-for-you rail. */
function AICreateCard({ onPress }: { onPress: () => void }) {
  return (
    <Brutal onPress={onPress} haptic shadow={4} style={{ width: 150 }}>
      <View style={styles.aiCard}>
        <Ionicons name="sparkles-outline" size={34} color={colors.ink} />
      </View>
      <Text style={styles.aiCardTitle}>AI Playlist</Text>
      <MonoText size={9.5} style={{ marginTop: 2 }}>
        Type a vibe, get 25
      </MonoText>
    </Brutal>
  );
}

function EmptyHome({ onGoAI }: { onGoAI: () => void }) {
  return (
    <View style={styles.empty}>
      <Ionicons name="albums-outline" size={44} color={colors.ink40} />
      <Text style={styles.emptyTitle}>Your front page, your music</Text>
      <MonoText size={10.5} color={colors.ink60} style={{ textAlign: 'center', lineHeight: 16 }}>
        Search for something you love — TSF learns your taste and builds mixes, radios and recommendations just for you.
      </MonoText>
      <Brutal onPress={onGoAI} haptic shadow={3} style={styles.emptyBtn}>
        <MonoText size={10.5} bold color={colors.ink}>
          FILE A VIBE WITH THE WIRE ▸
        </MonoText>
      </Brutal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  masthead: { paddingHorizontal: 18, paddingTop: 14 },
  mastRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 12 },
  editionRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  edDot: { width: 7, height: 7, backgroundColor: colors.orange },
  huge: {
    fontFamily: fonts.display,
    fontSize: 34,
    lineHeight: 33,
    color: colors.ink,
    textTransform: 'uppercase',
    letterSpacing: -0.2,
  },
  hugeOutline: {
    fontFamily: fonts.display,
    fontSize: 34,
    lineHeight: 36,
    textTransform: 'uppercase',
    letterSpacing: -0.2,
  },
  avatar: {
    width: 40,
    height: 40,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.acid, fontSize: 15, fontFamily: fonts.display },
  offlineChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    marginHorizontal: 18,
    marginTop: 12,
    borderWidth: 1.5,
    borderColor: colors.ink,
    borderStyle: 'dashed',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  chipRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 18,
    paddingTop: 14,
  },
  chip: {
    backgroundColor: colors.paper,
    borderWidth: 1.5,
    borderColor: colors.ink,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  chipActive: { backgroundColor: colors.acid },
  heroShelf: { marginTop: 16 },
  shelfHeadRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    marginHorizontal: 18,
    marginBottom: 10,
    paddingBottom: 8,
    borderBottomWidth: 1.5,
    borderBottomColor: colors.ink,
    gap: 10,
  },
  shelfHeadTitle: {
    fontFamily: fonts.display,
    fontSize: 16.5,
    color: colors.ink,
    textTransform: 'uppercase',
    marginTop: 3,
  },
  heroRun: { paddingHorizontal: 6, paddingVertical: 4 },
  heroCard: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 14,
    marginHorizontal: 18,
    backgroundColor: colors.ink,
    padding: 20,
  },
  heroTitle: {
    fontFamily: fonts.display,
    fontSize: 28,
    lineHeight: 27,
    color: colors.onInk,
    textTransform: 'uppercase',
  },
  heroPlay: {
    width: 52,
    height: 52,
    backgroundColor: colors.acid,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 9,
    paddingHorizontal: 18,
    marginTop: 14,
    marginBottom: 6,
  },
  aiCard: {
    width: 150,
    height: 150,
    backgroundColor: colors.acid,
    borderWidth: 1.5,
    borderColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  aiCardTitle: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 12.5,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    marginTop: 8,
  },
  empty: {
    alignItems: 'center',
    gap: 12,
    padding: 28,
    marginHorizontal: 18,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.ink40,
  },
  emptyTitle: {
    color: colors.ink,
    fontFamily: fonts.display,
    fontSize: 17,
    textTransform: 'uppercase',
    textAlign: 'center',
  },
  emptyBtn: {
    backgroundColor: colors.acid,
    borderWidth: 1.5,
    borderColor: colors.ink,
    paddingHorizontal: 16,
    paddingVertical: 11,
    marginTop: 4,
  },
  footerDivider: { alignItems: 'center', paddingTop: 32, gap: 10 },
  footerRule: { height: 2, backgroundColor: colors.ink, width: '24%' },
  secLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 18,
    paddingTop: 22,
    paddingBottom: 8,
  },
  secLabelText: {
    fontFamily: fonts.monoBold,
    fontSize: 9.5,
    letterSpacing: 2.2,
    color: colors.ink60,
    textTransform: 'uppercase',
  },
  secLabelRule: { flex: 1, height: 2, backgroundColor: colors.ink },
  feedSection: { marginTop: 4 },
  feedSpinner: { marginVertical: 26 },
  feedRetry: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderWidth: 1.5,
    borderColor: colors.ink,
    backgroundColor: colors.paper,
    marginTop: 16,
  },
  feedEndWrap: { alignItems: 'center', paddingVertical: 22 },
});
