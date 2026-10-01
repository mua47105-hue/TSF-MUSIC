/**
 * PlaylistScreen — PULSE crate detail: bordered cover (or the acid AI
 * block), display name, mono meta, brutal action row (shuffle + ink
 * FAB), track list with per-track remove and the long-press TrackMenu.
 */

import React, { useCallback, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import type { Track } from '../types';
import { getPlaylists, removeTrackFromPlaylist } from '../storage/store';
import { usePlayer } from '../player/PlayerProvider';
import { TrackRow } from '../components/TrackRow';
import { Artwork } from '../components/Artwork';
import { Brutal, MonoText } from '../components/Brutal';
import { TrackMenu } from '../components/TrackMenu';
import { useToast } from '../components/Toast';
import { colors, fonts } from '../theme';
import { withAlpha } from '../theme/dynamic';
import { useTrackPalette } from '../theme/DynamicThemeProvider';
import type { RootStackParamList } from './navigation';

export function PlaylistScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, 'Playlist'>>();
  const { playlistId } = route.params;
  const { playQueue } = usePlayer();
  const toast = useToast();

  const [menuTrack, setMenuTrack] = useState<Track | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [playlist, setPlaylist] = React.useState<{
    id: string;
    name: string;
    tracks: Track[];
    aiGenerated?: boolean;
    prompt?: string;
  } | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    getPlaylists().then((list) => {
      if (cancelled) return;
      const pl = list.find((p) => p.id === playlistId) ?? null;
      setPlaylist(pl);
    });
    return () => {
      cancelled = true;
    };
  }, [playlistId, dataVersion]);

  const removeTrack = useCallback(
    async (trackId: string) => {
      await removeTrackFromPlaylist(playlistId, trackId);
      toast.show({ message: 'STRUCK FROM THE CRATE', icon: 'remove-circle-outline' });
      setDataVersion((v) => v + 1);
    },
    [playlistId, toast],
  );

  if (!playlist) {
    return (
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <View style={styles.topBar}>
          <Brutal haptic shadow={0} pressOffset={1} onPress={() => nav.goBack()} style={styles.chevBtn}>
            <Ionicons name="chevron-back" size={16} color={colors.ink} />
          </Brutal>
          <View style={{ width: 38 }} />
        </View>
      </View>
    );
  }

  const play = (index: number) => {
    if (playlist.tracks.length) {
      playQueue(playlist.tracks, index);
      nav.navigate('Player');
    }
  };

  const playShuffled = () => {
    if (!playlist.tracks.length) return;
    const shuffled = [...playlist.tracks].sort(() => Math.random() - 0.5);
    playQueue(shuffled, 0);
    nav.navigate('Player');
  };

  // crates wear their own cover's colors at whisper alpha
  const palette = useTrackPalette(
    playlist.aiGenerated ? undefined : playlist.tracks[0]?.artwork,
    playlist.id,
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <LinearGradient
        colors={[
          playlist.aiGenerated ? withAlpha(colors.acid, 0.35) : withAlpha(palette.wash, 0.5),
          colors.paper,
        ]}
        locations={[0, 0.8]}
        style={styles.headerWash}
        pointerEvents="none"
      />
      <View style={styles.topBar}>
        <Brutal haptic shadow={0} pressOffset={1} onPress={() => nav.goBack()} style={styles.chevBtn}>
          <Ionicons name="chevron-back" size={16} color={colors.ink} />
        </Brutal>
        <MonoText size={9.5} bold color={colors.ink60} style={{ letterSpacing: 2, flex: 1, textAlign: 'center' }}>
          {playlist.aiGenerated ? 'MINDBEAT DISPATCH' : 'YOUR CRATE'}
        </MonoText>
        <View style={{ width: 38 }} />
      </View>

      <FlatList
        data={playlist.tracks}
        keyExtractor={(t) => t.id}
        contentContainerStyle={{ paddingBottom: 160 }}
        ListHeaderComponent={
          <View style={styles.headerCard}>
            {playlist.aiGenerated ? (
              <View style={styles.aiArt}>
                <Ionicons name="sparkles" size={40} color={colors.ink} />
              </View>
            ) : (
              <View style={styles.artWrap}>
                <Artwork
                  uri={playlist.tracks[0]?.artwork}
                  seed={playlist.id}
                  size={180}
                  bordered={false}
                  style={styles.art}
                />
              </View>
            )}
            <Text style={styles.name} allowFontScaling={false}>{playlist.name.toUpperCase()}</Text>
            <MonoText size={10} color={colors.ink60} style={{ letterSpacing: 1, textAlign: 'center' }} numberOfLines={2}>
              {`CRATE · ${playlist.tracks.length} SONGS${playlist.prompt ? ` · FROM "${playlist.prompt.toUpperCase()}"` : ''}`}
            </MonoText>
            {/* brutal action row */}
            <View style={styles.actions}>
              <View style={styles.actionLeft}>
                <Brutal haptic shadow={2} onPress={() => toast.show({ message: 'PINNED TO YOUR CRATES', icon: 'heart' })} style={styles.sqBtn}>
                  <Ionicons name="heart-outline" size={18} color={colors.ink} />
                </Brutal>
              </View>
              <View style={styles.actionRight}>
                <Brutal haptic shadow={0} pressOffset={1} onPress={playShuffled} disabled={!playlist.tracks.length} style={[styles.sqBtn, { borderWidth: 2, borderColor: colors.ink, backgroundColor: colors.acid, width: 48, height: 48 }]}>
                  <Ionicons name="shuffle" size={20} color={colors.ink} />
                </Brutal>
                <Brutal
                  haptic
                  onInk
                  shadow={4}
                  onPress={() => play(0)}
                  disabled={!playlist.tracks.length}
                  style={styles.playFab}
                >
                  <Ionicons name="play" size={22} color={colors.acid} style={{ marginLeft: 2 }} />
                </Brutal>
              </View>
            </View>
          </View>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="albums-outline" size={38} color={colors.ink40} />
            <Text style={styles.emptyTitle}>THIS CRATE IS EMPTY</Text>
            <MonoText size={10} color={colors.ink60} style={{ textAlign: 'center', lineHeight: 16 }}>
              SEARCH FOR SONGS AND USE "ADD TO PLAYLIST" FROM A LONG-PRESS
            </MonoText>
          </View>
        }
        renderItem={({ item, index }) => (
          <TrackRow
            track={item}
            index={index}
            onLongPress={() => setMenuTrack(item)}
            right={
              <Brutal haptic shadow={0} pressOffset={1} onPress={() => void removeTrack(item.id)} style={styles.removeBtn}>
                <Ionicons name="remove-circle-outline" size={20} color={colors.ink40} />
              </Brutal>
            }
            onPress={() => play(index)}
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
  aiArt: {
    width: 180,
    height: 180,
    backgroundColor: colors.acid,
    borderWidth: 2,
    borderColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
    ...({ shadowColor: colors.ink, shadowOpacity: 1, shadowRadius: 0, shadowOffset: { width: 6, height: 6 }, elevation: 6 } as object),
  },
  artWrap: {
    ...({ shadowColor: colors.ink, shadowOpacity: 1, shadowRadius: 0, shadowOffset: { width: 6, height: 6 }, elevation: 6 } as object),
  },
  art: {
    borderWidth: 2,
    borderColor: colors.ink,
  },
  name: {
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
  removeBtn: { padding: 6 },
  empty: { alignItems: 'center', gap: 10, padding: 32 },
  emptyTitle: {
    color: colors.ink,
    fontFamily: fonts.display,
    fontSize: 16,
    textTransform: 'uppercase',
  },
});
