/**
 * Your Library — PULSE "The Crates" (v4.0 editorial brutalism):
 *   masthead (display title + avatar) → bordered chips → Liked Songs
 *   orange hero with the ink play block → index list rows (48px
 *   bordered art, uppercase titles, mono meta) → Premium banner →
 *   create/rename dialogs + long-press sheet in ink-on-paper.
 *
 * Data logic unchanged from v3.4: chips (Playlists/Artists/Albums/
 * Downloaded), sort + grid toggle, playlist CRUD, download verification.
 */

import React, { useCallback, useEffect, useState } from 'react';
import Constants from 'expo-constants';
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets, useSafeAreaFrame } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import type { Playlist, Track } from '../types';
import { usePlayer } from '../player/PlayerProvider';
import {
  createPlaylist,
  deletePlaylist,
  getFavorites,
  getPlaylists,
  getRecents,
  renamePlaylist,
} from '../storage/store';
import { verifyDownloads } from '../storage/downloads';
import { Artwork } from '../components/Artwork';
import { Brutal, MonoText, OutlineText } from '../components/Brutal';
import { useToast } from '../components/Toast';
import { colors, fonts } from '../theme';
import type { RootStackParamList } from './navigation';

type Chip = 'playlists' | 'artists' | 'albums' | 'downloaded';

interface LibItem {
  key: string;
  title: string;
  subtitle: string;
  artwork?: string;
  seed: string;
  kind: 'liked' | 'stats' | 'playlist' | 'ai' | 'artist' | 'album' | 'track';
  playlistId?: string;
  tracks?: Track[];
  /** provider album id (from any track of this album) — powers the
   *  REAL album page lazy-load instead of an empty local list */
  albumId?: string;
  circle?: boolean;
}

export function LibraryScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { playQueue } = usePlayer();
  const toast = useToast();

  const [chip, setChip] = useState<Chip>('playlists');
  const [sortRecent, setSortRecent] = useState(true);
  const [grid, setGrid] = useState(false);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [favorites, setFavorites] = useState<Track[]>([]);
  const [downloads, setDownloads] = useState<Track[]>([]);
  const [recents, setRecents] = useState<Track[]>([]);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [menuFor, setMenuFor] = useState<Playlist | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameText, setRenameText] = useState('');

  const reload = useCallback(async () => {
    const [p, f, d, r] = await Promise.all([
      getPlaylists(),
      getFavorites(),
      verifyDownloads(),
      getRecents(),
    ]);
    setPlaylists(p);
    setFavorites(f);
    setDownloads(d);
    setRecents(r);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useFocusEffect(
    React.useCallback(() => {
      reload();
    }, [reload]),
  );

  const playTracks = (list: Track[], index = 0) => {
    if (list.length) {
      playQueue(list, index);
      nav.navigate('Player');
    }
  };

  const onCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    const pl = await createPlaylist(name);
    setCreateOpen(false);
    setNewName('');
    await reload();
    toast.show({ message: `FILED — ${pl.name.toUpperCase()}`, icon: 'add-circle' });
    nav.navigate('Playlist', { playlistId: pl.id });
  };

  const onRename = async () => {
    if (!menuFor) return;
    const name = renameText.trim();
    if (name) {
      await renamePlaylist(menuFor.id, name);
      toast.show({ message: 'RELABELED', icon: 'pencil' });
    }
    setRenameOpen(false);
    setMenuFor(null);
    await reload();
  };

  const onDelete = async () => {
    if (!menuFor) return;
    await deletePlaylist(menuFor.id);
    toast.show({ message: `STRUCK — ${menuFor.name.toUpperCase()}`, icon: 'trash-outline' });
    setMenuFor(null);
    await reload();
  };

  const openCollection = (title: string, tracks: Track[]) =>
    nav.navigate('Collection', {
      collection: { id: `local-${title}`, title, artwork: tracks[0]?.artwork ?? '' },
      tracks,
    });

  /* ── build the item list per chip ─────────────────────────────────── */
  const items: LibItem[] = [];
  if (chip === 'playlists') {
    items.push({
      key: 'liked',
      title: 'Liked Songs',
      subtitle: `Playlist · ${favorites.length} songs`,
      seed: 'liked',
      kind: 'liked',
      tracks: favorites,
    });
    items.push({
      key: 'stats',
      title: 'Your Sound',
      subtitle: 'Your listening stats',
      seed: 'stats',
      kind: 'stats',
    });
    playlists
      .slice()
      .sort((a, b) =>
        sortRecent
          ? (b.createdAt ?? 0) - (a.createdAt ?? 0)
          : a.name.localeCompare(b.name),
      )
      .forEach((p) =>
        items.push({
          key: p.id,
          title: p.name,
          subtitle: `${p.aiGenerated ? 'MINDBEAT · ' : 'Playlist · '}${p.tracks.length} songs`,
          artwork: p.tracks[0]?.artwork,
          seed: p.id,
          kind: p.aiGenerated ? 'ai' : 'playlist',
          playlistId: p.id,
          tracks: p.tracks,
        }),
      );
  } else if (chip === 'artists') {
    const seen = new Set<string>();
    [...recents, ...favorites].forEach((t) => {
      if (seen.has(t.artist)) return;
      seen.add(t.artist);
      items.push({
        key: `artist-${t.artist}`,
        title: t.artist,
        subtitle: 'Artist',
        artwork: t.artwork,
        seed: t.artist,
        kind: 'artist',
        circle: true,
      });
    });
    items.sort((a, b) => a.title.localeCompare(b.title));
  } else if (chip === 'albums') {
    // Every album row carries its tracks + provider album id. Tapping
    // opens the REAL album page (full tracklist from the provider) when
    // an id exists; the collected tracks are the offline fallback — the
    // old empty `tracks: []` route is what made crates albums show
    // "0 SONGS" forever (user-reported).
    const byAlbum = new Map<string, { tracks: Track[]; albumId?: string; artwork?: string; artist?: string }>();
    [...recents, ...favorites].forEach((t) => {
      const alb = t.album ?? '';
      if (!alb) return;
      const entry = byAlbum.get(alb);
      if (entry) {
        entry.tracks.push(t);
        if (!entry.albumId && t.albumId) entry.albumId = t.albumId;
      } else {
        byAlbum.set(alb, { tracks: [t], albumId: t.albumId, artwork: t.artwork, artist: t.artist });
      }
    });
    byAlbum.forEach((entry, alb) => {
      items.push({
        key: `album-${alb}`,
        title: alb,
        subtitle: `Album · ${entry.artist ?? 'Unknown'}`,
        artwork: entry.artwork,
        seed: alb,
        kind: 'album',
        albumId: entry.albumId,
        tracks: entry.tracks,
      });
    });
    items.sort((a, b) => a.title.localeCompare(b.title));
  } else {
    downloads.forEach((t) =>
      items.push({
        key: t.id,
        title: t.title,
        subtitle: `Song · ${t.artist}`,
        artwork: t.artwork,
        seed: t.id,
        kind: 'track',
        tracks: [t],
      }),
    );
  }

  const navigateItem = (item: LibItem) => {
    if (item.kind === 'stats') return nav.navigate('Stats');
    if (item.playlistId) return nav.navigate('Playlist', { playlistId: item.playlistId });
    if (item.kind === 'artist')
      return nav.navigate('Collection', {
        collection: {
          id: `artist-${item.title}`,
          title: item.title,
          subtitle: 'Artist',
          artwork: '',
          kind: 'search',
          query: item.title,
        },
      });
    if (item.kind === 'album') {
      if (item.albumId) {
        // REAL album page — lazy-loads the provider's full tracklist
        return nav.navigate('Collection', {
          collection: {
            id: item.albumId,
            title: item.title,
            subtitle: 'Album',
            artwork: item.artwork ?? '',
            kind: 'album',
          },
        });
      }
      // no provider id (local-only track) — open the collected rows
      return nav.navigate('Collection', {
        collection: {
          id: `local-${item.title}`,
          title: item.title,
          artwork: item.artwork ?? '',
        },
        tracks: item.tracks ?? [],
      });
    }
    if (item.kind === 'track')
      return nav.navigate('Collection', {
        collection: {
          id: `local-${item.title}`,
          title: item.title,
          artwork: item.artwork ?? '',
        },
        tracks: item.tracks ?? [],
      });
    openCollection(item.title, item.tracks ?? []);
  };

  const renderItem = ({ item, index }: { item: LibItem; index: number }) => {
    const longPressPlaylist = () => {
      const pl = playlists.find((p) => p.id === item.playlistId);
      if (pl) {
        setMenuFor(pl);
        setRenameText(pl.name);
      }
    };
    return (
      <Pressable
        style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.paper2 }]}
        onPress={() => navigateItem(item)}
        onLongPress={longPressPlaylist}
        delayLongPress={300}
      >
        <MonoText size={10} bold color={colors.ink40} style={styles.rowIndex}>
          {String(index + 1).padStart(2, '0')}
        </MonoText>
        {item.kind === 'liked' ? (
          <View style={[styles.kindTile, { backgroundColor: colors.orange }]}>
            <Ionicons name="heart" size={22} color={colors.ink} />
          </View>
        ) : item.kind === 'stats' ? (
          <View style={[styles.kindTile, { backgroundColor: colors.ink }]}>
            <Ionicons name="pulse" size={22} color={colors.acid} />
          </View>
        ) : item.kind === 'ai' ? (
          <View style={[styles.kindTile, { backgroundColor: colors.acid }]}>
            <Ionicons name="sparkles" size={22} color={colors.ink} />
          </View>
        ) : (
          <Artwork
            uri={item.artwork}
            seed={item.seed}
            size={48}
            variant={item.circle ? 'circle' : 'square'}
          />
        )}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {item.title}
          </Text>
          <MonoText size={9.5} style={{ marginTop: 2 }} numberOfLines={1}>
            {item.subtitle}
          </MonoText>
        </View>
        <Ionicons name="chevron-forward" size={15} color={colors.ink40} />
      </Pressable>
    );
  };

  /* Grid view — 2-col bordered covers. */
  const { width: frameWidth } = useSafeAreaFrame();
  const gridCell = Math.floor((frameWidth - 18 * 2 - 10) / 2);
  const renderGridItem = ({ item }: { item: LibItem }) => (
    <Brutal haptic shadow={3} style={{ width: gridCell }} onPress={() => navigateItem(item)}>
      {item.kind === 'liked' ? (
        <View style={[styles.kindTile, { width: gridCell, height: gridCell, backgroundColor: colors.orange }]}>
          <Ionicons name="heart" size={38} color={colors.ink} />
        </View>
      ) : item.kind === 'stats' ? (
        <View style={[styles.kindTile, { width: gridCell, height: gridCell, backgroundColor: colors.ink }]}>
          <Ionicons name="pulse" size={38} color={colors.acid} />
        </View>
      ) : item.kind === 'ai' ? (
        <View style={[styles.kindTile, { width: gridCell, height: gridCell, backgroundColor: colors.acid }]}>
          <Ionicons name="sparkles" size={38} color={colors.ink} />
        </View>
      ) : (
        <Artwork
          uri={item.artwork}
          seed={item.seed}
          size={gridCell}
          variant={item.circle ? 'circle' : 'square'}
        />
      )}
      <Text style={styles.gridTitle} numberOfLines={1}>
        {item.title}
      </Text>
      <MonoText size={9} style={{ marginTop: 2 }} numberOfLines={1}>
        {item.subtitle}
      </MonoText>
    </Brutal>
  );

  const emptyCopy: Record<Chip, { title: string; sub: string }> = {
    playlists: {
      title: 'Open your first crate',
      sub: "It's easy — we'll help you",
    },
    artists: { title: 'No artists yet', sub: 'Songs you play will show artists here' },
    albums: { title: 'No albums yet', sub: 'Music you play will collect here' },
    downloaded: { title: 'No downloads', sub: 'Save from the player for offline listening' },
  };

  const showEmpty = chip === 'playlists' ? items.length <= 2 : items.length === 0;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <FlatList
        data={items}
        keyExtractor={(i) => i.key}
        renderItem={grid ? renderGridItem : renderItem}
        numColumns={grid ? 2 : 1}
        key={grid ? 'grid' : 'list'}
        columnWrapperStyle={grid ? { gap: 10, paddingHorizontal: 18 } : undefined}
        contentContainerStyle={
          grid
            ? { paddingBottom: 190, gap: 14 }
            : { paddingBottom: 190, flexGrow: 1 }
        }
        ListHeaderComponent={
          <View>
            {/* masthead */}
            <View style={styles.headerRow}>
              <OutlineText style={styles.title} outline={1.5}>
                The Crates
              </OutlineText>
              <View style={{ flexDirection: 'row', gap: 6 }}>
                <Brutal haptic shadow={2} style={styles.iconBtn} onPress={() => setCreateOpen(true)}>
                  <Ionicons name="add" size={18} color={colors.ink} />
                </Brutal>
              </View>
            </View>

            {/* filter chips */}
            <View style={styles.chips}>
              {(['playlists', 'artists', 'albums', 'downloaded'] as Chip[]).map((t) => (
                <Brutal
                  key={t}
                  haptic={chip !== t}
                  shadow={2}
                  onPress={() => setChip(t)}
                  style={[styles.chip, chip === t && styles.chipActive]}
                >
                  <MonoText size={10.5} bold color={chip === t ? colors.ink : colors.ink60} style={{ letterSpacing: 0.8 }}>
                    {t === 'playlists'
                      ? 'Playlists'
                      : t === 'artists'
                        ? 'Artists'
                        : t === 'albums'
                          ? 'Albums'
                          : 'Saved'}
                  </MonoText>
                </Brutal>
              ))}
            </View>

            {/* sort row + view toggle */}
            <View style={styles.sortRow}>
              <Pressable hitSlop={8} onPress={() => setSortRecent((v) => !v)} style={styles.sortBtn}>
                <Ionicons name="swap-vertical" size={13} color={colors.ink60} />
                <MonoText size={10} bold color={colors.ink60} style={{ letterSpacing: 1 }}>
                  {sortRecent ? 'RECENT' : 'A-Z'}
                </MonoText>
              </Pressable>
              <Pressable
                hitSlop={8}
                onPress={() => setGrid((v) => !v)}
                accessibilityLabel={grid ? 'Switch to list view' : 'Switch to grid view'}
              >
                <Ionicons name={grid ? 'list' : 'grid'} size={17} color={colors.ink60} />
              </Pressable>
            </View>

            {/* Liked Songs hero (orange block) */}
            {chip === 'playlists' && favorites.length >= 0 ? (
              <Brutal haptic shadow={4} style={styles.likedHero} onPress={() => openCollection('Liked Songs', favorites)} testID="liked-hero">
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.likedTitle} allowFontScaling={false}>
                    Liked{'\n'}Songs
                  </Text>
                  <MonoText size={10} bold color={colors.ink} style={{ marginTop: 6, letterSpacing: 0.8 }}>
                    {favorites.length} SONGS · ON DEVICE
                  </MonoText>
                </View>
                <View style={styles.likedPlay}>
                  <Ionicons name="play" size={17} color={colors.acid} />
                </View>
              </Brutal>
            ) : null}
          </View>
        }
        ListFooterComponent={
          <>
            {/* Premium banner */}
            <Brutal haptic shadow={4} style={styles.premiumBanner} onPress={() => nav.navigate('Premium')} testID="premium-banner">
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.premiumTitle}>TSF Premium</Text>
                <MonoText size={10} color={colors.ink60} style={{ marginTop: 6, lineHeight: 16 }}>
                  320 kbps stays free forever. Premium adds lossless AAC+ transport, waveform seek and offline artwork caching.
                </MonoText>
              </View>
              <View style={styles.premiumBtn}>
                <MonoText size={10} bold color={colors.acid} style={{ letterSpacing: 1 }}>
                  TRY 1 MONTH FREE
                </MonoText>
              </View>
            </Brutal>
            <MonoText size={9} color={colors.ink40} style={styles.version}>
              PULSE EDITION · VERSION {Constants.expoConfig?.version ?? '4.0.0'}
            </MonoText>
          </>
        }
        ListEmptyComponent={
          chip === 'playlists' ? null : (
            <View style={styles.empty}>
              <Ionicons
                name={chip === 'downloaded' ? 'arrow-down-circle-outline' : 'albums-outline'}
                size={40}
                color={colors.ink40}
              />
              <Text style={styles.emptyTitle}>{emptyCopy[chip].title.toUpperCase()}</Text>
              <MonoText size={10} color={colors.ink60} style={{ textAlign: 'center' }}>
                {emptyCopy[chip].sub.toUpperCase()}
              </MonoText>
            </View>
          )
        }
      />

      {showEmpty && chip === 'playlists' ? (
        <View style={styles.emptyOverlay}>
          <Text style={styles.emptyTitle}>OPEN YOUR FIRST CRATE</Text>
          <MonoText size={10} color={colors.ink60}>
            IT'S EASY — WE'LL HELP YOU
          </MonoText>
          <Brutal haptic shadow={3} style={styles.emptyCreateBtn} onPress={() => setCreateOpen(true)}>
            <MonoText size={10.5} bold color={colors.ink}>
              CREATE
            </MonoText>
          </Brutal>
        </View>
      ) : null}

      {/* Create playlist modal */}
      <Modal visible={createOpen} transparent animationType="fade" onRequestClose={() => setCreateOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setCreateOpen(false)}>
          <Pressable style={styles.dialog} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.dialogTitle}>New crate</Text>
            <TextInput
              style={styles.dialogInput}
              placeholder="CRATE NAME"
              placeholderTextColor={colors.ink40}
              value={newName}
              onChangeText={setNewName}
              autoFocus
              onSubmitEditing={onCreate}
            />
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
              <Brutal style={styles.dialogCancel} shadow={0} pressOffset={1} haptic onPress={() => setCreateOpen(false)}>
                <MonoText size={10.5} bold color={colors.ink}>
                  CANCEL
                </MonoText>
              </Brutal>
              <Brutal style={[styles.dialogCancel, styles.chipActive]} shadow={0} pressOffset={1} haptic onPress={onCreate}>
                <MonoText size={10.5} bold color={colors.ink}>
                  CREATE
                </MonoText>
              </Brutal>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Playlist long-press menu */}
      <Modal visible={!!menuFor} transparent animationType="fade" onRequestClose={() => setMenuFor(null)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setMenuFor(null)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.sheetTitle} numberOfLines={1}>
              {menuFor?.name.toUpperCase()}
            </Text>
            <Pressable style={({ pressed }) => [styles.sheetAction, pressed && { backgroundColor: colors.paper2 }]} onPress={() => setRenameOpen(true)}>
              <Ionicons name="pencil-outline" size={18} color={colors.ink} />
              <MonoText size={10.5} bold color={colors.ink} style={{ letterSpacing: 0.8 }}>
                RENAME
              </MonoText>
            </Pressable>
            <Pressable style={({ pressed }) => [styles.sheetAction, pressed && { backgroundColor: colors.paper2 }]} onPress={onDelete}>
              <Ionicons name="trash-outline" size={18} color={colors.orangeDeep} />
              <MonoText size={10.5} bold color={colors.orangeDeep} style={{ letterSpacing: 0.8 }}>
                DELETE CRATE
              </MonoText>
            </Pressable>
            <Pressable style={({ pressed }) => [styles.sheetAction, pressed && { backgroundColor: colors.paper2 }]} onPress={() => setMenuFor(null)}>
              <Ionicons name="close" size={18} color={colors.ink60} />
              <MonoText size={10.5} bold color={colors.ink60} style={{ letterSpacing: 0.8 }}>
                CANCEL
              </MonoText>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Rename modal */}
      <Modal visible={renameOpen} transparent animationType="fade" onRequestClose={() => setRenameOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setRenameOpen(false)}>
          <Pressable style={styles.dialog} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.dialogTitle}>Rename crate</Text>
            <TextInput
              style={styles.dialogInput}
              placeholder="CRATE NAME"
              placeholderTextColor={colors.ink40}
              value={renameText}
              onChangeText={setRenameText}
              autoFocus
              onSubmitEditing={onRename}
            />
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
              <Brutal style={styles.dialogCancel} shadow={0} pressOffset={1} haptic onPress={() => setRenameOpen(false)}>
                <MonoText size={10.5} bold color={colors.ink}>
                  CANCEL
                </MonoText>
              </Brutal>
              <Brutal style={[styles.dialogCancel, styles.chipActive]} shadow={0} pressOffset={1} haptic onPress={onRename}>
                <MonoText size={10.5} bold color={colors.ink}>
                  SAVE
                </MonoText>
              </Brutal>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 14,
  },
  title: {
    fontFamily: fonts.display,
    fontSize: 34,
    textTransform: 'uppercase',
    letterSpacing: -0.2,
    lineHeight: 36,
  },
  iconBtn: {
    width: 38,
    height: 38,
    borderWidth: 1.5,
    borderColor: colors.ink,
    backgroundColor: colors.paper,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 18,
    gap: 8,
    marginBottom: 10,
  },
  chip: {
    paddingHorizontal: 13,
    paddingVertical: 7,
    borderWidth: 1.5,
    borderColor: colors.ink,
    backgroundColor: colors.paper,
  },
  chipActive: { backgroundColor: colors.acid },
  sortRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingBottom: 12,
  },
  sortBtn: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  likedHero: {
    marginHorizontal: 18,
    marginTop: 4,
    marginBottom: 14,
    borderWidth: 1.5,
    borderColor: colors.ink,
    backgroundColor: colors.orange,
    padding: 18,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 14,
    minHeight: 118,
  },
  likedTitle: {
    fontFamily: fonts.display,
    fontSize: 30,
    lineHeight: 29,
    color: colors.ink,
    textTransform: 'uppercase',
  },
  likedPlay: {
    width: 48,
    height: 48,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  premiumBanner: {
    marginHorizontal: 18,
    marginTop: 22,
    borderWidth: 1.5,
    borderColor: colors.ink,
    backgroundColor: colors.paper2,
    padding: 16,
  },
  premiumTitle: {
    fontFamily: fonts.display,
    fontSize: 15,
    color: colors.ink,
    textTransform: 'uppercase',
  },
  premiumBtn: {
    alignSelf: 'flex-start',
    marginTop: 12,
    backgroundColor: colors.ink,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  version: {
    textAlign: 'center',
    marginTop: 18,
    letterSpacing: 1.4,
  },
  gridTitle: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 12.5,
    textTransform: 'uppercase',
    letterSpacing: 0.2,
    marginTop: 8,
  },
  rowIndex: { width: 22 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: colors.ink16,
    minHeight: 70,
  },
  rowTitle: {
    color: colors.ink,
    fontSize: 13.5,
    fontFamily: fonts.bold,
    textTransform: 'uppercase',
    letterSpacing: 0.2,
  },
  kindTile: {
    width: 48,
    height: 48,
    borderWidth: 1.5,
    borderColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 32 },
  emptyOverlay: { alignItems: 'center', gap: 8, padding: 32, paddingTop: 52 },
  emptyTitle: {
    color: colors.ink,
    fontFamily: fonts.display,
    fontSize: 17,
    textTransform: 'uppercase',
    textAlign: 'center',
  },
  emptyCreateBtn: {
    backgroundColor: colors.acid,
    borderWidth: 1.5,
    borderColor: colors.ink,
    paddingHorizontal: 24,
    paddingVertical: 10,
    marginTop: 8,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  dialog: {
    width: '100%',
    backgroundColor: colors.paper,
    borderWidth: 2,
    borderColor: colors.ink,
    padding: 24,
    ...({ shadowColor: colors.ink, shadowOpacity: 1, shadowRadius: 0, shadowOffset: { width: 6, height: 6 }, elevation: 6 } as object),
  },
  dialogTitle: {
    color: colors.ink,
    fontFamily: fonts.display,
    fontSize: 17,
    textTransform: 'uppercase',
  },
  dialogInput: {
    borderWidth: 1.5,
    borderColor: colors.ink,
    backgroundColor: colors.paper,
    color: colors.ink,
    fontFamily: fonts.monoBold,
    fontSize: 12,
    letterSpacing: 0.6,
    paddingHorizontal: 12,
    marginTop: 16,
    height: 44,
  },
  dialogCancel: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: colors.ink,
    alignItems: 'center',
    paddingVertical: 11,
  },
  sheet: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 24,
    backgroundColor: colors.paper,
    borderWidth: 2,
    borderColor: colors.ink,
    overflow: 'hidden',
    ...({ shadowColor: colors.ink, shadowOpacity: 1, shadowRadius: 0, shadowOffset: { width: 6, height: 6 }, elevation: 6 } as object),
  },
  sheetTitle: {
    color: colors.ink,
    fontFamily: fonts.display,
    fontSize: 15,
    textTransform: 'uppercase',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
    borderBottomWidth: 2,
    borderBottomColor: colors.ink,
  },
  sheetAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderBottomColor: colors.ink16,
  },
});
