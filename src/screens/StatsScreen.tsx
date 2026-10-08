/**
 * StatsScreen — "Your Sound" v2 (§9.7): Wrapped-grade counting from the
 * Event Ledger.
 *
 *  • the 30-second rule (industry stream definition) — skips under 30s
 *    don't count, exactly like the charts do
 *  • listening clock (streams by hour — when this listener actually listens)
 *  • day streak + skip-profile stats — proof the ledger exists
 *  • entry to Taste DNA (the transparency screen §6.6)
 *
 * Falls back to v2.1 play-count stats when the ledger is young (ladder
 * §10.4 — never emptier than before).
 */

import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import type { ListeningStats } from '../types';
import { getStats } from '../storage/store';
import { mindbeat } from '../ai/mindbeat';
import { useToast } from '../components/Toast';
import { getAppTables, type AppTables } from '../storage/appTables';
import { SESSION_MEMORY } from '../ai/core/constants';
import { computeRadarAxesKey, radarShareText, type RadarAxes } from '../ai/radar';
import { RadarChart } from '../components/RadarChart';
import type { HistoricalDay } from '../ai/core/historical';
import { shareWrappedNow } from '../share/share';
import { RewindCards, RewindEmpty, RewindUnavailable } from '../components/RewindCards';
import type { WrappedSummary } from '../ai/wrapped';
import { usePlayer } from '../player/PlayerProvider';
import { Artwork } from '../components/Artwork';
import { lookupArtistPhoto } from '../api/artists';
import { Brutal, MonoText, OutlineText } from '../components/Brutal';
import { colors, fonts } from '../theme';
import type { RootStackParamList } from './navigation';

type MindbeatStats = Awaited<ReturnType<typeof mindbeat.stats>>;

interface Merged {
  minutes: number;
  streams: number;
  songs: number;
  topArtists: Array<{ artist: string; plays: number; artwork?: string }>;
  topTracks: Array<{ track: import('../types').Track; plays: number }>;
  byHour?: number[];
  streakDays?: number;
  skipRate?: number;
  sessions?: number;
}

function fmtMinutes(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** All-zero axes = nothing streamed — the honest cold caption. */
function radarIsEmpty(axes: RadarAxes): boolean {
  return computeRadarAxesKey(axes) === '0|0|0|0|0|0';
}

function ListeningClock({ byHour }: { byHour: number[] }) {
  const max = Math.max(1, ...byHour);
  return (
    <View style={styles.clockWrap}>
      <Text style={styles.clockTitle}>Listening clock</Text>
      <Text style={styles.clockSub}>Streams by hour — 30s+ listens only</Text>
      <View style={styles.clockRow}>
        {byHour.map((n, h) => (
          <View key={h} style={styles.clockCol}>
            <View style={[styles.clockBarWrap]}>
              <View
                style={[
                  styles.clockBar,
                  { height: Math.max(3, (n / max) * 64), backgroundColor: h >= 22 || h < 5 ? colors.aiEnd : colors.accentBright },
                ]}
              />
            </View>
            {h % 6 === 0 ? <Text style={styles.clockLabel}>{h}</Text> : <View style={{ height: 12 }} />}
          </View>
        ))}
      </View>
    </View>
  );
}

export function StatsScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { playQueue } = usePlayer();
  const [stats, setStats] = useState<Merged | null>(null);
  // THE TEN F6 — the Local Rewind, tri-state: a broken ledger says
  // "unavailable", a young one says "not enough yet", and neither is
  // ever shown as a loading flash for an established listener.
  const [rewind, setRewind] = useState<
    | { state: 'loading' }
    | { state: 'empty' }
    | { state: 'unavailable' }
    | { state: 'summary'; summary: WrappedSummary }
  >({ state: 'loading' });
  // MAGNUM OPUS F8 — the Taste Radar (null = ledger unavailable; the
  // all-zero case renders the honest cold caption, never a fake shape).
  const [radar, setRadar] = useState<RadarAxes | null>(null);
  const radarRef = useRef<View | null>(null);
  const [radarSharing, setRadarSharing] = useState(false);
  // MAGNUM OPUS F9 — Time Machine (null = honest "not enough history yet").
  const [timeMachine, setTimeMachine] = useState<HistoricalDay | null | 'loading'>('loading');
  // MAGNUM OPUS F16 — the decade radio dial (busy flag while the ladder walks)
  const [decadeBusy, setDecadeBusy] = useState(false);
  const toast = useToast();
  // MAGNUM OPUS F15 — SESSION MEMORY: the last snapshots (newest first)
  const [sessions, setSessions] = useState<Awaited<ReturnType<AppTables['sessions']['list']>>>([]);
  const [resumeBusyId, setResumeBusyId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getAppTables()
      .then((t) => t.sessions.list())
      .then((rows) => {
        if (live) setSessions(rows);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    (async () => {
      // Ledger truth first (§9.7); v2.1 play counts fill the gaps.
      // Ladder rule (§10.4 — never emptier than before): a *resolved but
      // empty* ledger (fresh install / upgrade) must NOT zero out numbers
      // that legacy play counts can still provide. `??` alone can't do
      // this — 0 is not nullish — so maturity is decided explicitly.
      const [ledger, legacy] = await Promise.all([
        mindbeat.stats().catch(() => null as MindbeatStats),
        getStats().catch(() => null as ListeningStats | null),
      ]);
      const ledgerUsable = !!ledger && (ledger.streams ?? 0) > 0;
      const merged: Merged = {
        minutes: ledgerUsable
          ? (ledger!.minutes ?? 0)
          : (legacy?.minutesEstimate ?? ledger?.minutes ?? 0),
        streams: ledgerUsable
          ? (ledger!.streams ?? 0)
          : (legacy?.totalPlays ?? ledger?.streams ?? 0),
        songs: ledgerUsable
          ? (ledger!.topTracks?.length ?? 0)
          : (legacy?.distinctTracks ?? ledger?.topTracks?.length ?? 0),
        topArtists: (ledger?.topArtists?.length ? ledger.topArtists : legacy?.topArtists ?? []).map((a) => ({
          artist: a.artist,
          plays: a.plays,
          // the stored artwork is the first-PLAYED TRACK's cover, not the
          // artist's photo (v4.0.1: real photos resolve below via
          // lookupArtistPhoto; no borrowed album covers on artist rows)
          artwork: undefined as string | undefined,
        })),
        topTracks: (ledger?.topTracks?.length
          ? ledger.topTracks
          : (legacy?.topTracks ?? []).map((e) => ({ track: e.track, plays: e.count }))),
        byHour: ledgerUsable ? ledger?.byHour : undefined,
        streakDays: ledgerUsable ? ledger?.streakDays : undefined,
        skipRate: ledgerUsable ? ledger?.skipRate : undefined,
        sessions: ledgerUsable ? ledger?.sessions : undefined,
      };
      setStats(merged);
      // THE TEN F6 — the Local Rewind loads alongside (null = honest
      // cold start; a THROW = the ledger is unavailable — never conflated)
      mindbeat
        .wrapped(30)
        .then((w) => setRewind(w ? { state: 'summary', summary: w } : { state: 'empty' }))
        .catch(() => setRewind({ state: 'unavailable' }));
      // MAGNUM OPUS F8/F9 — radar + time machine load alongside (both
      // off the paint path, both honest on null)
      mindbeat
        .radarAxes()
        .then((axes) => setRadar(axes))
        .catch(() => setRadar(null));
      mindbeat
        .thisDayLastYear()
        .then((d) => setTimeMachine(d))
        .catch(() => setTimeMachine(null));
      // resolve REAL artist photos for the top rows (seed cache → live
      // lookup, cached); photo-less artists keep the initials stamp.
      merged.topArtists.slice(0, 8).forEach((a) => {
        lookupArtistPhoto(a.artist)
          .then((img) => {
            if (!img) return;
            setStats((prev) =>
              prev
                ? {
                    ...prev,
                    topArtists: prev.topArtists.map((x) =>
                      x.artist === a.artist ? { ...x, artwork: img } : x,
                    ),
                  }
                : prev,
            );
          })
          .catch(() => undefined);
      });
    })();
  }, []);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        <Brutal haptic shadow={0} pressOffset={1} onPress={() => nav.goBack()} style={styles.chevBtn}>
          <Ionicons name="chevron-back" size={16} color={colors.ink} />
        </Brutal>
        <MonoText size={9.5} bold color={colors.ink60} style={{ letterSpacing: 2 }}>
          THE 30-DAY AUDIT
        </MonoText>
        <Brutal haptic shadow={0} pressOffset={1} onPress={() => nav.navigate('Taste')} style={styles.chevBtn}>
          <Ionicons name="finger-print-outline" size={16} color={colors.ink} />
        </Brutal>
      </View>

      {!stats ? (
        <View style={styles.loadingWrap}>
          <MonoText size={10.5} bold color={colors.ink60} style={{ letterSpacing: 2 }}>
            CRUNCHING YOUR LISTENING DATA…
          </MonoText>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: 160 }} showsVerticalScrollIndicator={false}>
          {/* masthead */}
          <View style={styles.mast}>
            <View style={styles.editionRow}>
              <View style={styles.edDot} />
              <MonoText size={9.5} bold color={colors.ink60} style={{ letterSpacing: 1.8 }}>
                YOUR SOUND · FROM THE LEDGER
              </MonoText>
            </View>
            <OutlineText style={styles.mastTitle} outline={1.4}>
              The Audit
            </OutlineText>
          </View>

          {/* THE TEN F6 — the Monthly Rewind: swipeable local cards */}
          {rewind.state === 'summary' ? (
            <RewindCards summary={rewind.summary} />
          ) : rewind.state === 'empty' ? (
            <RewindEmpty />
          ) : rewind.state === 'unavailable' ? (
            <RewindUnavailable />
          ) : null}

          {/* the Your Sound audit box (the prototype's .your-sound) */}
          <View style={styles.auditBox}>
            <View style={styles.auditHead}>
              <MonoText size={10} bold color={colors.ink} style={{ letterSpacing: 2 }}>
                30-DAY WINDOW
              </MonoText>
              <MonoText size={10} bold color={colors.ink} style={{ letterSpacing: 2 }}>
                30-SECOND RULE
              </MonoText>
            </View>
            <View style={styles.auditGrid}>
              <View style={styles.auditCell}>
                <Text style={styles.auditNum}>{fmtMinutes(stats.minutes)}</Text>
                <MonoText size={8.5} bold color={colors.ink40} style={{ letterSpacing: 1.4, marginTop: 4 }}>
                  MINUTES
                </MonoText>
              </View>
              <View style={[styles.auditCell, styles.auditCellMid]}>
                <Text style={styles.auditNum}>{String(stats.streams)}</Text>
                <MonoText size={8.5} bold color={colors.ink40} style={{ letterSpacing: 1.4, marginTop: 4 }}>
                  STREAMS
                </MonoText>
              </View>
              <View style={styles.auditCell}>
                <Text style={styles.auditNum}>{String(stats.songs)}</Text>
                <MonoText size={8.5} bold color={colors.ink40} style={{ letterSpacing: 1.4, marginTop: 4 }}>
                  SONGS
                </MonoText>
              </View>
            </View>
            {stats.streakDays != null && stats.streakDays > 0 ? (
              <View style={styles.auditFoot}>
                <Ionicons name="flame" size={14} color={colors.orange} />
                <MonoText size={9.5} bold color={colors.ink60} style={{ flex: 1, letterSpacing: 0.6 }} numberOfLines={1}>
                  {`${stats.streakDays}-DAY STREAK · ${Math.round((stats.skipRate ?? 0) * 100)}% SKIP RATE${stats.sessions ? ` · ${stats.sessions} SESSIONS` : ''}`}
                </MonoText>
              </View>
            ) : null}
          </View>

          {/* MAGNUM OPUS F8 — the Taste Radar: six axes over the listener's
              own graded listens. Static render (nothing animates → the
              reduce-motion intent is honored by construction). */}
          <View style={styles.radarCard}>
            <View style={styles.radarHead}>
              <MonoText size={10} bold color={colors.ink} style={{ letterSpacing: 2 }}>
                TASTE RADAR
              </MonoText>
              {radar && !radarIsEmpty(radar) ? (
                <Pressable
                  hitSlop={8}
                  disabled={radarSharing}
                  onPress={() => {
                    if (radarSharing) return;
                    setRadarSharing(true);
                    // the EXISTING share pipeline: card capture on native,
                    // honest text fallback elsewhere/offline
                    shareWrappedNow(radarRef, radarShareText(radar))
                      .catch(() => undefined)
                      .finally(() => setRadarSharing(false));
                  }}
                >
                  <MonoText size={9} bold color={colors.ink60} style={{ letterSpacing: 1.6 }}>
                    {radarSharing ? 'SHARING…' : 'SHARE'}
                  </MonoText>
                </Pressable>
              ) : null}
            </View>
            {radar && !radarIsEmpty(radar) ? (
              <View ref={radarRef} collapsable={false}>
                <RadarChart axes={radar} />
                <MonoText size={8.5} color={colors.ink40} style={styles.radarFoot}>
                  {`ENERGY · VIBE · RANGE · FINDS · LOYALTY · ERAS — FROM ${stats.streams} COUNTED STREAMS`}
                </MonoText>
              </View>
            ) : (
              <MonoText size={10} color={colors.ink60} style={styles.radarEmpty}>
                {radar == null
                  ? 'THE LEDGER IS UNAVAILABLE — THE RADAR SITS THIS ONE OUT'
                  : 'PLAY SOME MUSIC (30 SECONDS +) AND THE RADAR TAKES SHAPE'}
              </MonoText>
            )}
          </View>

          {/* MAGNUM OPUS F15 — SESSION MEMORY: the last sessions, one tap
              to resume (≥70% your session's queued spine, ≤30% freshly
              added rows — FIX-A2: the honest claim, the spine is the
              session's queue, never claimed as proof of listening). */}
          {sessions.length > 0 ? (
            <View style={styles.tmCard} testID="session-memory-card">
              <View style={styles.tmHead}>
                <Ionicons name="bookmark-outline" size={14} color={colors.orange} />
                <MonoText size={10} bold color={colors.ink} style={{ letterSpacing: 2 }}>
                  RESUME A SESSION
                </MonoText>
              </View>
              {sessions.slice(0, SESSION_MEMORY.maxSnapshots).map((s) => (
                <Pressable
                  key={s.id}
                  testID={`resume-session-${s.id}`}
                  disabled={resumeBusyId != null}
                  onPress={() => {
                    setResumeBusyId(s.id);
                    void mindbeat
                      .resumeSession(s.id)
                      .then(async (mix) => {
                        if (!mix) {
                          toast.show({ message: 'THAT SESSION LOST ITS SPINE — CANNOT RESUME HONESTLY', icon: 'information-circle-outline' });
                        } else {
                          // v5.0.1 FIX-B4: the toast reports the RESOLVED
                          // count (rows that actually entered the engine),
                          // never the candidate count.
                          const queued = await playQueue(mix, 0);
                          if (!queued) {
                            toast.show({ message: 'COULD NOT START PLAYBACK — THE SESSION DID NOT RESOLVE', icon: 'alert-outline' });
                          } else {
                            toast.show({ message: `RESUMED · ${queued} SONGS · MOSTLY YOUR SESSION`, icon: 'play' });
                          }
                        }
                      })
                      .catch(() => toast.show({ message: 'COULD NOT RESUME — TRY AGAIN', icon: 'alert-outline' }))
                      .finally(() => setResumeBusyId(null));
                  }}
                  style={({ pressed }) => [styles.tmPlayBtn, pressed && { opacity: 0.6 }]}
                >
                  <Ionicons name="play" size={12} color={colors.ink} />
                  <MonoText size={9} bold color={colors.ink} style={{ letterSpacing: 1.2, flex: 1 }} numberOfLines={1}>
                    {resumeBusyId === s.id
                      ? 'RESUMING…'
                      : `${s.vibeLabel} · ${s.seedTrackIds.length} TRACKS · ${new Date(s.endedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}
                  </MonoText>
                </Pressable>
              ))}
            </View>
          ) : null}

          {/* MAGNUM OPUS F9 — Time Machine: this day in a prior year, from
              the compaction pass's own summary table. null renders the
              honest "not enough history yet" — never fabricated nostalgia. */}
          {timeMachine === 'loading' ? null : (
            <View style={styles.tmCard} testID="time-machine-card">
              <View style={styles.tmHead}>
                <Ionicons name="time-outline" size={14} color={colors.orange} />
                <MonoText size={10} bold color={colors.ink} style={{ letterSpacing: 2 }}>
                  TIME MACHINE
                </MonoText>
              </View>
              {timeMachine ? (
                <>
                  <Text style={styles.tmTitle}>
                    {`${new Date(timeMachine.dayStartTs).getFullYear()} · ${new Date(timeMachine.dayStartTs).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`}
                  </Text>
                  <MonoText size={9.5} color={colors.ink60} style={{ marginTop: 4, letterSpacing: 0.6 }}>
                    {`${fmtMinutes(Math.round(timeMachine.minutes))} · ${timeMachine.streams} ${timeMachine.streams === 1 ? 'STREAM' : 'STREAMS'}`}
                  </MonoText>
                  {timeMachine.topTracks.slice(0, 3).map((t) => (
                    <MonoText key={t.id} size={10} color={colors.ink} style={{ marginTop: 6 }} numberOfLines={1}>
                      {`▸ ${t.title} — ${t.artist}`}
                    </MonoText>
                  ))}
                  {/* MAGNUM OPUS F16 — DECADE RADIO: the sound of that year,
                      from the deterministic ladder + the rows' own years. */}
                  <Pressable
                    testID="decade-radio-btn"
                    accessibilityRole="button"
                    accessibilityLabel="Play the sound of that year"
                    disabled={decadeBusy}
                    onPress={() => {
                      setDecadeBusy(true);
                      void (async () => {
                        try {
                          // the kill switch is checked FRESH — a disabled
                          // brain is reported as such, never as a fake
                          // "thin catalog" (the blind critic's P2)
                          if (await mindbeat.isDisabled()) {
                            toast.show({ message: 'THE BRAIN IS SWITCHED OFF — DECADE RADIO NEEDS IT ON', icon: 'information-circle-outline' });
                            return;
                          }
                          const res = await mindbeat.decadeRadio(new Date(timeMachine.dayStartTs).getFullYear());
                          if (!res.tracks.length) {
                            toast.show({ message: `NO RADIO SURVIVED FROM ${res.ladder.exact.toUpperCase()} — TOO THIN`, icon: 'information-circle-outline' });
                          } else {
                            // v5.0.1 FIX-B4: the REAL resolved count, never
                            // the candidate count; zero-resolved is an
                            // honest "could not start", not a fake room.
                            const queued = await playQueue(res.tracks, 0);
                            if (!queued) {
                              toast.show({ message: 'COULD NOT START PLAYBACK — THE DECADE DID NOT RESOLVE', icon: 'alert-outline' });
                              return;
                            }
                            const undated = res.tracks.filter((t) => typeof t.year !== 'number' || t.year <= 0).length;
                            toast.show({
                              message: res.thin
                                ? `THE SOUND OF ${res.ladder.decadeStart}s · THIN CATALOG · ${queued} SONGS${undated ? ` · ${undated} UNDATED` : ''}`
                                : `THE SOUND OF ${res.ladder.decadeStart}s · ${queued} SONGS${undated ? ` · ${undated} UNDATED` : ''}`,
                              icon: 'disc',
                            });
                          }
                        } catch {
                          toast.show({ message: 'THE TIME MACHINE SPUTTERED — TRY AGAIN', icon: 'alert-outline' });
                        } finally {
                          setDecadeBusy(false);
                        }
                      })();
                    }}
                    style={({ pressed }) => [styles.tmPlayBtn, pressed && { opacity: 0.6 }]}
                  >
                    <Ionicons name="disc" size={13} color={colors.ink} />
                    <MonoText size={9} bold color={colors.ink} style={{ letterSpacing: 1.6 }}>
                      {decadeBusy ? 'DIALING THE DECADE…' : `PLAY THE SOUND OF ${new Date(timeMachine.dayStartTs).getFullYear()}`}
                    </MonoText>
                  </Pressable>
                </>
              ) : (
                <MonoText size={10} color={colors.ink60} style={{ marginTop: 8, letterSpacing: 0.6 }}>
                  NOT ENOUGH HISTORY YET — THIS CARD FILLS AS THE DAYS STACK UP
                </MonoText>
              )}
            </View>
          )}

          {/* Taste DNA entry — see and edit what the app believes (§6.6) */}
          <Brutal haptic shadow={3} style={styles.dnaCard} onPress={() => nav.navigate('Taste')}>
            <Ionicons name="finger-print" size={20} color={colors.orange} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.dnaTitle}>Taste DNA</Text>
              <MonoText size={9} style={{ marginTop: 2 }} numberOfLines={1}>
                See what MINDBEAT believes — and change it
              </MonoText>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.ink40} />
          </Brutal>

          {/* Top artists */}
          <View style={styles.secLabel}>
            <MonoText size={9.5} bold color={colors.ink60} style={{ letterSpacing: 2.2 }}>
              TOP ARTISTS
            </MonoText>
            <View style={styles.secRule} />
          </View>
          {stats.topArtists.length ? (
            stats.topArtists.map((a, i) => (
              <View key={a.artist} style={styles.artistRow}>
                <MonoText size={10} bold color={colors.ink40} style={styles.rank}>
                  {String(i + 1).padStart(2, '0')}
                </MonoText>
                <Artwork uri={a.artwork} seed={a.artist} size={44} initials={a.artist} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.artistName} numberOfLines={1}>
                    {a.artist.toUpperCase()}
                  </Text>
                  <MonoText size={9} style={{ marginTop: 2 }}>
                    {`${a.plays} ${a.plays === 1 ? 'STREAM' : 'STREAMS'}`}
                  </MonoText>
                </View>
                {i === 0 ? <Ionicons name="trophy" size={16} color={colors.orange} /> : null}
              </View>
            ))
          ) : (
            <MonoText size={10} color={colors.ink60} style={styles.emptyText}>
              PLAY SOME MUSIC TO BUILD YOUR TASTE PROFILE
            </MonoText>
          )}

          {/* Listening clock — the ledger's visible proof (§9.7) */}
          {stats.byHour && stats.byHour.some((n) => n > 0) ? <ListeningClock byHour={stats.byHour} /> : null}

          {/* Top tracks */}
          {stats.topTracks.length ? (
            <>
              <View style={styles.secLabel}>
                <MonoText size={9.5} bold color={colors.ink60} style={{ letterSpacing: 2.2 }}>
                  TOP SONGS
                </MonoText>
                <View style={styles.secRule} />
              </View>
              {stats.topTracks.map((e, i) => (
                <Pressable
                  key={e.track.id}
                  style={({ pressed }) => [styles.trackRow, pressed && { backgroundColor: colors.paper2 }]}
                  onPress={() => {
                    playQueue(
                      stats.topTracks.map((x) => x.track),
                      i,
                    );
                    nav.navigate('Player');
                  }}
                >
                  <MonoText size={10} bold color={colors.ink40} style={styles.rank}>
                    {String(i + 1).padStart(2, '0')}
                  </MonoText>
                  <Artwork uri={e.track.artwork} seed={e.track.id} size={44} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.trackTitle} numberOfLines={1}>
                      {e.track.title.toUpperCase()}
                    </Text>
                    <MonoText size={9} style={{ marginTop: 2 }} numberOfLines={1}>
                      {`${e.track.artist.toUpperCase()} · ${e.plays} ${e.plays === 1 ? 'STREAM' : 'STREAMS'}`}
                    </MonoText>
                  </View>
                </Pressable>
              ))}
            </>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
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
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  mast: { paddingHorizontal: 18, paddingTop: 8, paddingBottom: 16 },
  editionRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  edDot: { width: 7, height: 7, backgroundColor: colors.orange },
  mastTitle: {
    fontFamily: fonts.display,
    fontSize: 32,
    lineHeight: 34,
    textTransform: 'uppercase',
    letterSpacing: -0.2,
  },
  auditBox: {
    marginHorizontal: 18,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.paper,
    ...({ shadowColor: colors.ink, shadowOpacity: 1, shadowRadius: 0, shadowOffset: { width: 5, height: 5 }, elevation: 5 } as object),
  },
  auditHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: colors.ink,
    backgroundColor: colors.acid,
  },
  auditGrid: { flexDirection: 'row' },
  auditCell: { flex: 1, alignItems: 'center', paddingVertical: 15, paddingHorizontal: 6 },
  auditCellMid: { borderLeftWidth: 1, borderRightWidth: 1, borderColor: colors.ink16 },
  auditNum: { fontFamily: fonts.display, fontSize: 20, color: colors.ink },
  auditFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 2,
    borderTopColor: colors.ink,
  },
  dnaCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 18,
    marginTop: 18,
    marginBottom: 8,
    backgroundColor: colors.paper,
    borderWidth: 1.5,
    borderColor: colors.ink,
    padding: 14,
  },
  dnaTitle: { color: colors.ink, fontSize: 13.5, fontWeight: '700', fontFamily: fonts.bold, textTransform: 'uppercase', letterSpacing: 0.3 },
  radarCard: {
    marginHorizontal: 18,
    marginTop: 18,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.paper,
    padding: 14,
  },
  radarHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  radarFoot: { textAlign: 'center', letterSpacing: 1, marginTop: 8 },
  radarEmpty: { letterSpacing: 0.6, textAlign: 'center', paddingVertical: 12 },
  tmCard: {
    marginHorizontal: 18,
    marginTop: 14,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.paper2,
    padding: 14,
  },
  tmHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tmPlayBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 7,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.paper2,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginTop: 10,
  },
  tmTitle: {
    marginTop: 8,
    fontFamily: fonts.display,
    fontSize: 17,
    color: colors.ink,
    textTransform: 'uppercase',
  },
  secLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 18,
    paddingTop: 22,
    paddingBottom: 8,
  },
  secRule: { flex: 1, height: 2, backgroundColor: colors.ink },
  artistRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: colors.ink16,
  },
  rank: { width: 24 },
  artistName: { color: colors.ink, fontSize: 13, fontFamily: fonts.bold, textTransform: 'uppercase', letterSpacing: 0.2 },
  clockWrap: {
    margin: 18,
    marginTop: 20,
    backgroundColor: colors.paper,
    borderWidth: 1.5,
    borderColor: colors.ink,
    padding: 16,
  },
  clockTitle: { color: colors.ink, fontSize: 13.5, fontWeight: '700', fontFamily: fonts.bold, textTransform: 'uppercase', letterSpacing: 0.3 },
  clockSub: { color: colors.ink60, fontSize: 9.5, fontFamily: fonts.mono, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 3, marginBottom: 14 },
  clockRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 80 },
  clockCol: { flex: 1, alignItems: 'center' },
  clockBarWrap: { height: 64, justifyContent: 'flex-end' },
  clockBar: { width: '100%', minHeight: 3 },
  clockLabel: { color: colors.ink40, fontSize: 9, fontFamily: fonts.mono, marginTop: 3 },
  trackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: colors.ink16,
  },
  trackTitle: { color: colors.ink, fontSize: 13, fontFamily: fonts.bold, textTransform: 'uppercase', letterSpacing: 0.2 },
  emptyText: {
    paddingHorizontal: 18,
    paddingBottom: 18,
    letterSpacing: 0.6,
  },
});
