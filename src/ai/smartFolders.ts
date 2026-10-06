/**
 * SMART AUTO-PLAYLISTS (THE TEN · FEATURE 4) — live query folders over
 * the user's own listening evidence. No servers, no fake filler: every
 * folder is a PURE, deterministic predicate over (listens, favorites,
 * playCounts, recents, now) — same input ⇒ same output, always.
 *
 *   Heavy Rotation   — ≥10 clean plays in the last 14 days (rejections
 *                      are NOT plays: skip-storming can never fake it)
 *   Forgotten Gems   — hearted but not played in >90 days (evidence =
 *                      the newest of playCounts.lastAt and the ledger's
 *                      last listen for the recording)
 *   The Graveyard    — skip ratio >0.6 across ≥3 attempts, inside the
 *                      raw-event retention window (never queried beyond
 *                      what is stored)
 *   Recently Rescued — played rows whose entry arrived via a SIG rescue
 *                      rung. HONEST LIMITATION: the rescued flag rides
 *                      the queue only from v4.3.0 on — rows last played
 *                      by an older build do not carry it, so this crate
 *                      under-reports history (never over-reports).
 *
 * IDENTITY DISCIPLINE (R8-P4b-grade): ledger rows fold by TITLE BUCKET
 * with nested-credit-set collapsing (src/api/recording.ts machinery),
 * and the evidence of collapsed rows is SUMMED — so credit-REORDERED
 * re-listings ("A | X, Y" vs "A | Y, X") share one bucket and 6+4 plays
 * count as 10. Rows without BOTH title and artist never fold (a
 * title-only key would collide different songs). Rows missing both are
 * skipped: they can never render or resolve honestly.
 *
 * PLAYABILITY: ledger listens store no stream URLs, so every
 * ledger-reconstructed row is ENRICHED from the device's own full-track
 * copies (play counts → recents → favorites) before it is returned;
 * rows that stay URL-less are still playable via the by-id rescue rung
 * in PlayerProvider.buildPlayable (added for exactly this feature).
 * Every folder's output passes filterClean() + reconcileRecordings()
 * (house law ⑨). Ledger rows wear artwork '' unless enriched — the
 * Artwork component renders its honest seed placeholder.
 *
 * Everything here is a factual view of the listener's OWN data — not a
 * recommendation — so the intelligence kill switch does NOT gate it
 * (same posture as mindbeat.stats()); failures propagate to the facade,
 * which reports null (an UNAVAILABLE crate) — distinct from an honest
 * empty array.
 */

import { SMART_FOLDERS } from './core/constants';
import type { ListenRecord } from './core/types';
import type { PlayCountEntry, Track } from '../types';
import {
  creditSetOf,
  normSeg,
  primaryArtistOf,
  reconcileRecordings,
  sameCredits,
  titleKeyOf,
} from '../api/recording';
import { filterClean } from '../safety';

const DAY_MS = 86_400_000;

/** Skip grades: rejections of the track (the Graveyard's numerator). */
const SKIP_GRADES = new Set(['INSTANT_REJECT', 'EARLY_SKIP', 'MID_SKIP', 'LATE_SKIP']);
/** Rejection grades that do NOT count as "plays" for Heavy Rotation —
 *  skip-storming a track ten times must never make it "heavy rotation". */
const REJECTION_GRADES = new Set(['INSTANT_REJECT', 'EARLY_SKIP', 'MID_SKIP']);

export interface SmartFolders {
  heavyRotation: Track[];
  forgottenGems: Track[];
  graveyard: Track[];
  recentlyRescued: Track[];
}

/** The per-recording accumulator behind the ledger folders. */
interface RecAgg {
  key: string; // the title bucket (normTitle)
  primary: string; // normSeg'd primary artist of the representative row
  credits: Set<string>; // full credit set of the representative row
  playsAll: number; // every listen attempt (the Graveyard's denominator)
  playsClean: number; // non-rejection listens — skips are NOT plays
  skips: number;
  lastTs: number;
  sample: ListenRecord;
}

/**
 * One row per RECORDING, folded from the raw ledger listens:
 *   1. bucket by normTitle(title) — the performance's stable half,
 *   2. collapse rows whose credit sets are nested (re-creditings),
 *      SUMMING the evidence (unlike reconcileRecordings, which drops
 *      duplicates — correct for catalogs, evidence-destroying here),
 *   3. rows without BOTH title and artist are skipped (a title-only
 *      key would fold different songs together),
 *   4. the merge uses the SAME singleton guard as the catalog
 *      reconciler (sameCredits): a lone credit that is only a SECONDARY
 *      credit of the other row is a DIFFERENT recording — "Kar Gayi
 *      Chull | Badshah" never folds into "… | Fazilpuria, Badshah".
 *      HONEST LIMITATION (inherited from recording.ts): the
 *      lyricist/composer-first fuller-credit re-list still splits its
 *      evidence — the ledger stores no play counters for the countTwins
 *      escape, so those pairs fold only when their credit sets nest
 *      under the guard.
 */
function foldByRecording(listens: ListenRecord[]): RecAgg[] {
  const buckets = new Map<string, RecAgg[]>();
  for (const l of listens) {
    if (!l.title || !l.artist) continue; // identity needs both halves
    const key = titleKeyOf({ title: l.title });
    if (!key) continue;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    const credits = creditSetOf(l);
    const primary = normSeg(primaryArtistOf(l));
    let merged: RecAgg | null = null;
    for (const agg of bucket) {
      if (sameCredits(agg.credits, credits, agg.primary, primary)) {
        merged = agg;
        break;
      }
    }
    if (!merged) {
      merged = { key, primary, credits, playsAll: 0, playsClean: 0, skips: 0, lastTs: 0, sample: l };
      bucket.push(merged);
    }
    merged.playsAll += 1;
    if (!REJECTION_GRADES.has(l.grade)) merged.playsClean += 1;
    if (SKIP_GRADES.has(l.grade)) merged.skips += 1;
    if (l.startedTs > merged.lastTs) merged.lastTs = l.startedTs;
    // the representative row is the earliest-seen sample (listens arrive
    // time-ordered) — deterministic, never re-keyed by fold order
  }
  const out: RecAgg[] = [];
  for (const bucket of buckets.values()) out.push(...bucket);
  return out;
}

/** Ledger listen → playable Track (the same reconstruction mindbeat.stats()
 *  uses; the ledger stores no artwork, so the row wears its seed tile). */
function listenToTrack(l: ListenRecord): Track {
  return {
    id: l.trackId,
    title: l.title ?? 'Unknown',
    artist: l.artist,
    artwork: '',
    duration: Math.round(l.durationMs / 1000),
    source: 'saavn',
    previewOnly: false,
  };
}

/**
 * Fill the URL-less ledger row from the device's OWN full-track copies
 * (play counts → recents → favorites). Only display/stream fields are
 * copied; the identity (id/title/artist) stays the ledger's. Pure.
 */
function enrichFromLocal(
  base: Track,
  fullTracks: Track[],
): Track {
  const byId = fullTracks.find((t) => t.id === base.id);
  if (!byId) return base;
  return {
    ...base,
    ...(byId.artwork ? { artwork: byId.artwork } : {}),
    ...(byId.album ? { album: byId.album } : {}),
    ...(byId.saavnId ? { saavnId: byId.saavnId } : {}),
    ...(byId.encryptedUrl ? { encryptedUrl: byId.encryptedUrl } : {}),
    ...(byId.previewUrl ? { previewUrl: byId.previewUrl } : {}),
    ...(byId.has320 !== undefined ? { has320: byId.has320 } : {}),
    ...(byId.explicit !== undefined ? { explicit: byId.explicit } : {}),
  };
}

/**
 * HEAVY ROTATION — recordings with ≥ SMART_FOLDERS.heavyMinPlays CLEAN
 * plays inside the last heavyWindowDays days. Sorted by plays desc,
 * then title asc (deterministic).
 */
export function heavyRotation(listens: ListenRecord[], fullTracks: Track[], now: number): Track[] {
  const floorTs = now - SMART_FOLDERS.heavyWindowDays * DAY_MS;
  const recent = listens.filter((l) => l.startedTs >= floorTs);
  const out: Track[] = [];
  for (const agg of foldByRecording(recent)) {
    if (agg.playsClean < SMART_FOLDERS.heavyMinPlays) continue;
    const t = enrichFromLocal(listenToTrack(agg.sample), fullTracks);
    t.playCount = agg.playsClean;
    out.push(t);
  }
  out.sort((a, b) => (b.playCount ?? 0) - (a.playCount ?? 0) || a.title.localeCompare(b.title));
  return reconcileRecordings(filterClean(out));
}

/**
 * THE GRAVEYARD — recordings with skip ratio > graveyardSkipRatio across
 * ≥ graveyardMinPlays attempts (the honest denominator), inside the
 * retention window. Sorted worst-first. Surfaced, never auto-removed.
 */
export function theGraveyard(listens: ListenRecord[], fullTracks: Track[], now: number): Track[] {
  const floorTs = now - SMART_FOLDERS.graveyardWindowDays * DAY_MS;
  const recent = listens.filter((l) => l.startedTs >= floorTs);
  const out: Track[] = [];
  for (const agg of foldByRecording(recent)) {
    if (agg.playsAll < SMART_FOLDERS.graveyardMinPlays) continue;
    const ratio = agg.skips / agg.playsAll;
    if (ratio <= SMART_FOLDERS.graveyardSkipRatio) continue;
    const t = enrichFromLocal(listenToTrack(agg.sample), fullTracks);
    t.playCount = agg.playsAll;
    out.push(t);
  }
  out.sort((a, b) => (b.playCount ?? 0) - (a.playCount ?? 0) || a.title.localeCompare(b.title));
  return reconcileRecordings(filterClean(out));
}

/**
 * FORGOTTEN GEMS — hearted tracks whose last play is older than
 * forgottenDays. Evidence = the NEWEST of (playCounts.lastAt for the
 * exact row, the ledger's last listen for the recording) — either
 * source alone lies (id-keyed counts split re-listings; the ledger
 * only remembers 90 days). A heart with NO play evidence at all is NOT
 * "forgotten" (no honest timestamp — it may have been hearted today).
 * Stalest first.
 */
export function forgottenGems(
  favorites: Track[],
  playCounts: Record<string, PlayCountEntry>,
  listens: ListenRecord[],
  now: number,
): Track[] {
  const cutoff = now - SMART_FOLDERS.forgottenDays * DAY_MS;
  const fold = foldByRecording(listens);
  const lastLedgerTsFor = (t: Track): number => {
    const key = titleKeyOf({ title: t.title });
    const credits = creditSetOf(t);
    const primary = normSeg(primaryArtistOf(t));
    for (const agg of fold) {
      if (agg.key === key && sameCredits(agg.credits, credits, agg.primary, primary)) {
        return agg.lastTs;
      }
    }
    return 0;
  };
  const out: Track[] = [];
  for (const f of favorites) {
    const lastAt = playCounts[f.id]?.lastAt ?? 0;
    const lastLedger = lastLedgerTsFor(f);
    const lastPlayed = Math.max(lastAt, lastLedger);
    if (lastPlayed <= 0) continue; // no honest play evidence — unexplored, not forgotten
    if (lastPlayed >= cutoff) continue; // played recently — not forgotten
    out.push(f);
  }
  out.sort((a, b) => {
    const la = Math.max(playCounts[a.id]?.lastAt ?? 0, lastLedgerTsFor(a));
    const lb = Math.max(playCounts[b.id]?.lastAt ?? 0, lastLedgerTsFor(b));
    return la - lb;
  });
  return reconcileRecordings(filterClean(out));
}

/**
 * RECENTLY RESCUED — played rows whose entry arrived through a SIG
 * rescue rung. Order = most recent play first (recents is
 * most-recent-first; its order is kept). See the header for the honest
 * pre-v4.3.0 blind spot.
 */
export function recentlyRescued(recents: Track[]): Track[] {
  return filterClean(recents.filter((t) => t.rescued === true));
}

/** The facade bundle (mindbeat.smartFolders) — THROWS on failure so the
 *  facade can report a distinct "unavailable" (null) vs honest empty. */
export function buildSmartFolders(input: {
  listens: ListenRecord[];
  favorites: Track[];
  playCounts: Record<string, PlayCountEntry>;
  recents: Track[];
  now: number;
}): SmartFolders {
  // The device's own full-track copies — the enrichment pool (no network).
  const fullTracks = [...input.recents, ...Object.values(input.playCounts).map((e) => e.track), ...input.favorites];
  return {
    heavyRotation: heavyRotation(input.listens, fullTracks, input.now),
    forgottenGems: forgottenGems(input.favorites, input.playCounts, input.listens, input.now),
    graveyard: theGraveyard(input.listens, fullTracks, input.now),
    recentlyRescued: recentlyRescued(input.recents),
  };
}
