#!/usr/bin/env bash
# run_lab.sh — the Android E2E lab, executed INSIDE the booted emulator
# (by reactivecircus/android-emulator-runner). Collects maximum evidence
# per run: required flows must pass; stretch flows are recorded only.
# Latency metrics come from [TSF-PERF] logcat marks; hard hygiene breaches
# (crash/ANR/hard-ceiling) fail the lab.
set -uo pipefail

ART="${GITHUB_WORKSPACE:-/tmp}/lab-artifacts"
mkdir -p "$ART"
APK="android/app/build/outputs/apk/release/app-release.apk"
PKG="com.tsf.music"
ACT="${PKG}/.MainActivity"

test -f "$APK" || { echo "APK missing at $APK"; exit 1; }

# ── capture everything the app says ────────────────────────────────────
adb logcat -c
adb logcat -v time > /tmp/logcat.txt 2>&1 &
LOGCAT_PID=$!
trap 'kill $LOGCAT_PID 2>/dev/null || true' EXIT

# ── cold start: first launch of the freshly installed app ─────────────
adb install -r "$APK"
sleep 2
adb shell am start -W -n "$ACT" | tee "$ART/am-start.txt"
sleep 4 # let the fresh boot settle before flow 01 restarts it clean

# ── required flows (any failure fails the lab) ─────────────────────────
REQUIRED=(01-fresh-boot 02-search 03-playback 04-skip 05-artist 06-tour)
STRETCH=(07-wire-vibe 08-download)
FAIL=0
for f in "${REQUIRED[@]}"; do
  echo "===== FLOW $f ====="
  if timeout 480 maestro test "$PWD/.maestro/$f.yaml" 2>&1 | tee "$ART/$f.log"; then
    echo "===== $f PASS ====="
  else
    echo "===== $f FAIL ====="
    FAIL=1
  fi
done

# ── stretch flows (evidence only) ──────────────────────────────────────
for f in "${STRETCH[@]}"; do
  echo "===== STRETCH $f ====="
  timeout 300 maestro test "$PWD/.maestro/$f.yaml" 2>&1 | tee "$ART/$f.log" \
    || echo "===== $f STRETCH-FAIL (recorded, not gating) ====="
done

kill $LOGCAT_PID 2>/dev/null || true
sleep 1

# ── metrics + hygiene verdict ──────────────────────────────────────────
set +e
python3 scripts/e2e/parse_perf.py /tmp/logcat.txt \
  --amstart "$ART/am-start.txt" --out "$ART/perf-report.json"
PARSE=$?
set -e
cp /tmp/logcat.txt "$ART/logcat.txt" 2>/dev/null || true

# maestro leaves failure screenshots/ui-dumps in the CWD — hoard them all
cp -a ./*.png "$ART/" 2>/dev/null || true
cp -a ./*.xml "$ART/" 2>/dev/null || true
# maestro's per-run debug dirs (failure screenshot + UI hierarchy dump)
cp -a "$HOME/.maestro/tests" "$ART/maestro-tests" 2>/dev/null || true
# strip paths the artifact uploader rejects (flow names once carried ':')
find "$ART/maestro-tests" -name '*:*' -exec rm -rf {} + 2>/dev/null || true

echo "PERF_PARSE_EXIT=$PARSE FAIL=$FAIL"
if [ "$FAIL" -ne 0 ] || [ "$PARSE" -eq 2 ] || [ "$PARSE" -eq 3 ]; then
  exit 1
fi
exit 0
