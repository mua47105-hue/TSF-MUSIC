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
import { usePlayer } from '../player/PlayerProvider';
import { mindbeat } from '../ai/mindbeat';
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

  useEffect(() => {
    if (visible && track) {
      setPicking(false);
      setCreating(false);
      setNewName('');
      getPlaylists().then(setPlaylists);
      isDownloaded(track.id).then(setDownloaded);
    }
  }, [visible, track]);

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
              {track.title}
            </Text>
            <Text style={styles.trackArtist} numberOfLines={1}>
              {track.artist}
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
              {/* MINDBEAT taste corrections (§6.6) — every action changes
                  the very next recommendation the engine makes. */}
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
      <Ionicons name={icon} size={21} color={dim ? colors.textFaint : colors.text} />
      <Text style={[styles.actionText, dim && { color: colors.textFaint }]} numberOfLines={1}>
        {label}
      </Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: 'rgba(20,21,26,0.98)',
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassBorder,
    paddingBottom: spacing.xxl,
    overflow: 'hidden',
  },
  trackHeader: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    paddingBottom: spacing.md,
    gap: 2,
  },
  trackTitle: { color: colors.text, fontSize: 17, fontWeight: '800', fontFamily: fonts.extrabold },
  trackArtist: { color: colors.textDim, fontSize: 13, fontFamily: fonts.regular },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md + 2,
    paddingHorizontal: spacing.xl,
    paddingVertical: 14,
  },
  actionText: { color: colors.text, fontSize: 15, fontWeight: '500', fontFamily: fonts.medium },
  pickerTitle: {
    color: colors.textDim,
    fontSize: 12,
    fontWeight: '700',
    fontFamily: fonts.bold,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  input: {
    backgroundColor: colors.glassStrong,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassBorder,
    borderRadius: radius.md,
    color: colors.text,
    fontSize: 15,
    fontFamily: fonts.medium,
    paddingHorizontal: spacing.md,
    marginHorizontal: spacing.xl,
    marginTop: spacing.sm,
    height: 44,
  },
  cancelBtn: {
    flex: 1,
    backgroundColor: colors.glassStrong,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassBorder,
    borderRadius: radius.full,
    alignItems: 'center',
    paddingVertical: 12,
    marginLeft: spacing.xl,
  },
  createBtn: {
    flex: 1,
    backgroundColor: colors.accent,
    borderRadius: radius.full,
    alignItems: 'center',
    paddingVertical: 12,
    marginRight: spacing.xl,
  },
  cancelText: { color: colors.text, fontSize: 14, fontWeight: '700', fontFamily: fonts.bold },
  createText: { color: colors.accentDeep, fontSize: 14, fontWeight: '800', fontFamily: fonts.extrabold },
  noPlaylists: {
    color: colors.textFaint,
    fontSize: 13,
    fontFamily: fonts.regular,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
});
