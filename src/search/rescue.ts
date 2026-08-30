/**
 * SEARCH V2 · SIG RESCUE (SEARCH-INTENT-RESCUE-PLAN §3.5, M3/M4).
 *
 * When a specific-intent query (song + artist) produced no row matching
 * BOTH axes, the engine must escalate instead of painting confidently
 * wrong results. Rungs, first hit wins:
 *
 *   R0 youtube  — full-length playback, the user's priority over 30 s
 *                 previews; dual-verified + stream-resolvable
 *   R1 itunes   — 30 s preview fallback (truthfully labelled)
 *   R3 variants — re-probe JioSaavn with orthographic spellings
 *                 ("tu chaiye" → "tu chahiye") for the reachable-miss
 *                 class
 *   R2 album    — search the album route for the exists-but-not-in-song-
 *                 search catalog class (full length)
 *
 * All providers are INJECTED — the engine orchestrator passes its real
 * implementations, tests pass fixtures. No rung ever throws; failures
 * degrade to "no row", which the orchestrator turns into an honest
 * S-PARTIAL / S-ZERO state.
 */

import type { Track } from '../types';
import type { SearchPlan } from './plan';
import { artistContains } from './rank';
import { titleQueryTokens, acceptableTitleTokens, titleHitCount } from './rank';
import { normalizeQuery } from './normalize';
import { searchSaavn } from '../api/saavn';
import { searchItunes } from '../api/itunes';
import { ytSearchMusic, ytResolveStream, ytAvailable, type ResolveOutcome } from '../api/youtube';
import { searchAlbumResults, getAlbumTracks } from '../api/saavn';

export type RescueRung = 'youtube' | 'itunes' | 'variant' | 'album';

/** AUTHORITY FLOOR — the popularity a "the" recording leaves behind.
 *  When a famous song is missing from a catalog, what remains in its
 *  place is covers/remakes in the hundreds-of-plays tier (live-probed
 *  "tu chaiye": every JioSaavn row ≤ 198k, the real song has 100M+).
 *  Rows at/above this floor are treated as the canonical release; rows
 *  below it as same-name noise. */
export const AUTHORITY_FLOOR = 250_000;

/** TITLE-ONLY AUTHORITY GAP — the class the "tu chaiye" (no artist
 *  typed) complaint lives in: the plan has NO artistTokens so the
 *  artist_title SIG gate never fires, yet every title-matching row the
 *  provider returned is deep-niche. The famous recording the user means
 *  is almost certainly absent from the catalog → escalate once via the
 *  rescue ladder instead of confidently painting covers.
 *  Requires ≥1 genuinely title-matching row (queries with NO title
 *  match belong to the honest-zero/recovery path, not this one). */
export function titleAuthorityMissing(
  rows: Array<{ playCount?: number; queryMatch?: number }>,
): boolean {
  const matching = rows.filter((r) => (r.queryMatch ?? 0) >= 0.5);
  if (matching.length === 0) return false;
  return matching.slice(0, 6).every((r) => (r.playCount ?? 0) < AUTHORITY_FLOOR);
}

/** Does THIS row carry enough weight to be the rescue answer? For
 *  artist_title plans the artist axis already proves identity (unchanged
 *  from the shipped, device-verified path). Title-only plans have no
 *  artist axis — the rescue row must ITSELF be the popular canonical
 *  recording, or we'd rescue one obscure cover with another. iTunes is
 *  exempt: the official store carries no play metric, and its ranking
 *  + dual title verification is the identity signal there. YT Music
 *  song-kind rows ALSO never carry a view metric (only video rows do),
 *  so an UNKNOWN metric is allowed for youtube rows — bestFirst()
 *  ordering + remix demotion rank them — while a KNOWN-SMALL metric
 *  (< floor) is a hard reject. JioSaavn routes (variant/album) report
 *  play counts reliably, so they need the floor for real. */
function rescueRowAuthoritative(plan: SearchPlan, t: Track): boolean {
  if (plan.artistTokens.length > 0) return true;
  if (t.source === 'itunes') return true;
  if (t.source === 'youtube') return t.playCount === undefined || t.playCount >= AUTHORITY_FLOOR;
  return (t.playCount ?? 0) >= AUTHORITY_FLOOR;
}

export interface RescueDeps {
  disabled?: () => boolean;
  signal?: AbortSignal;
  /** deadline for the WHOLE ladder (ms epoch) — rungs check before firing */
  deadline?: number;
}

export interface RescueOutcome {
  tracks: Track[];
  rung?: RescueRung;
  /** which rungs were attempted (for the ledger + honest-zero copy) */
  attempted: RescueRung[];
}

/** SIG M3 — is the specific intent still unmet after the first rank? */
export function sigUnmet(plan: SearchPlan, rows: Array<{ artistMatch: number; queryMatch: number }>): boolean {
  if (plan.kind !== 'artist_title' || plan.artistTokens.length === 0) return false;
  if (rows.length === 0) return true;
  return !rows.some((r) => r.artistMatch >= 1 && r.queryMatch >= 0.5);
}

/** Dual-axis verification for rescue rows (the rescue row must be the
 *  song the user asked for — same bar as a native S-HIT row). Title
 *  side is ortho-aware: the plan's variants ("chaiye"→"chahiye") count
 *  as the same token, so the correctly-spelled canonical recording
 *  verifies at full strength instead of 0.5. */
export function verifyRescueRow(plan: SearchPlan, track: Track): boolean {
  if (!plan.artistTokens.length) {
    const orig = titleQueryTokens(plan);
    if (orig.length === 0) return true;
    const hay = new Set(
      normalizeQuery(track.title)
        .split(/[^a-z0-9\u0900-\u097f]+/)
        .filter(Boolean),
    );
    const hits = titleHitCount(orig, acceptableTitleTokens(plan), hay);
    return hits / orig.length >= 0.5;
  }
  const orig = titleQueryTokens(plan);
  const hay = new Set(
    normalizeQuery(track.title)
      .split(/[^a-z0-9\u0900-\u097f]+/)
      .filter(Boolean),
  );
  const hits = titleHitCount(orig, acceptableTitleTokens(plan), hay);
  const titleOk = orig.length > 0 && hits / orig.length >= 0.5;
  const credits = track.artistsFull?.length ? track.artistsFull : track.artist.split(/,\s*/);
  const artistOk = plan.artistTokens.some((a) =>
    credits.some((c) => artistContains(normalizeQuery(c), a)),
  );
  return titleOk && artistOk;
}

function within(deadline: number | undefined): boolean {
  return deadline === undefined || Date.now() < deadline;
}

function mark(track: Track, rung: RescueRung): Track {
  return { ...track, rescued: true, rescueRung: rung };
}

const RUNG_PICK_DEMOTIONS =
  /\b(slowed|reverb|lofi|lo-fi|remix|nightcore|8d|bass ?boosted|sped ?up|unplugged|cover|karaoke|instrumental|tribute|reaction|lofi mix)\b/i;

/** Deterministic best-first order for candidate rescue rows:
 *  1. demote edit-class junk whose TITLE admits it (Slowed+Reverb, Lo-Fi
 *     Mix, Unplugged Cover, REMIX…) — these routinely carry HUGE view
 *     counts and must never be the canonical answer
 *  2. song-kind rows (the OFFICIAL YT Music catalog entry) before video
 *     rows (UGC lyric-video uploads) — a 6.2M-view lyric video must not
 *     displace the catalog recording of the same song
 *  3. popularity desc (YT video rows carry views; song rows don't)
 *  4. provider order (stable) — YT Music lists the official catalog
 *     songs first, which is the right tiebreak for metric-less rows
 *  (Sort is stable per spec — equal keys keep YT's own ranking.) */
function bestFirst(rows: Track[]): Track[] {
  return [...rows].sort(
    (a, b) =>
      Number(RUNG_PICK_DEMOTIONS.test(a.title)) - Number(RUNG_PICK_DEMOTIONS.test(b.title)) ||
      Number(a.ytKind === 'video' ? 1 : 0) - Number(b.ytKind === 'video' ? 1 : 0) ||
      (b.playCount ?? 0) - (a.playCount ?? 0),
  );
}

/** R0 — YouTube full-length: search → verify → resolve stream. */
async function rungYoutube(plan: SearchPlan, deps: RescueDeps): Promise<Track[]> {
  if (!ytAvailable() || !within(deps.deadline)) return [];
  const q = `${plan.titleTokens.join(' ')} ${plan.artistTokens.join(' ')}`.trim();
  if (!q) return [];
  const res = await ytSearchMusic(q, 10, deps.signal).catch(() => ({ tracks: [] as Track[] }));
  const verified = bestFirst(
    (res.tracks ?? []).filter(
      (t) => verifyRescueRow(plan, t) && rescueRowAuthoritative(plan, t),
    ),
  );
  if (verified.length === 0) return [];
  // resolve the best row's stream — an unrescuable row helps nobody.
  // P1-2: a systemic verdict (bot-walled / kill-switched) is remembered:
  // painting a "full song, ad-free" row we just failed to resolve THREE
  // times on this network is a lie, and it would also cost the iTunes
  // rung its chance at a playable 30 s preview.
  let systemic = false;
  for (const t of verified.slice(0, 3)) {
    const out = await ytResolveStream(String(t.youtubeId), deps.signal).catch(
      () => ({ ok: false, reason: 'network' } as ResolveOutcome),
    );
    if (out.ok && out.audio?.url) {
      return [{ ...t, streamUrl: out.audio.url } as Track & { streamUrl: string }].map((x) => mark(x, 'youtube'));
    }
    if (out.reason === 'bot-walled' || out.reason === 'disabled') systemic = true;
  }
  // TITLE-ONLY FALLBACK: playback extraction can be transiently flaky
  // while search + the authority signal are healthy. A verified +
  // authoritative title-only row without a pre-resolved URL still lets
  // the player resolve at tap time (PlayerProvider YT branch + service
  // refresh) — but ONLY when the ladder didn't just hit a systemic wall
  // on this network (P1-2: otherwise fall through to iTunes). Artist
  // plans keep the shipped strict behavior: no stream, no row.
  if (plan.artistTokens.length === 0 && !systemic) {
    return verified.slice(0, 1).map((t) => mark(t, 'youtube'));
  }
  return [];
}

/** R1 — iTunes preview: search → verify. */
async function rungItunes(plan: SearchPlan, deps: RescueDeps): Promise<Track[]> {
  if (!within(deps.deadline)) return [];
  const q = `${plan.titleTokens.join(' ')} ${plan.artistTokens.join(' ')}`.trim();
  if (!q) return [];
  const rows = await searchItunes(q, 10, deps.signal).catch(() => [] as Track[]);
  return rows.filter((t) => verifyRescueRow(plan, t)).map((t) => mark(t, 'itunes'));
}

/** R3 — variant spellings against JioSaavn (the reachable-miss class). */
async function rungVariant(plan: SearchPlan, deps: RescueDeps): Promise<Track[]> {
  if (!within(deps.deadline)) return [];
  const variants = plan.variants.length > 0 ? plan.variants : [];
  for (const v of variants.slice(0, 2)) {
    const q = plan.artistTokens.length ? `${v} ${plan.artistTokens.join(' ')}` : v;
    const rows = await searchSaavn(q, 15, deps.signal).catch(() => [] as Track[]);
    const verified = rows.filter(
      (t) => verifyRescueRow(plan, t) && rescueRowAuthoritative(plan, t),
    );
    if (verified.length > 0) return verified.map((t) => mark(t, 'variant'));
  }
  return [];
}

/** R2 — album route (full length; exists-but-not-in-song-search class). */
async function rungAlbum(plan: SearchPlan, deps: RescueDeps): Promise<Track[]> {
  if (!within(deps.deadline)) return [];
  const q = plan.artistTokens.length ? plan.artistTokens.join(' ') : plan.titleTokens.join(' ');
  const albums = await searchAlbumResults(q, 3, deps.signal).catch(() => []);
  for (const alb of albums.slice(0, 3)) {
    if (!within(deps.deadline)) break;
    const tracks = await getAlbumTracks(alb.id).catch(() => [] as Track[]);
    const verified = tracks.filter(
      (t) => verifyRescueRow(plan, t) && rescueRowAuthoritative(plan, t),
    );
    if (verified.length > 0) return verified.map((t) => mark(t, 'album'));
  }
  return [];
}

const RUNGS: Array<{ rung: RescueRung; fire: (plan: SearchPlan, deps: RescueDeps) => Promise<Track[]> }> = [
  { rung: 'youtube', fire: rungYoutube },
  { rung: 'itunes', fire: rungItunes },
  { rung: 'variant', fire: rungVariant },
  { rung: 'album', fire: rungAlbum },
];

/**
 * Run the ladder. First rung producing ≥1 verified row wins. Never
 * throws; never runs past `deadline` (default: 3 s from call).
 */
export async function runRescueLadder(plan: SearchPlan, deps: RescueDeps = {}): Promise<RescueOutcome> {
  const deadline = deps.deadline ?? Date.now() + 3000;
  const attempted: RescueRung[] = [];
  for (const { rung, fire } of RUNGS) {
    if (deps.signal?.aborted || !within(deadline)) break;
    attempted.push(rung);
    try {
      const tracks = await fire(plan, { ...deps, deadline });
      if (tracks.length > 0) return { tracks, rung, attempted };
    } catch {
      /* rung failure = no row; the ladder keeps climbing */
    }
  }
  return { tracks: [], attempted };
}
