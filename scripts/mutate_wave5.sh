#!/usr/bin/env bash
# MAGNUM OPUS WAVE 5 — MUTATION TESTING HARNESS (bar X3: ≥2 per feature)
# Each mutation actively breaks one safety/boundary behavior of F18/F19/F20;
# the targeted lock file MUST fail. A surviving mutation = theatre = FAIL.
# Every mutation is reverted byte-exact (cp/mv) and `git status` is proven
# clean at the end.
set -u
cd "$(dirname "$0")/.."

PASS=0; FAIL=0
declare -A HASHES
snapshot () { HASHES[$1]=$(sha256sum "$1" | cut -d' ' -f1); }
snapshot src/ai/concert.ts
snapshot src/ai/core/constants.ts
snapshot src/ai/genreExplorer.ts
snapshot src/storage/memoryTags.ts
snapshot src/storage/appTables.ts

run_mutation () {
  local name="$1" file="$2" sed_expr="$3" testfile="$4"
  cp "$file" "$file.bak"
  sed -i "$sed_expr" "$file"
  if bun test "$testfile" > /tmp/mut_out_w5.txt 2>&1; then
    echo "  [SURVIVED - THEATRE] $name"
    FAIL=$((FAIL+1))
  else
    local caught
    caught=$(grep -c "(fail)" /tmp/mut_out_w5.txt || true)
    echo "  [RED ×$caught] $name"
    PASS=$((PASS+1))
  fi
  mv "$file.bak" "$file"
}

echo "── WAVE 5 mutations: F18 concert ──"

# 1. the handle-poisoned-payload gate is deleted (safety call removed)
run_mutation "F18: decoder accepts streamUrl-poisoned payloads (strip gate dead)" \
  src/ai/concert.ts "s/if ('streamUrl' in t) return null; \/\/ a forged/if (false) return null; \/\/ a forged/" \
  tests/wave5_concert_locks.test.ts

# 2. the version gate is flipped (accepts the NEXT version instead of ours)
run_mutation "F18: version gate flipped (+1) — foreign codecs fake-comprehended" \
  src/ai/concert.ts "s/if (p\.v !== CONCERT\.version) return null;/if (p.v !== CONCERT.version + 1) return null;/" \
  tests/wave5_concert_locks.test.ts

# 3. the 50-row cap bound is loosened
run_mutation "F18: maxTracks bound loosened (+10) — oversized rooms pass" \
  src/ai/concert.ts "s/if (tracks\.length >= CONCERT\.maxTracks) break;/if (tracks.length >= CONCERT.maxTracks + 10) break;/" \
  tests/wave5_concert_locks.test.ts

# 4. the drift bound silently shrinks (the honesty math lies)
run_mutation "F18: clockDriftMs 500 → 50 (the disclosed drift is not the real gate)" \
  src/ai/core/constants.ts "s/clockDriftMs: 500/clockDriftMs: 50/" \
  tests/wave5_concert_locks.test.ts

echo "── WAVE 5 mutations: F19 genre map ──"

# 5. the relaxation pass is deleted entirely
run_mutation "F19: relaxation deleted (pass<0) — bubbles overlap again" \
  src/ai/genreExplorer.ts "s/pass < GENRE_EXPLORER\.relaxPasses/pass < 0/" \
  tests/wave5_genre_locks.test.ts

# 6. the radius-formula energy term is flattened to 0.5
run_mutation "F19: radius energy term flattened (all bubbles neutral)" \
  src/ai/genreExplorer.ts "s/\* clamp01(prior\.energy);/\* 0.5;/" \
  tests/wave5_genre_locks.test.ts

# 7. determinism chaos: the seed drifts on every call
run_mutation "F19: seed chaos injected (same input, different map)" \
  src/ai/genreExplorer.ts "s/const rand = mulberry32(seed);/globalThis.__mutState = (globalThis.__mutState ?? seed) + 1; const rand = mulberry32(globalThis.__mutState);/" \
  tests/wave5_genre_locks.test.ts

# 8. the PRNG constant is corrupted (the literal sequence moves)
run_mutation "F19: mulberry32 increment corrupted (PRNG is not the documented one)" \
  src/ai/genreExplorer.ts "s/a = (a + 0x6d2b79f5) | 0;/a = (a + 0x6d2b79f6) | 0;/" \
  tests/wave5_genre_locks.test.ts

echo "── WAVE 5 mutations: F20 memory tags ──"

# 9. the LRU guard is inverted (evicts the newest rows, even the fresh one)
run_mutation "F20: LRU evicts the wrong end (newest instead of oldest)" \
  src/storage/memoryTags.ts "s/await store\.del(all\[i\]\.id);/await store.del(all[all.length - 1 - i].id);/" \
  tests/wave5_memory_tags_locks.test.ts

# 10. the update path forgets the original moment
run_mutation "F20: re-tag overwrites the original moment" \
  src/storage/memoryTags.ts "s/at: existing?\.at ?? tag\.at,/at: tag.at,/" \
  tests/wave5_memory_tags_locks.test.ts

# 11. the note cap is loosened off the constant
run_mutation "F20: note cap 240 → 500 (the documented bound is a lie)" \
  src/storage/memoryTags.ts "s/\.slice(0, MEMORY_TAGS\.maxNoteChars);/.slice(0, 500);/" \
  tests/wave5_memory_tags_locks.test.ts

# 12. a streamUrl column sneaks into the schema
run_mutation "F20: streamUrl column added to memory_tags (schema leak)" \
  src/storage/appTables.ts "s/note TEXT NOT NULL DEFAULT ''/note TEXT NOT NULL DEFAULT '', streamUrl TEXT/" \
  tests/wave5_memory_tags_locks.test.ts

echo "── WAVE 5 mutations: critic-fix surfaces ──"

# 13. the tap classification is severed (the F19 headline interaction dies again)
run_mutation "F19-critic: tap→playGenre severed (bubbles go dead again)" \
  src/screens/GenreExplorer.tsx "s/if (best) void playGenre(best\.bubble);/if (false) void playGenre(best.bubble);/" \
  tests/wave5_genre_locks.test.ts

# 14. the pan math regresses to the per-event accumulation (overshoot returns)
run_mutation "F19-critic: pan math regresses to per-event accumulation" \
  src/screens/GenreExplorer.tsx "s/panBaseRef\.current\.x + g\.dx \* GENRE_EXPLORER\.panDamping,/panRef.current.x + g.dx * GENRE_EXPLORER.panDamping,/" \
  tests/wave5_genre_locks.test.ts

# 15. the honest count is faked (the join flow promises again)
run_mutation "F18-critic: join flow fakes the queue count (the silent-room lie returns)" \
  src/screens/MindbeatWireScreen.tsx "s/const queued = await playQueue(rows, 0);/const queued = 1;/" \
  tests/wave5_concert_locks.test.ts

# 16. the art probe moves back into the render body (post-paint law dead)
run_mutation "F19-critic: art probe leaves InteractionManager (render-body network call)" \
  src/screens/GenreExplorer.tsx "s/InteractionManager\.runAfterInteractions/setTimeout/" \
  tests/wave5_genre_locks.test.ts

echo "── WAVE 5 mutation summary ──"
echo "  RED (caught): $PASS"
echo "  SURVIVED (theatre): $FAIL"
[ "$FAIL" -eq 0 ] || exit 1

# final proof: every mutation reverted byte-exact (sha256 — the wave's own
# uncommitted changes are the BASELINE these hashes pin; same method as wave 2)
DIRTY=0
for f in src/ai/concert.ts src/ai/core/constants.ts src/ai/genreExplorer.ts src/storage/memoryTags.ts src/storage/appTables.ts; do
  NOW=$(sha256sum "$f" | cut -d' ' -f1)
  if [ "$NOW" != "${HASHES[$f]}" ]; then
    echo "DRIFT: $f does not match its pre-run hash"; DIRTY=1
  fi
done
[ "$DIRTY" -eq 0 ] || exit 1
if git status --porcelain | grep -q '\.bak'; then
  echo "ERROR: leftover .bak files:"; git status --porcelain | grep '\.bak'; exit 1
fi
echo "  sha256-verified: all mutated files byte-identical to the pre-run baseline."
