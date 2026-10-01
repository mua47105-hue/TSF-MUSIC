#!/usr/bin/env bash
# One-invocation lab runner: metro + selected devices, report snapshot.
set -u
cd "$(dirname "$0")/.."
PORT=8123
URL="http://localhost:$PORT"
LOG=.lab-metro.log

pkill -f "expo start" 2>/dev/null || true
sleep 1
echo "[batch] starting metro (web) on :$PORT"
CI=1 bunx expo start --web --port $PORT --offline --non-interactive --clear >"$LOG" 2>&1 &
METRO_PID=$!
ready=0
for i in $(seq 1 200); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$URL" || true)
  if [ "$code" = "200" ]; then ready=1; break; fi
  sleep 2
done
if [ "$ready" != "1" ]; then echo "[batch] metro failed"; tail -20 "$LOG"; kill $METRO_PID 2>/dev/null; exit 1; fi
echo "[batch] metro ready — warming"
curl -s "$URL" >/dev/null || true
sleep 18

TSF_DEVICES="$1" python3 scripts/device_lab.py
cp /home/z/my-project/screenshots/report.json "/home/z/my-project/screenshots/report-$1.json" 2>/dev/null
kill $METRO_PID 2>/dev/null
echo "[batch] done $1"
