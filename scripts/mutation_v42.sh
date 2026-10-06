#!/usr/bin/env bash
# BAR 4.3 — MUTATION TESTING HARNESS
# Each mutation actively breaks one fix; the targeted lock file MUST fail.
# A surviving mutation = theatre test = FAIL the gauntlet.
set -u
cd "$(dirname "$0")/.."

PASS=0; FAIL=0
run_mutation () {
  local name="$1" file="$2" sed_expr="$3" testfile="$4"
  cp "$file" "$file.bak"
  sed -i "$sed_expr" "$file"
  if bun test "$testfile" > /tmp/mut_out.txt 2>&1; then
    echo "  [SURVIVED - THEATRE] $name"
    FAIL=$((FAIL+1))
  else
    local caught
    caught=$(grep -c "(fail)" /tmp/mut_out.txt || true)
    echo "  [CAUGHT ×$caught] $name"
    PASS=$((PASS+1))
  fi
  mv "$file.bak" "$file"
}

echo "── BAR 4.3 mutation testing ──"

run_mutation "bandit veto threshold 0.75 → 0.99 (veto never fires)" \
  src/ai/core/constants.ts 's/vetoRejectRate: 0.75/vetoRejectRate: 0.99/' \
  tests/ai/bandit_veto_locks.test.ts

run_mutation "veto evidence floor 6 → 99 (thin-evidence rejects pass)" \
  src/ai/core/constants.ts 's/vetoMinEvidence: 6.0/vetoMinEvidence: 99.0/' \
  tests/ai/bandit_veto_locks.test.ts

run_mutation "onboarding seed α=3 → α=1 (Day-1 boost dead)" \
  src/ai/core/constants.ts 's/seedAlpha: 3.0/seedAlpha: 1.0/' \
  tests/ai/bandit_veto_locks.test.ts

run_mutation "feed generator ignored (legacy ladder always)" \
  src/api/feed.ts 's/const dyn = this.songQueryGenerator();/const dyn = [];/' \
  tests/ai/feed_query_locks.test.ts

run_mutation "search vibe bonus zeroed (aligner dead)" \
  src/search/rank.ts 's/if (alignment > 0) vibeBonus = ctx.sessionVibe.maxBonus \* alignment;/if (false) vibeBonus = 0;/' \
  tests/ai/search_vibe_locks.test.ts

run_mutation "lyric valence clamp widened 0.25 → 0.9" \
  src/ai/core/constants.ts 's/maxDelta: 0.25/maxDelta: 0.9/' \
  tests/ai/lyric_mood_locks.test.ts

run_mutation "chorus dedup removed (repeats triple-count)" \
  src/ai/core/lyricMood.ts 's/if (seen.has(key)) continue; \/\/ chorus repeat — counts once/if (false) continue;/' \
  tests/ai/lyric_mood_locks.test.ts

run_mutation "calibration cap removed (ground truth overridable)" \
  src/ai/core/features.ts 's/if (groundTruth) {/if (false) {/' \
  tests/ai/baked_features_locks.test.ts

run_mutation "soundAlike skips reconcileRecordings (BAR 1.4)" \
  src/ai/mindbeat.ts 's/filterClean(reconcileRecordings(pool))/filterClean(pool)/' \
  tests/ai/similarity_locks.test.ts

run_mutation "sound-alike shared-dims gate 2 → 0 (anything ranks)" \
  src/ai/core/constants.ts 's/minSharedTags: 2/minSharedTags: 0/' \
  tests/ai/similarity_locks.test.ts

run_mutation "per-artist cap 2 → 99 (clones flood the list)" \
  src/ai/core/constants.ts 's/perArtistCap: 2/perArtistCap: 99/' \
  tests/ai/similarity_locks.test.ts

run_mutation "genre capture weight zeroed (Phase 1 dead)" \
  src/ai/core/constants.ts 's/export const CAPTURED_GENRE_WEIGHT = ONBOARDING.genreSeedWeight \* 0.5;/export const CAPTURED_GENRE_WEIGHT = 0;/' \
  tests/ai/genre_capture_locks.test.ts

run_mutation "flow decision weight zeroed (follower no longer lifted)" \
  src/ai/core/constants.ts 's/flowNext: 0.4/flowNext: 0/' \
  tests/ai/flow_locks.test.ts

run_mutation "FLOW_NEXT median truth condition weakened to >0" \
  src/ai/core/decision.ts "s/if (w > median) return 'FLOW_NEXT';/if (w > 0) return 'FLOW_NEXT';/" \
  tests/ai/flow_locks.test.ts

run_mutation "feature table cluster rung dead (decorated titles miss)" \
  src/ai/core/featureTable.ts 's/if (clustered \&\& clustered !== bare) {/if (false) {/' \
  tests/ai/baked_features_locks.test.ts

# ── THE TEN · WAVE 1 (the playback engine) ──────────────────────────────

run_mutation "W1: smart volume clamp removed (extrapolation escapes [0.8,1.05])" \
  src/player/smartVolume.ts 's/return Math.max(min, Math.min(max, m));/return m;/' \
  tests/ai/wave1_playback_locks.test.ts

run_mutation "W1: composeVolume overwrites instead of multiplying (the race)" \
  src/player/volumeBus.ts 's/const v = m \* f;/const v = Math.max(m, f);/' \
  tests/ai/wave1_playback_locks.test.ts

run_mutation "W1: crossfade fadeSeconds>0 guard removed (0 = always fading)" \
  src/player/crossfade.ts "s/if (!(fadeSeconds > 0) || !(durationSec > 0)) return 1.0;/if (false) return 1.0;/" \
  tests/ai/wave1_playback_locks.test.ts

run_mutation "W1: rate snapping removed (raw value applied)" \
  src/player/playbackRate.ts 's/let bestDist = Infinity;/let bestDist = -Infinity;/' \
  tests/ai/wave1_playback_locks.test.ts

# ── THE TEN · WAVE 2 (library & data) ───────────────────────────────────

run_mutation "W2: heavy-rotation floor 10 → 1 (any listen qualifies)" \
  src/ai/core/constants.ts 's/heavyMinPlays: 10/heavyMinPlays: 1/' \
  tests/ai/wave2_library_locks.test.ts

run_mutation "W2: graveyard ratio 0.6 → 0.05 (nearly anything buries)" \
  src/ai/core/constants.ts 's/graveyardSkipRatio: 0.6/graveyardSkipRatio: 0.05/' \
  tests/ai/wave2_library_locks.test.ts

run_mutation "W2: forgotten-gems evidence gate removed (unplayed = forgotten)" \
  src/ai/smartFolders.ts "s/if (lastPlayed <= 0) continue;/if (false) continue;/" \
  tests/ai/wave2_library_locks.test.ts

run_mutation "W2: credit merge unguarded (every same-title row folds — Chull pair merges)" \
  src/ai/smartFolders.ts "s/if (sameCredits(agg.credits, credits, agg.primary, primary)) {/if (true) {/" \
  tests/ai/wave2_library_locks.test.ts

run_mutation "W2: ledger-row enrichment removed (crates stop being playable)" \
  src/ai/smartFolders.ts "s/enrichFromLocal(listenToTrack(agg.sample), fullTracks)/listenToTrack(agg.sample)/g" \
  tests/ai/wave2_library_locks.test.ts

run_mutation "W2: override key degraded to track.id (re-listings unlinked)" \
  src/storage/metaOverrides.ts 's/return recordingKey(track);/return track.id;/' \
  tests/ai/wave2_library_locks.test.ts

run_mutation "W2: forgotten-gems matcher unguarded (same-titled song un-forgets)" \
  src/ai/smartFolders.ts "s/if (agg.key === key && sameCredits(agg.credits, credits, agg.primary, primary)) {/if (agg.key === key) {/" \
  tests/ai/wave2_library_locks.test.ts

# ── THE TEN · WAVE 3 (intelligence & social) ────────────────────────────

run_mutation "W3: midnight window widened to 0-6 (4am listens smuggled in)" \
  src/ai/core/constants.ts 's/midnightToHour: 4/midnightToHour: 6/' \
  tests/ai/wave3_wrapped_dna_locks.test.ts

run_mutation "W3: midnight window start shifted (00:xx listens silently dropped)" \
  src/ai/core/constants.ts 's/midnightFromHour: 0/midnightFromHour: 2/' \
  tests/ai/wave3_wrapped_dna_locks.test.ts

run_mutation "W3: stream floor removed (2 streams dressed up as a rewind)" \
  src/ai/core/constants.ts 's/minStreams: 10/minStreams: 0/' \
  tests/ai/wave3_wrapped_dna_locks.test.ts

run_mutation "W3: aura split 0.5 → 0.99 (everything becomes DEEP_FOG)" \
  src/ai/core/constants.ts 's/auraSplit: 0.5/auraSplit: 0.99/' \
  tests/ai/wave3_wrapped_dna_locks.test.ts

run_mutation "W3: base64url alphabet corrupted ('-' dropped from the table)" \
  src/ai/tasteDna.ts "s/0123456789-_'/0123456789_'/" \
  tests/ai/wave3_wrapped_dna_locks.test.ts

run_mutation "W3: blend intersection broken (shared misses the overlap)" \
  src/ai/tasteDna.ts 's/if (b) shared.push/if (false) shared.push/' \
  tests/ai/wave3_wrapped_dna_locks.test.ts

# ── THE TEN · WAVE 4 (immersion) ────────────────────────────────────────

run_mutation "W4: kinetic line height drifts (the scroll contract breaks)" \
  src/player/singalong.ts "s/lineHeight: KINETIC.lineHeight,/lineHeight: active ? KINETIC.lineHeight : 30,/" \
  tests/ai/wave4_immersion_locks.test.ts

run_mutation "W4: aura mapping inverted (calm songs pulse fastest)" \
  src/theme/aura.ts "s/pulseMs: Math.round(AURA.slowPulseMs - e \* span),/pulseMs: Math.round(AURA.fastPulseMs + e * span),/" \
  tests/ai/wave4_immersion_locks.test.ts

run_mutation "W4: focus fade ramp removed (volume cuts, never fades)" \
  src/player/focus.ts 's/return Math.max(0, Math.min(1, remainingMs \/ FOCUS.fadeMs));/return 0;/' \
  tests/ai/wave4_immersion_locks.test.ts

run_mutation "W4: focus fade stops updating the bus (factor stuck at arm)" \
  src/player/focus.ts 's/setFadeFactor(.focus., focusFadeFactor(remaining));/setFadeFactor(\x27focus\x27, 1);/' \
  tests/ai/wave4_immersion_locks.test.ts

run_mutation "W4: SingAlong scroll height drifts from KINETIC (component side)" \
  src/player/singalong.ts 's/activeIdx \* KINETIC.lineHeight/activeIdx * 31/' \
  tests/ai/wave4_immersion_locks.test.ts

run_mutation "W4: reduce-motion freeze deleted (the aura never freezes)" \
  src/components/AuraVisualizer.tsx "s/if (mode === 'frozen') {/if (false) {/" \
  tests/ai/wave4_immersion_locks.test.ts

run_mutation "W2: by-id rescue rung killed (ledger crates stop playing)" \
  src/player/saavnRescue.ts 's/const fresh = await fetchById(rawId).catch(() => null);/const fresh = null;/' \
  tests/ai/wave2_library_locks.test.ts

echo "──"
echo "mutations caught: $PASS / $((PASS+FAIL))"
if [ "$FAIL" -gt 0 ]; then
  echo "GAUNTLET FAIL — $FAIL surviving mutation(s): the tests are theatre."
  exit 1
fi
echo "GAUNTLET GREEN — every mutation caught. No theatre."
exit 0
