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

echo "──"
echo "mutations caught: $PASS / $((PASS+FAIL))"
if [ "$FAIL" -gt 0 ]; then
  echo "GAUNTLET FAIL — $FAIL surviving mutation(s): the tests are theatre."
  exit 1
fi
echo "GAUNTLET GREEN — every mutation caught. No theatre."
exit 0
