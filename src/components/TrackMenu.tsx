/**
 * TrackMenu — the long-press context sheet for any track:
 * Play next / Add to queue / Add to playlist (with inline picker +
 * create) / Download. Shared by playlist rows, search rows, queue.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Playlist, Track } from '../types';
import {
  addTrackToPlaylist,
  createPlaylist,
  getPlaylists,
} from '../storage/store';
import { downloadTrack, isDownloaded } from '../storage/downloads';
import {
  applyMetaOverride,
  getMetaOverridesSync,
  metaOverrideKeyFor,
  removeMetaOverride,
  saveMetaOverride,
  subscribeMetaOverrides,
} from '../storage/metaOverrides';
import { usePlayer } from '../player/PlayerProvider';
import { mindbeat } from '../ai/mindbeat';
import { getAppTables, contentKeyOf } from '../storage/appTables';
import { STORIES } from '../ai/core/constants';
import { useToast } from '../components/Toast';
import { PressableScale } from '../components/PressableScale';
import { colors, fonts, radius, spacing } from '../theme';

export interface ExtraAction {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}

export function TrackMenu({
  track,
  visible,
  onClose,
  extraActions,
}: {
  track: Track | null;
  visible: boolean;
  onClose: () => void;
  /** Screen-specific actions injected at the top (e.g. Start Song Radio). */
  extraActions?: ExtraAction[];
}) {
  const { playNext, addToQueue } = usePlayer();
  const toast = useToast();
  const [picking, setPicking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [downloaded, setDownloaded] = useState(false);
  // THE TEN F5 — Edit Info: the local metadata correction editor. The
  // header shows the OVERRIDDEN view; actions operate on the original.
  const [, forceOverrideTick] = useState(0);
  useEffect(() => subscribeMetaOverrides(() => forceOverrideTick((n) => n + 1)), []);
  const shown = track ? applyMetaOverride(track, getMetaOverridesSync()) : null;
  const [editing, setEditing] = useState(false);
  const [eTitle, setETitle] = useState('');
  const [eArtist, setEArtist] = useState('');
  const [eAlbum, setEAlbum] = useState('');
  const [eArtwork, setEArtwork] = useState('');
  const hasOverride = track ? !!getMetaOverridesSync()[metaOverrideKeyFor(track)] : false;
  // MAGNUM OPUS F6 — the Song Stories editor ("Add a memory"). The story
  // is keyed by recordingKey (NOT trackId) and never carries a streamUrl:
  // the schema has no column for one (type-level law in songStories.ts).
  const [storyOpen, setStoryOpen] = useState(false);
  const [storyText, setStoryText] = useState('');
  const [storyExists, setStoryExists] = useState(false);

  useEffect(() => {
    if (visible && track) {
      setPicking(false);
      setCreating(false);
      setNewName('');
      setEditing(false);
      setStoryOpen(false);
      setStoryText('');
      setStoryExists(false);
      getPlaylists().then(setPlaylists);
      isDownloaded(track.id).then(setDownloaded);
      // the existing memory (if any) loads so the editor edits, not wipes.
      // A cancelled flag drops stale responses: opening menu B before A's
      // story resolved must never put A's memory text into B's editor
      // (the blind critic's P2 — the guard the story display had and the
      // editor lacked).
      let cancelled = false;
      if (track.title && track.artist) {
        getAppTables()
          .then((t) => t.stories.getStory(contentKeyOf(track)))
          .then((story) => {
            if (!cancelled && story) {
              setStoryExists(true);
              setStoryText(story.text);
            }
          })
          .catch(() => undefined);
      }
      return () => {
        cancelled = true;
      };
    }
  }, [visible, track]);

  const openEditor = useCallback(() => {
    if (!track) return;
    const cur = getMetaOverridesSync()[metaOverrideKeyFor(track)];
    setETitle(cur?.title ?? track.title);
    setEArtist(cur?.artist ?? track.artist);
    setEAlbum(cur?.album ?? track.album ?? '');
    setEArtwork(cur?.artwork ?? track.artwork ?? '');
    setEditing(true);
  }, [track]);

  const saveEdits = useCallback(async () => {
    if (!track) return;
    const allEmpty = ![eTitle, eArtist, eAlbum, eArtwork].some((v) => v.trim());
    if (allEmpty) {
      // Saving an entirely blank form is NOT a success story: with an
      // existing override it means "back to provider truth"; otherwise
      // it is an honest no-op (never a lying "INFO UPDATED" toast).
      if (hasOverride) {
        await removeMetaOverride(metaOverrideKeyFor(track));
        toast.show({ message: 'PROVIDER INFO RESTORED', icon: 'refresh-outline' });
      } else {
        toast.show({ message: 'NOTHING TO CHANGE', icon: 'information-circle-outline' });
      }
      onClose();
      return;
    }
    await saveMetaOverride(metaOverrideKeyFor(track), {
      title: eTitle,
      artist: eArtist,
      album: eAlbum,
      artwork: eArtwork,
    });
    toast.show({ message: 'INFO UPDATED · STORED ON THIS DEVICE ONLY', icon: 'create-outline' });
    onClose();
  }, [track, eTitle, eArtist, eAlbum, eArtwork, hasOverride, toast, onClose]);

  const resetEdits = useCallback(async () => {
    if (!track) return;
    await removeMetaOverride(metaOverrideKeyFor(track));
    toast.show({ message: 'PROVIDER INFO RESTORED', icon: 'refresh-outline' });
    onClose();
  }, [track, toast, onClose]);

  // MAGNUM OPUS F6 — save / remove the memory. Blank save is an honest
  // no-op (isBlankStory), never a lying "saved" toast.
  const saveStory = useCallback(async () => {
    if (!track) return;
    const tables = await getAppTables();
    const key = contentKeyOf(track);
    const text = storyText;
    if (!text.trim()) {
      if (storyExists) {
        await tables.stories.removeStory(key);
        toast.show({ message: 'MEMORY REMOVED', icon: 'trash-outline' });
      } else {
        toast.show({ message: 'NOTHING TO REMEMBER YET', icon: 'information-circle-outline' });
      }
      onClose();
      return;
    }
    await tables.stories.setStory(key, text, Date.now());
    toast.show({ message: 'MEMORY SAVED · ON THIS DEVICE ONLY', icon: 'heart-outline' });
    onClose();
  }, [track, storyText, storyExists, toast, onClose]);

  const removeStory = useCallback(async () => {
    if (!track) return;
    const tables = await getAppTables();
    await tables.stories.removeStory(contentKeyOf(track));
    toast.show({ message: 'MEMORY REMOVED', icon: 'trash-outline' });
    onClose();
  }, [track, toast, onClose]);

  const add = useCallback(
    async (playlist: Playlist) => {
      if (!track) return;
      const ok = await addTrackToPlaylist(playlist.id, track);
      toast.show({
        message: ok ? `Added to ${playlist.name}` : `Already in ${playlist.name}`,
        icon: 'checkmark-circle',
      });
      onClose();
    },
    [track, toast, onClose],
  );

  const createAndAdd = useCallback(async () => {
    if (!track) return;
    const name = newName.trim() || 'New Playlist';
    const pl = await createPlaylist(name, [track]);
    toast.show({ message: `Created “${pl.name}” with ${track.title}`, icon: 'add-circle' });
    onClose();
  }, [track, newName, toast, onClose]);

  const onDownload = useCallback(async () => {
    if (!track) return;
    toast.show({ message: `Downloading ${track.title}…`, icon: 'arrow-down-circle-outline' });
    const ok = await downloadTrack(track);
    toast.show({
      message: ok ? `Downloaded ${track.title}` : `Couldn't download ${track.title}`,
      icon: ok ? 'checkmark-circle' : 'alert-circle-outline',
    });
    if (ok) {
      setDownloaded(true);
      // Ownership intent — +2.5 evidence (§5.2).
      void mindbeat.ledgerApi?.downloaded({ id: track.id, artist: track.artist });
    }
  }, [track, toast]);

  if (!track) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.trackHeader}>
            <Text style={styles.trackTitle} numberOfLines={1}>
              {shown?.title}
            </Text>
            <Text style={styles.trackArtist} numberOfLines={1}>
              {shown?.artist}
            </Text>
          </View>

          {!picking ? (
            <>
              {extraActions?.map((action) => (
                <Action
                  key={action.label}
                  icon={action.icon}
                  label={action.label}
                  onPress={() => {
                    action.onPress();
                    onClose();
                  }}
                />
              ))}
              {/* THE TEN F5 — the local metadata editor (this device only) */}
              {editing ? (
                <>
                  <Text style={styles.pickerTitle}>Edit info · this device only</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="Title"
                    placeholderTextColor={colors.textFaint}
                    value={eTitle}
                    onChangeText={setETitle}
                  />
                  <TextInput
                    style={styles.input}
                    placeholder="Artist"
                    placeholderTextColor={colors.textFaint}
                    value={eArtist}
                    onChangeText={setEArtist}
                  />
                  <TextInput
                    style={styles.input}
                    placeholder="Album"
                    placeholderTextColor={colors.textFaint}
                    value={eAlbum}
                    onChangeText={setEAlbum}
                  />
                  <TextInput
                    style={styles.input}
                    placeholder="Artwork URL"
                    placeholderTextColor={colors.textFaint}
                    value={eArtwork}
                    onChangeText={setEArtwork}
                    autoCapitalize="none"
                  />
                  <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
                    {hasOverride ? (
                      <PressableScale style={styles.cancelBtn} onPress={() => void resetEdits()} haptic>
                        <Text style={styles.cancelText}>Reset</Text>
                      </PressableScale>
                    ) : (
                      <PressableScale style={styles.cancelBtn} onPress={() => setEditing(false)} haptic>
                        <Text style={styles.cancelText}>Back</Text>
                      </PressableScale>
                    )}
                    <PressableScale style={styles.createBtn} onPress={() => void saveEdits()} haptic>
                      <Text style={styles.createText}>Save</Text>
                    </PressableScale>
                  </View>
                </>
              ) : (
                <Action
                  icon="create-outline"
                  label="Edit info"
                  onPress={() => openEditor()}
                />
              )}
              {/* MAGNUM OPUS F6 — the Song Stories editor ("Add a memory").
                  A memory is factual user data: the kill switch never gates
                  it, and it stays on this device (the schema has no column
                  a streamUrl could occupy). */}
              {storyOpen ? (
                <>
                  <Text style={styles.pickerTitle}>
                    {storyExists ? 'Edit the memory' : 'Add a memory'} · this device only
                  </Text>
                  <TextInput
                    style={[styles.input, styles.storyInput]}
                    placeholder="This was playing when…"
                    placeholderTextColor={colors.textFaint}
                    value={storyText}
                    onChangeText={setStoryText}
                    multiline
                    maxLength={STORIES.maxChars}
                    testID="story-editor-input"
                  />
                  <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
                    <PressableScale style={styles.cancelBtn} onPress={() => setStoryOpen(false)} haptic>
                      <Text style={styles.cancelText}>Back</Text>
                    </PressableScale>
                    {storyExists ? (
                      <PressableScale style={styles.cancelBtn} onPress={() => void removeStory()} haptic>
                        <Text style={styles.cancelText}>Remove</Text>
                      </PressableScale>
                    ) : null}
                    <PressableScale style={styles.createBtn} onPress={() => void saveStory()} haptic>
                      <Text style={styles.createText}>Save</Text>
                    </PressableScale>
                  </View>
                </>
              ) : (
                <Action
                  icon="sparkles-outline"
                  label={storyExists ? 'Edit the memory' : 'Add a memory'}
                  onPress={() => setStoryOpen(true)}
                />
              )}
              {/* MINDBEAT taste corrections (§6.6) — every action changes
                  the very next recommendation the engine makes.
                  DELIBERATE CARVE-OUT (THE TEN F5): Boost/Mute act on the
                  PROVIDER artist string, while the header above may show
                  the locally corrected one — the intelligence layer's
                  keys stay provider-native (the correction is a display
                  lens; see src/storage/metaOverrides.ts). */}
              <Action
                icon="close-circle-outline"
                label="Not for me"
                dim
                onPress={() => {
                  void mindbeat.notForMe(track, 'user_queue');
                  toast.show({
                    message: `Got it — fewer songs like ${track.title}`,
                    icon: 'remove-circle-outline',
                  });
                  onClose();
                }}
              />
              <Action
                icon="trending-up-outline"
                label={`Boost ${track.artist.split(' feat')[0]}`}
                onPress={() => {
                  void mindbeat.boostArtist(track.artist);
                  toast.show({ message: `${track.artist.split(' feat')[0]} will show up more`, icon: 'trending-up' });
                  onClose();
                }}
              />
              <Action
                icon="volume-mute-outline"
                label={`Mute ${track.artist.split(' feat')[0]}`}
                dim
                onPress={() => {
                  void mindbeat.muteArtist(track.artist);
                  toast.show({ message: `${track.artist.split(' feat')[0]} won't be recommended`, icon: 'volume-mute' });
                  onClose();
                }}
              />
              <Action
                icon="play-forward-outline"
                label="Play next"
                onPress={() => {
                  void playNext(track);
                  onClose();
                }}
              />
              <Action
                icon="add-outline"
                label="Add to queue"
                onPress={() => {
                  void addToQueue(track);
                  onClose();
                }}
              />
              <Action
                icon="add-circle-outline"
                label="Add to playlist"
                onPress={() => setPicking(true)}
              />
              {track.source === 'youtube' ? (
                <Action
                  icon="cloud-offline-outline"
                  label="YouTube streams only"
                  dim
                  onPress={onClose}
                />
              ) : (
                <Action
                  icon={downloaded ? 'checkmark-circle' : 'arrow-down-circle-outline'}
                  label={downloaded ? 'Downloaded' : 'Download'}
                  dim={downloaded}
                  onPress={() => {
                    if (downloaded) {
                      onClose();
                      return;
                    }
                    void onDownload();
                    onClose();
                  }}
                />
              )}
            </>
          ) : creating ? (
            <>
              <Text style={styles.pickerTitle}>New playlist</Text>
              <TextInput
                style={styles.input}
                placeholder="Playlist name"
                placeholderTextColor={colors.textFaint}
                value={newName}
                onChangeText={setNewName}
                autoFocus
                onSubmitEditing={createAndAdd}
              />
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
                <PressableScale style={styles.cancelBtn} onPress={() => setCreating(false)} haptic>
                  <Text style={styles.cancelText}>Back</Text>
                </PressableScale>
                <PressableScale style={styles.createBtn} onPress={createAndAdd} haptic>
                  <Text style={styles.createText}>Create</Text>
                </PressableScale>
              </View>
            </>
          ) : (
            <>
              <Text style={styles.pickerTitle}>Add to playlist</Text>
              <ScrollView style={{ maxHeight: 260 }} nestedScrollEnabled>
                <Action
                  icon="add-circle-outline"
                  label="New playlist…"
                  onPress={() => setCreating(true)}
                />
                {playlists.map((pl) => (
                  <Action
                    key={pl.id}
                    icon="musical-notes-outline"
                    label={`${pl.name} · ${pl.tracks.length}`}
                    onPress={() => void add(pl)}
                  />
                ))}
                {playlists.length === 0 ? (
                  <Text style={styles.noPlaylists}>No playlists yet — create one above</Text>
                ) : null}
              </ScrollView>
              <Action icon="chevron-back" label="Back" dim onPress={() => setPicking(false)} />
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Action({
  icon,
  label,
  onPress,
  dim,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  dim?: boolean;
}) {
  return (
    <PressableScale style={styles.action} onPress={onPress} haptic>
      <Ionicons name={icon} size={19} color={dim ? colors.ink40 : colors.ink} />
      <Text style={[styles.actionText, dim && { color: colors.ink40 }]} numberOfLines={1}>
        {label.toUpperCase()}
      </Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(22,21,19,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.paper,
    borderTopWidth: 3,
    borderTopColor: colors.ink,
    paddingBottom: 24,
    overflow: 'hidden',
    ...({ shadowColor: colors.ink, shadowOpacity: 1, shadowRadius: 0, shadowOffset: { width: 0, height: -4 }, elevation: 8 } as object),
  },
  trackHeader: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 10,
    gap: 3,
    borderBottomWidth: 2,
    borderBottomColor: colors.ink,
  },
  trackTitle: {
    color: colors.ink,
    fontFamily: fonts.display,
    fontSize: 17,
    textTransform: 'uppercase',
  },
  trackArtist: {
    color: colors.ink60,
    fontSize: 10,
    fontFamily: fonts.mono,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.ink16,
  },
  actionText: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '700',
    fontFamily: fonts.bold,
    letterSpacing: 1,
  },
  pickerTitle: {
    color: colors.ink60,
    fontSize: 9.5,
    fontWeight: '700',
    fontFamily: fonts.monoBold,
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 2,
  },
  input: {
    borderWidth: 1.5,
    borderColor: colors.ink,
    backgroundColor: colors.paper,
    color: colors.ink,
    fontSize: 12,
    fontFamily: fonts.monoBold,
    letterSpacing: 0.6,
    paddingHorizontal: 12,
    marginHorizontal: 20,
    marginTop: 8,
    height: 44,
  },
  storyInput: {
    height: 'auto',
    minHeight: 88,
    paddingTop: 10,
    paddingBottom: 10,
    fontFamily: fonts.mono,
  },
  cancelBtn: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: colors.ink,
    backgroundColor: colors.paper,
    alignItems: 'center',
    paddingVertical: 12,
    marginLeft: 20,
  },
  createBtn: {
    flex: 1,
    backgroundColor: colors.acid,
    borderWidth: 1.5,
    borderColor: colors.ink,
    alignItems: 'center',
    paddingVertical: 12,
    marginRight: 20,
  },
  cancelText: { color: colors.ink, fontSize: 11, fontWeight: '700', fontFamily: fonts.monoBold, letterSpacing: 1 },
  createText: { color: colors.ink, fontSize: 11, fontWeight: '700', fontFamily: fonts.monoBold, letterSpacing: 1 },
  noPlaylists: {
    color: colors.ink40,
    fontSize: 10,
    fontFamily: fonts.mono,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
});
