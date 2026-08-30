/**
 * Home — authentic Spotify Android home architecture, v3.2 DEEP feed:
 *
 *   profile avatar + filter chips (All / Music / AI) → 8-tile shortcut
 *   grid → Made for {name} (Daily Mixes + AI card) → Now Sound (daylist)
 *   → Jump back in → Popular artists (REAL artist photos, circular rail)
 *   → Trending now → On the Rise → Because you listened → New releases
 *   (JioSaavn editorial albums) → Featured playlists (editorial) →
 *   Popular charts → footer.
 *
 * The editorial feed (content.getHomepageData) + artist rail make the
 * screen scroll as deep as Spotify from the very first session, with or
 * without a listening profile. Everything algorithmic stays safety-
 * filtered; every editorial shelf renders through collectionIsClean.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  NativeScrollEvent,
  NativeSyntheticEvent,
  RefreshControl,
  ScrollView,
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
import type { Collection, DailyMix, Track } from '../types';
import {
  collectionIsClean,
  getCharts,
  getCollectionTracks,
  getHomepageFeed,
  getTrending,
  searchAlbumCollections,
  searchSaavn,
} from '../api/saavn';
import { EndlessFeedPager, type FeedBatch } from '../api/feed';
import { ARTIST_SEEDS, lookupArtistPhoto, type ArtistInfo } from '../api/artists';
import { getBecauseYouListened, getDailyMixes } from '../ai/engine';
import { mindbeat } from '../ai/mindbeat';
import type { NowSoundCard } from '../ai/surfaces/daylist';
import type { OnTheRiseCard } from '../ai/surfaces/ontherise';
import {
  getChartsCache,
  getFavorites,
  getHomeFeedCache,
  getRecents,
  setChartsCache,
  setHomeFeedCache,
} from '../storage/store';
import { usePlayer } from '../player/PlayerProvider';
import { QuickTile, Shelf, ShelfCard } from '../components/Shelf';
import { TrackRow } from '../components/TrackRow';
import { Artwork } from '../components/Artwork';
import { ShelfSkeleton } from '../components/ShelfSkeleton';
import { PressableScale } from '../components/PressableScale';
import { colors, fonts, radius, spacing } from '../theme';
import type { RootStackParamList } from './navigation';

type Chip = 'all' | 'music' | 'ai';

const POPULAR_ARTIST_COUNT = 10;

export function HomeScreen() {
  const insets = useSafeAreaInsets();
  // window-reactive grid math (W2): tablets / split-screen / pop-up windows
  // re-measure instead of freezing the boot-time module constant
  const { width: winWidth } = useWindowDimensions();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { playQueue } = usePlayer();
  const [chip, setChip] = useState<Chip>('all');

  const [mixes, setMixes] = useState<DailyMix[] | null>(null);
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
   *  curated A-listers filling the rail to a full row. Photos resolve from
   *  the instant seed map; unknown names get at most 6 live lookups and an
   *  honest initials circle otherwise. */
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
    // Live photos only for the first few unknowns (network budget).
    rail
      .filter((a) => !a.image)
      .slice(0, 6)
      .forEach((a, i) => {
        lookupArtistPhoto(a.name)
          .then((img) => {
            if (!img) return;
            setPopularArtists((prev) => prev.map((x) => (x.name === a.name ? { ...x, image: img } : x)));
          })
          .catch(() => undefined);
        void i;
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

      // AI surfaces first — they personalize the whole screen. MINDBEAT
      // surfaces (Mixes v2 / Now Sound / On the Rise) with the v2.1 engine
      // as the graceful fallback (ladder §10.4).
      mindbeat
        .dailyMixes()
        .then((v2) => (v2.length ? setMixes(v2) : getDailyMixes().then(setMixes)))
        .catch(() => getDailyMixes().then(setMixes).catch(() => setMixes([])));
      getBecauseYouListened(2)
        .then(setBecause)
        .catch(() => setBecause([]));
      mindbeat.nowSound().then(setNowSound).catch(() => undefined);
      mindbeat.onTheRise().then(setOnTheRise).catch(() => undefined);
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
        // F2/P2-4: shelves settled (success OR failure) — the endless feed
        // may now start, primed against whatever the shelves actually show.
        feedPrimedRef.current = true;
      }
    },
    [loadFeed, loadPopularArtists],
  );

  useEffect(() => {
    load();
  }, [load]);

  // ── Endless feed (F2) — Spotify's scroll-forever tail ───────────────
  /** Distance from the bottom (px) that triggers prefetching the next batch. */
  const FEED_TRIGGER_PX = 600;

  const resetFeed = useCallback(() => {
    feedEpochRef.current += 1; // in-flight old-pager batches are void now
    pagerRef.current = null;
    feedSongsRef.current = [];
    feedBusyRef.current = false;
    feedPrimedRef.current = false; // load() re-primes after trending settles
    setFeedBatches([]);
    setFeedState('idle');
  }, []);

  const ensurePager = useCallback((): EndlessFeedPager => {
    if (!pagerRef.current) {
      pagerRef.current = new EndlessFeedPager({
        searchSongs: (q, page, signal) => searchSaavn(q, 30, signal, page),
        searchAlbums: (q, page, signal) => searchAlbumCollections(q, page, 20, signal),
      });
      // never repeat rows the fixed shelves above already show
      pagerRef.current.prime({
        songs: trending ?? undefined,
        albums: [...newAlbums, ...featured, ...charts],
      });
    }
    return pagerRef.current;
  }, [trending, newAlbums, featured, charts]);

  const loadFeedMore = useCallback(async () => {
    // CRITIC P2-2 fix: after a failure round, only the explicit retry row
    // resumes the feed — auto-scroll must not churn the ladder while the
    // network is down.
    if (feedBusyRef.current || feedState === 'retry' || feedState === 'exhausted') return;
    // CRITIC P2-4 fix: wait for the fixed shelves to settle first
    if (!feedPrimedRef.current) return;
    const pager = ensurePager();
    if (pager.isExhausted) return;
    const epoch = feedEpochRef.current;
    feedBusyRef.current = true;
    setFeedState('loading');
    try {
      const batch = await pager.next();
      if (epoch !== feedEpochRef.current) return; // refresh reset the feed
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

  // First name → "Made for {name}". AsyncStorage read first (instant — the
  // kv copy can lag behind the ledger opening on cold start), then kv, then
  // the profile subscription for the exact onboarding-complete moment.
  // Subsequent reads never CLEAR a known-good name (kv may briefly be empty
  // on cold web/crash-recovery boots).
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
  const showAI = chip !== 'music'; // AI surfaces under All + AI chips

  // ── Endless feed scroll trigger (F2) ─────────────────────────────
  const onFeedScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      // never prefetch while the skeleton is up (content height is a lie)
      if (loading) return;
      const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
      if (contentSize.height === 0) return;
      const distanceFromBottom =
        contentSize.height - (layoutMeasurement.height + contentOffset.y);
      if (distanceFromBottom < FEED_TRIGGER_PX) void loadFeedMore();
    },
    [loading, loadFeedMore],
  );

  /* Spotify's 8-tile shortcut grid: pinned first (Liked Songs), then
   * mixes, trending, recents, and the AI tile filling slot 8. */
  const quickTiles: Array<{
    title: string;
    subtitle?: string;
    artwork?: string;
    seed: string;
    icon?: keyof typeof Ionicons.glyphMap;
    liked?: boolean;
    onPress: () => void;
  }> = [];
  if (favorites.length > 0)
    quickTiles.push({
      title: 'Liked Songs',
      seed: 'liked-songs',
      liked: true,
      onPress: () => openTrackCollection('Liked Songs', favorites),
    });
  if (hasMixes)
    mixes!.slice(0, 2).forEach((m) =>
      quickTiles.push({
        title: m.title,
        artwork: m.artwork,
        seed: m.id,
        onPress: () => openTrackCollection(m.title, m.tracks),
      }),
    );
  if (trending && trending.length > 0)
    quickTiles.push({
      title: 'Trending now',
      subtitle: 'Hot hits',
      artwork: trending[0].artwork,
      seed: 'trending',
      onPress: () => openTrackCollection('Trending now', trending),
    });
  recents.slice(0, 3).forEach((t) =>
    quickTiles.push({
      title: t.title,
      artwork: t.artwork,
      seed: `recent-${t.id}`,
      onPress: () => play(recents, Math.max(0, recents.findIndex((r) => r.id === t.id))),
    }),
  );
  if (newAlbums.length > 0)
    quickTiles.push({
      title: 'New releases',
      subtitle: 'Fresh albums',
      artwork: newAlbums[0].artwork,
      seed: 'new-releases',
      onPress: () => nav.navigate('Collection', { collection: newAlbums[0] }),
    });
  if (quickTiles.length > 0)
    quickTiles.push({
      title: 'Create with AI',
      seed: 'ai-tile',
      icon: 'sparkles',
      onPress: () => nav.navigate('AI'),
    });
  const quickTileList = quickTiles.slice(0, 8);

  const openArtist = (artist: string) =>
    nav.navigate('Collection', {
      collection: {
        id: `artist-${artist}`,
        title: artist,
        subtitle: 'Artist',
        artwork: popularArtists.find((a) => a.name === artist)?.image ?? '',
        kind: 'search',
        query: artist,
      },
    });

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 190 }}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={64}
        onScroll={onFeedScroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              resetFeed();
              load(true).finally(() => setRefreshing(false));
            }}
            tintColor={colors.accentBright}
            colors={[colors.accentBright]}
          />
        }
      >
        {/* ── Header: avatar far-left + chips (genuine Spotify order) ── */}
        <View style={styles.header}>
          <PressableScale
            scaleTo={0.92}
            haptic
            onPress={() => nav.navigate('Stats')}
            style={styles.avatar}
          >
            <Text style={styles.avatarText}>{(userName || 'T').slice(0, 1).toUpperCase()}</Text>
          </PressableScale>
          <View style={styles.chipRow}>
            {(['all', 'music', 'ai'] as Chip[]).map((c) => (
              <PressableScale
                key={c}
                scaleTo={0.94}
                haptic
                onPress={() => setChip(c)}
                style={[styles.chip, chip === c && styles.chipActive]}
              >
                <Text style={[styles.chipText, chip === c && styles.chipTextActive]}>
                  {c === 'all' ? 'All' : c === 'music' ? 'Music' : 'AI'}
                </Text>
              </PressableScale>
            ))}
          </View>
        </View>

        {offline ? (
          <View style={styles.offlineChip}>
            <Ionicons name="cloud-offline-outline" size={13} color={colors.textDim} />
            <Text style={styles.offlineText}>Offline — pull to retry</Text>
          </View>
        ) : null}

        {/* ── Quick shortcuts — Spotify 8-tile grid, #2A2A2A ──────────── */}
        {quickTileList.length > 0 && (
          <View style={styles.quickGrid}>
            {quickTileList.map((t) => (
              <QuickTile
                key={t.seed}
                title={t.title}
                subtitle={t.subtitle}
                artwork={t.artwork}
                seed={t.seed}
                icon={t.icon}
                liked={t.liked}
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
            {/* ── Made for you / Made for {name} (AI Daily Mixes) ────── */}
            {hasMixes && showAI ? (
              <Shelf title={userName ? `Made for ${userName}` : 'Made for you'}>
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

            {/* ── Now Sound (daylist §9.4) — the time-aware shelf ─────── */}
            {nowSound && nowSound.tracks.length > 0 && showAI ? (
              <Shelf title="Now Sound">
                <ShelfCard
                  title={nowSound.title}
                  subtitle={nowSound.subtitle}
                  artwork={nowSound.tracks[0]?.artwork ?? ''}
                  seed={nowSound.id}
                  size={150}
                  onPress={() =>
                    openTrackCollection(nowSound.title, nowSound.tracks as unknown as Track[])
                  }
                />
                <AICreateCard onPress={() => nav.navigate('AI')} />
              </Shelf>
            ) : null}

            {/* ── Jump back in ───────────────────────────────────────── */}
            {recents.length > 0 ? (
              <Shelf title="Jump back in">
                {recents.slice(0, 10).map((t) => (
                  <ShelfCard
                    key={t.id}
                    title={t.title}
                    subtitle={t.album ? `Album · ${t.artist}` : t.artist}
                    artwork={t.artwork}
                    seed={t.id}
                    size={150}
                    onPress={() => play(recents, Math.max(0, recents.findIndex((r) => r.id === t.id)))}
                  />
                ))}
              </Shelf>
            ) : null}

            {/* ── Popular artists — REAL photos, circular rail ─────────── */}
            {popularArtists.length > 0 ? (
              <Shelf title="Popular artists">
                {popularArtists.map((a) => (
                  <PressableScale
                    key={a.name}
                    haptic
                    testID="home-artist"
                    onPress={() => openArtist(a.name)}
                    style={styles.artistCell}
                  >
                    <Artwork
                      uri={a.image}
                      seed={a.name}
                      initials={a.name}
                      size={124}
                      variant="circle"
                    />
                    <View style={{ gap: 2 }}>
                      <Text style={styles.artistName} numberOfLines={1}>
                        {a.name}
                      </Text>
                      <Text style={styles.artistSub}>Artist</Text>
                    </View>
                  </PressableScale>
                ))}
              </Shelf>
            ) : null}

            {/* ── Trending now ───────────────────────────────────────── */}
            {trending && trending.length > 0 ? (
              <Shelf
                title="Trending now"
                actionLabel="Show all"
                onAction={() => openTrackCollection('Trending now', trending)}
              >
                {trending.slice(0, 10).map((t) => (
                  <ShelfCard
                    key={t.id}
                    title={t.title}
                    subtitle={t.album ? `Album · ${t.artist}` : t.artist}
                    artwork={t.artwork}
                    seed={t.id}
                    size={150}
                    onPress={() => play(trending, Math.max(0, trending.findIndex((x) => x.id === t.id)))}
                  />
                ))}
              </Shelf>
            ) : null}

            {/* ── On the Rise (§9.6) — the weekly discovery flagship ──── */}
            {onTheRise && onTheRise.tracks.length > 2 && showAI ? (
              <Shelf title="On the Rise">
                {onTheRise.tracks.slice(0, 10).map((t) => (
                  <ShelfCard
                    key={t.id}
                    title={t.title}
                    subtitle={`via ${t.viaArtist}`}
                    artwork={t.artwork}
                    seed={`rise-${t.id}`}
                    size={150}
                    onPress={() =>
                      openTrackCollection('On the Rise', onTheRise.tracks as unknown as Track[])
                    }
                  />
                ))}
              </Shelf>
            ) : null}

            {/* ── Because you listened ───────────────────────────────── */}
            {because.map(({ artist, seedTrack }) => (
              <Shelf key={artist} title={`Because you listened to ${artist}`}>
                <ArtistRadioCard
                  artist={artist}
                  image={popularArtists.find((a) => a.name === artist)?.image}
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
                          artwork: seedTrack.artwork,
                          kind: 'search',
                          query: artist,
                        },
                      })
                    }
                  />
                ) : null}
              </Shelf>
            ))}

            {/* ── New releases (JioSaavn editorial albums) ─────────────── */}
            {newAlbums.length > 0 ? (
              <Shelf title="New releases">
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

            {/* ── Featured playlists (editorial) ───────────────────────── */}
            {featured.length > 0 ? (
              <Shelf title="Featured playlists">
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

            {/* ── Popular charts ─────────────────────────────────────── */}
            {charts.length > 0 ? (
              <Shelf title="Popular charts">
                {charts.map((c) => (
                  <ShelfCard
                    key={c.id}
                    title={c.title}
                    subtitle={c.subtitle}
                    artwork={c.artwork}
                    seed={c.id}
                    size={150}
                    onPress={() => nav.navigate('Collection', { collection: c })}
                  />
                ))}
              </Shelf>
            ) : null}

            {/* ── Endless feed (F2) — keep scrolling, keep finding music ── */}
            {feedBatches.map((batch, bi) =>
              batch.kind === 'songs' ? (
                <View
                  key={`feed-songs-${bi}`}
                  style={styles.feedSection}
                  testID="endless-feed-songs"
                >
                  <Text style={styles.feedHeader}>{batch.title}</Text>
                  {batch.songs.map((t) => (
                    <TrackRow
                      key={t.id}
                      track={t}
                      onPress={() => playFeedSong(t)}
                    />
                  ))}
                </View>
              ) : batch.kind === 'albums' ? (
                <Shelf key={`feed-albums-${bi}`} title={batch.title}>
                  {batch.albums.map((c) => (
                    <ShelfCard
                      key={c.id}
                      title={c.title}
                      subtitle={c.subtitle}
                      artwork={c.artwork}
                      seed={`feed-album-${c.id}`}
                      size={150}
                      onPress={() => nav.navigate('Collection', { collection: c })}
                    />
                  ))}
                </Shelf>
              ) : null,
            )}
            {feedState === 'loading' ? (
              <ActivityIndicator color={colors.accentBright} style={styles.feedSpinner} />
            ) : null}
            {feedState === 'retry' ? (
              <PressableScale haptic style={styles.feedRetry} onPress={retryFeed}>
                <Ionicons name="refresh" size={15} color={colors.textDim} />
                <Text style={styles.feedRetryText}>Couldn't load more — tap to retry</Text>
              </PressableScale>
            ) : null}
            {feedState === 'exhausted' ? (
              <Text style={styles.feedEnd} testID="endless-feed-end">
                You've reached the end
              </Text>
            ) : null}

            {!hasMixes && recents.length === 0 && (!trending || trending.length === 0) ? (
              <EmptyHome onGoAI={() => nav.navigate('AI')} />
            ) : null}

            {/* ── Footer — Spotify's quiet end-of-feed divider ─────────── */}
            <View style={styles.footerDivider}>
              <View style={styles.footerRule} />
              <Text style={styles.footerText}>TSF Music · Music for everyone</Text>
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

// Quick-tile grid math is window-reactive: the two-column width is computed
// per render from the CURRENT window width (W2 — tablets, split-screen,
// pop-up and foldable posture changes all re-measure live).
function quickTileWidth(winWidth: number): number {
  // two columns with 8px gutters inside 16px screen padding
  return Math.floor((winWidth - 32 - 8) / 2);
}

/** Artist radio card — circular photo + name (Spotify artist-card style). */
function ArtistRadioCard({ artist, image, onPress }: { artist: string; image?: string; onPress: () => void }) {
  return (
    <PressableScale onPress={onPress} haptic style={{ width: 124, gap: 8 }}>
      <Artwork uri={image} seed={artist} initials={artist} size={124} variant="circle" />
      <View style={{ gap: 2 }}>
        <Text style={styles.artistName} numberOfLines={2}>
          {artist}
        </Text>
        <Text style={styles.artistSub}>Artist radio</Text>
      </View>
    </PressableScale>
  );
}

/** The "create with AI" card capping the Made-for-you rail. */
function AICreateCard({ onPress }: { onPress: () => void }) {
  return (
    <PressableScale onPress={onPress} haptic style={{ width: 150, gap: 8 }}>
      <View style={styles.aiCard}>
        <Ionicons name="sparkles" size={30} color="#fff" />
      </View>
      <View style={{ gap: 2 }}>
        <Text style={styles.aiCardTitle}>Create with AI</Text>
        <Text style={styles.aiCardSub}>Describe your vibe</Text>
      </View>
    </PressableScale>
  );
}

function EmptyHome({ onGoAI }: { onGoAI: () => void }) {
  return (
    <View style={styles.empty}>
      <Ionicons name="musical-notes-outline" size={52} color={colors.textFaint} />
      <Text style={styles.emptyTitle}>Your home, your music</Text>
      <Text style={styles.emptySub}>
        Search for something you love — TSF learns your taste and builds mixes, radios and
        recommendations just for you.
      </Text>
      <PressableScale onPress={onGoAI} haptic style={styles.emptyBtn}>
        <Ionicons name="sparkles" size={17} color="#fff" />
        <Text style={styles.emptyBtnText}>Generate a playlist with AI</Text>
      </PressableScale>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
  },
  chipRow: { flexDirection: 'row', gap: 8 },
  chip: {
    backgroundColor: colors.chipInactiveBg, // current Spotify inactive chip
    borderRadius: radius.full,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  chipActive: { backgroundColor: colors.chipActiveBg }, // green pill (pixel-verified on real Spotify)
  chipText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
    fontFamily: fonts.bold,
  },
  chipTextActive: { color: colors.chipActiveText }, // black on green (genuine)
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#535353',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.text, fontSize: 15, fontWeight: '700', fontFamily: fonts.bold },
  offlineChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    backgroundColor: colors.card,
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  offlineText: { color: colors.textDim, fontSize: 11, fontWeight: '600', fontFamily: fonts.semibold },
  quickGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.lg,
  },
  artistCell: { width: 124, alignItems: 'center' },
  artistName: {
    color: colors.text,
    fontSize: 13.5,
    fontWeight: '700',
    fontFamily: fonts.bold,
    lineHeight: 17,
    marginTop: 8,
    maxWidth: 124,
  },
  artistSub: { color: colors.textDim, fontSize: 13, fontFamily: fonts.regular },
  aiCard: {
    width: 150,
    height: 150,
    borderRadius: radius.lg,
    backgroundColor: colors.aiStart,
    alignItems: 'center',
    justifyContent: 'center',
  },
  aiCardTitle: {
    color: colors.text,
    fontSize: 13.5,
    fontWeight: '700',
    fontFamily: fonts.bold,
  },
  aiCardSub: { color: colors.textDim, fontSize: 13, fontFamily: fonts.regular },
  empty: {
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.xxl,
    paddingTop: spacing.xxl + 12,
  },
  emptyTitle: { color: colors.text, fontSize: 19, fontWeight: '800', fontFamily: fonts.extrabold },
  emptySub: {
    color: colors.textDim,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    fontFamily: fonts.regular,
  },
  emptyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.accent,
    borderRadius: radius.full,
    paddingHorizontal: spacing.xl,
    paddingVertical: 13,
    marginTop: spacing.sm,
  },
  emptyBtnText: { color: colors.accentDeep, fontSize: 14, fontWeight: '800', fontFamily: fonts.bold },
  footerDivider: { alignItems: 'center', paddingTop: spacing.xl + 8, gap: 12 },
  footerRule: { height: StyleSheet.hairlineWidth, backgroundColor: '#3d3d3d', width: '72%' },
  footerText: { color: colors.textFaint, fontSize: 12, fontFamily: fonts.medium, paddingBottom: 4 },
  // ── endless feed (F2) ────────────────────────────────────────────────
  feedSection: { paddingHorizontal: spacing.lg, marginTop: 6 },
  feedHeader: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '700',
    fontFamily: fonts.bold,
    letterSpacing: -0.3,
    marginBottom: 10,
  },
  feedSpinner: { marginVertical: 26 },
  feedRetry: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingVertical: 18,
  },
  feedRetryText: { color: colors.textDim, fontSize: 13, fontFamily: fonts.medium },
  feedEnd: {
    color: colors.textFaint,
    fontSize: 13,
    fontFamily: fonts.medium,
    textAlign: 'center',
    paddingVertical: 22,
  },
});
