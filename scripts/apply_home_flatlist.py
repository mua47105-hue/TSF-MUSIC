#!/usr/bin/env python3
"""R8-P1 HomeScreen lag fix: ScrollView → windowed FlatList.

Replaces (1) the onFeedScroll manual trigger block, (2) the openArtist
inline closure, (3) the whole return JSX (lines 386..802 region), with:
  - feedItems  — flattened, memoized feed rows (FlatList data)
  - HomeHeader — memo'd fixed-shelf header (never re-renders on feed appends)
  - FeedFooter — spinner / retry / end / empty / footer divider
  - FeedSongRow / FeedAlbumShelf — memo'd row wrappers (stable props)
"""
import io, re

PATH = '/home/z/my-project/src/screens/HomeScreen.tsx'
src = io.open(PATH, encoding='utf-8').read()

# ── 1. imports: drop ScrollView/scroll-event types, add FlatList ──
src = src.replace(
    """import {
  ActivityIndicator,
  NativeScrollEvent,
  NativeSyntheticEvent,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';""",
    """import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';""",
)

# ── 2. drop the manual onScroll prefetch (FlatList onEndReached replaces it) ──
src = re.sub(
    r"  // ── Endless feed scroll trigger \(F2\) ──.*?\n  /\* Spotify's 8-tile shortcut grid",
    "  /* Spotify's 8-tile shortcut grid",
    src,
    flags=re.S,
)
src = src.replace("""  // ── Endless feed (F2) — Spotify's scroll-forever tail ───────────────
  /** Distance from the bottom (px) that triggers prefetching the next batch. */
  const FEED_TRIGGER_PX = 600;

""", "")

# ── 3. openArtist → stable useCallback (memo-friendly prop) ──
src = src.replace(
    """  const openArtist = (artist: string) =>
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

  return (""",
    """  const openArtist = useCallback(
    (artist: string) =>
      nav.navigate('Collection', {
        collection: {
          id: `artist-${artist}`,
          title: artist,
          subtitle: 'Artist',
          artwork: popularArtists.find((a) => a.name === artist)?.image ?? '',
          kind: 'search',
          query: artist,
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
  // The old ScrollView mounted EVERY feed row forever — scrolling deep
  // left hundreds of image rows in the tree and every feed-state flip
  // re-rendered them all (the "scrolls fine, then lags" report). The
  // FlatList unmounts far rows (windowing) and the memo'd row wrappers
  // keep feed appends from re-rendering the rows above.
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

  return (""",
)

# ── 4. the JSX: ScrollView → FlatList, fixed shelves → HomeHeader ──
OLD_START = src.index("  return (\n    <View style={[styles.root, { paddingTop: insets.top }]}>")
OLD_END = src.index("\n}\n\n// Quick-tile grid math")
NEW_JSX = '''  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <FlatList
        data={feedItems}
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
          // never prefetch while the skeleton is up (content height is a lie)
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
            tintColor={colors.accentBright}
            colors={[colors.accentBright]}
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
  );'''

src = src[:OLD_START] + NEW_JSX + src[OLD_END:]

# ── 5. add useMemo import ──
src = src.replace(
    "import React, { useCallback, useEffect, useRef, useState } from 'react';",
    "import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';",
)

io.open(PATH, 'w', encoding='utf-8').write(src)
print('JSX replaced OK')
