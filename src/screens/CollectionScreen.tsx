/**
 * Collection — PULSE collection page (v4.0):
 *   paper header with the artwork's palette wash at low alpha ·
 *   bordered cover with the hard ink shadow · display title + mono ·
 *   brutal action row (shuffle + ink FAB with acid glyph) · index
 *   track rows. Lazy-resolves tracks when the route carries none:
 *   kind 'chart' → JioSaavn playlist, kind 'search' → clean search.
 */

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, ScrollView, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import type { Collection, Track } from '../types';
import { getAlbumTracks, getArtistCatalog, getCollectionTracks, primaryArtistName, searchSaavnClean } from '../api/saavn';
import { lookupArtistPhoto } from '../api/artists';
import { usePlayer } from '../player/PlayerProvider';
import { TrackRow } from '../components/TrackRow';
import { Artwork } from '../components/Artwork';
import { ShelfCard } from '../components/Shelf';
import { Brutal, MonoText } from '../components/Brutal';
import { TrackMenu } from '../components/TrackMenu';
import { useToast } from '../components/Toast';
import { colors, fonts } from '../theme';
import { withAlpha } from '../theme/dynamic';
import { useTrackPalette } from '../theme/DynamicThemeProvider';
import type { RootStackParamList } from './navigation';

export function CollectionScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, 'Collection'>>();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const { playQueue } = usePlayer();
  const { collection, tracks: routeTracks } = route.params;

  // An EMPTY route array (e.g. a crates album row that has no stored
  // tracks) used to be trusted forever — "0 SONGS" with no retry. Only
  // a NON-EMPTY route list counts as truth; anything else lazy-loads.
  const carriedTracks = routeTracks?.length ? routeTracks : null;

  const [tracks, setTracks] = useState<Track[] | null>(carriedTracks);
  const [loading, setLoading] = useState(
    !carriedTracks && !!(collection.kind === 'chart' || collection.kind === 'search' || collection.kind === 'album' || collection.kind === 'artist'),
  );
  const [failed, setFailed] = useState(false);
  const [menuTrack, setMenuTrack] = useState<Track | null>(null);
  // artist pages carry the provider's own top-albums (tappable cards)
  const [artistAlbums, setArtistAlbums] = useState<Collection[]>([]);

  // ── Artist pages carry the artist's PHOTO (v4.0.1 fix) ────────────
  // The route often arrives with artwork: '' (the home rail only resolved
  // a handful of photos), and the old hero fell back to the FIRST SONG's
  // album cover — an unrelated image — or a blank hatch. Artist pages now
  // resolve the real photo by name (seed cache → live id lookup) and wear
  // an initials stamp only when the provider genuinely has none (probe:
  // ~35% of JioSaavn artists are photo-less).
  const isArtist = collection.kind === 'artist' || collection.subtitle?.toLowerCase().startsWith('artist');
  const [artistPhoto, setArtistPhoto] = useState('');
  useEffect(() => {
    if (!isArtist) return;
    if (collection.artwork) {
      setArtistPhoto(collection.artwork);
      return;
    }
    let cancelled = false;
    lookupArtistPhoto(collection.title)
      .then((img) => {
        if (!cancelled && img) setArtistPhoto(img);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isArtist, collection.artwork, collection.title]);

  useEffect(() => {
    if (carriedTracks) return;
    let cancelled = false;
    (async () => {
      try {
        let list: Track[] = [];
        if (collection.kind === 'chart') {
          list = await getCollectionTracks(collection.id);
        } else if (collection.kind === 'album') {
          // title powers the stub-rescue ladder (see getAlbumTracks)
          list = await getAlbumTracks(collection.id, collection.title);
        } else if (collection.kind === 'artist') {
          // the REAL artist page: topSongs + name-matched rows paint
          // first, dedicated playlists deepen the list in the background.
          // Falls back to the v4.0.3 search behavior on any failure.
          const name = collection.title || collection.query || '';
          const catalog = await getArtistCatalog(name).catch(() => null);
          if (catalog && catalog.tracks.length) {
            if (!cancelled) {
              setTracks(catalog.tracks);
              setArtistAlbums(catalog.albums);
              setLoading(false);
              setFailed(false);
            }
            const deep = await catalog.expand().catch(() => [] as Track[]);
            if (!cancelled && deep.length) setTracks(deep);
            return;
          }
          // catalog empty → the old search ladder, with the primary-name
          // retry (joined credit strings search 0 rows on the provider)
          const q = collection.query || name;
          list = await searchSaavnClean(q, 40).catch(() => [] as Track[]);
          if (list.length < 3) {
            const primary = primaryArtistName(name) || q;
            if (primary.toLowerCase() !== q.toLowerCase()) {
              const alt = await searchSaavnClean(primary, 40).catch(() => [] as Track[]);
              if (alt.length > list.length) list = alt;
            }
          }
        } else if (collection.kind === 'search' && collection.query) {
          list = await searchSaavnClean(collection.query, 40).catch(() => [] as Track[]);
          if (list.length < 3) {
            // same joined-credits rescue for search-kind pages
            const primary = primaryArtistName(collection.query);
            if (primary && primary.toLowerCase() !== collection.query.toLowerCase()) {
              const alt = await searchSaavnClean(primary, 40).catch(() => [] as Track[]);
              if (alt.length > list.length) list = alt;
            }
          }
        }
        if (!cancelled) {
          setTracks(list);
          setFailed(list.length === 0);
        }
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [collection.id, collection.kind, collection.query, collection.title, carriedTracks]);

  const play = (index: number) => {
    if (tracks && tracks.length) {
      playQueue(tracks, index);
      nav.navigate('Player');
    }
  };

  const playShuffled = () => {
    if (!tracks?.length) return;
    const shuffled = [...tracks].sort(() => Math.random() - 0.5);
    playQueue(shuffled, 0);
    nav.navigate('Player');
  };

  // Artist pages wear the ARTIST's photo — never the first track's album
  // art (the old `tracks[0].artwork ||` chain put an unrelated cover on
  // artist pages). Loading state falls to the initials stamp via Artwork.
  const heroArt = isArtist
    ? collection.artwork || artistPhoto
    : tracks?.[0]?.artwork || collection.artwork;
  const isLiked = collection.title === 'Liked Songs';
  // every collection wears its own artwork's colors (Spotify-style tint)
  const palette = useTrackPalette(isLiked ? undefined : heroArt, collection.id);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* palette wash — the song's own hue at whisper alpha on paper */}
      <LinearGradient
        colors={[isLiked ? withAlpha(colors.orange, 0.22) : withAlpha(palette.wash, 0.5), colors.paper]}
        locations={[0, 0.8]}
        style={styles.headerWash}
        pointerEvents="none"
      />
      <View style={styles.topBar}>
        <Brutal haptic shadow={0} pressOffset={1} onPress={() => nav.goBack()} style={styles.chevBtn} testID="collection-back">
          <Ionicons name="chevron-back" size={16} color={colors.ink} />
        </Brutal>
        <MonoText size={9.5} bold color={colors.ink60} style={{ letterSpacing: 2, flex: 1, textAlign: 'center' }} numberOfLines={1}>
          {(collection.subtitle ?? 'COLLECTION').toUpperCase()}
        </MonoText>
        <View style={{ width: 38 }} />
      </View>

      <FlatList
        data={tracks ?? []}
        keyExtractor={(t) => t.id}
        contentContainerStyle={{ paddingBottom: 170, flexGrow: 1 }}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <View style={styles.headerCard}>
            <View style={styles.artWrap}>
              {isLiked ? (
                <Artwork seed="liked" size={180} liked style={styles.art} />
              ) : (
                <Artwork
                  uri={heroArt}
                  seed={collection.id}
                  size={180}
                  bordered={false}
                  initials={isArtist ? collection.title : undefined}
                  style={styles.art}
                />
              )}
            </View>
            <Text style={styles.title} allowFontScaling={false}>{collection.title.toUpperCase()}</Text>
            <MonoText size={10} color={colors.ink60} style={{ letterSpacing: 1 }}>
              {tracks ? `${tracks.length} SONGS · 320 KBPS` : 'LOADING…'}
            </MonoText>

            {/* brutal action row */}
            {tracks && tracks.length ? (
              <View style={styles.actions}>
                <View style={styles.actionLeft}>
                  <Brutal haptic shadow={2} onPress={() => toast.show({ message: 'ADDED TO YOUR CRATES', icon: 'heart' })} style={styles.sqBtn}>
                    <Ionicons name="heart-outline" size={18} color={colors.ink} />
                  </Brutal>
                  <Brutal haptic shadow={2} onPress={() => toast.show({ message: 'DOWNLOADING CRATE…', icon: 'arrow-down-circle-outline' })} style={styles.sqBtn}>
                    <Ionicons name="arrow-down-outline" size={18} color={colors.ink} />
                  </Brutal>
                </View>
                <View style={styles.actionRight}>
                  <Brutal haptic shadow={0} pressOffset={1} onPress={playShuffled} style={[styles.sqBtn, { borderWidth: 2, borderColor: colors.ink, backgroundColor: colors.acid, width: 48, height: 48 }]}>
                    <Ionicons name="shuffle" size={20} color={colors.ink} />
                  </Brutal>
                  <Brutal haptic onInk shadow={4} onPress={() => play(0)} style={styles.playFab}>
                    <Ionicons name="play" size={22} color={colors.acid} style={{ marginLeft: 2 }} />
                  </Brutal>
                </View>
              </View>
            ) : null}
            {loading ? (
              <View style={styles.loadingWrap}>
                <ActivityIndicator size="large" color={colors.orange} />
                <MonoText size={9.5} bold color={colors.ink60} style={{ letterSpacing: 2 }}>
                    PULLING THE RECORDS…
                </MonoText>
              </View>
            ) : null}
            {failed && !loading ? (
              <View style={styles.loadingWrap}>
                <Ionicons name="cloud-offline-outline" size={34} color={colors.ink40} />
                <MonoText size={10} color={colors.ink60} style={{ letterSpacing: 1, textAlign: 'center' }}>
                  {'COULDNT LOAD THIS — CHECK YOUR CONNECTION'}
                </MonoText>
              </View>
            ) : null}
            {artistAlbums.length > 0 && !loading ? (
              <View style={styles.artistAlbumsWrap}>
                <View style={styles.artistAlbumsHead}>
                  <MonoText size={9.5} bold color={colors.ink60} style={{ letterSpacing: 2 }}>
                    TOP ALBUMS
                  </MonoText>
                  <View style={styles.artistAlbumsRule} />
                </View>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ paddingHorizontal: 18, gap: 12 }}
                >
                  {artistAlbums.map((c) => (
                    <ShelfCard
                      key={c.id}
                      title={c.title}
                      subtitle={c.subtitle}
                      artwork={c.artwork}
                      seed={`artist-album-${c.id}`}
                      size={140}
                      onPress={() => nav.navigate('Collection', { collection: c })}
                    />
                  ))}
                </ScrollView>
              </View>
            ) : null}
          </View>
        }
        renderItem={({ item, index }) => (
          <TrackRow
            track={item}
            index={index}
            onPress={() => play(index)}
            onLongPress={() => setMenuTrack(item)}
          />
        )}
      />

      <TrackMenu track={menuTrack} visible={!!menuTrack} onClose={() => setMenuTrack(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  headerWash: {
    ...StyleSheet.absoluteFillObject,
    bottom: '55%',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 12,
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
  headerCard: {
    alignItems: 'center',
    paddingTop: 8,
    paddingBottom: 8,
    paddingHorizontal: 18,
    gap: 12,
  },
  artWrap: {
    ...({ shadowColor: colors.ink, shadowOpacity: 1, shadowRadius: 0, shadowOffset: { width: 6, height: 6 }, elevation: 6 } as object),
  },
  art: {
    borderWidth: 2,
    borderColor: colors.ink,
  },
  title: {
    color: colors.ink,
    fontFamily: fonts.display,
    fontSize: 26,
    textAlign: 'center',
    textTransform: 'uppercase',
    letterSpacing: -0.2,
    lineHeight: 27,
    marginTop: 4,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    alignSelf: 'stretch',
    paddingTop: 8,
  },
  actionLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  actionRight: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  sqBtn: {
    width: 42,
    height: 42,
    borderWidth: 1.5,
    borderColor: colors.ink,
    backgroundColor: colors.paper,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playFab: {
    width: 56,
    height: 56,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingWrap: { alignItems: 'center', gap: 12, paddingVertical: 32 },
  artistAlbumsWrap: { alignSelf: 'stretch', marginTop: 10, gap: 8 },
  artistAlbumsHead: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18 },
  artistAlbumsRule: { flex: 1, height: 1.5, backgroundColor: colors.ink16 },
});
