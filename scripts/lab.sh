#!/usr/bin/env bash
# TSF device lab — one-shot orchestrator (sandbox kills background
# processes between invocations, so Metro lives only inside this run).
set -u
cd "$(dirname "$0")/.."

PORT=8123
URL="http://localhost:$PORT"
LOG=.lab-metro.log

pkill -f "expo start" 2>/dev/null || true
sleep 1

echo "[lab] starting metro (web) on :$PORT"
CI=1 bunx expo start --web --port $PORT --offline --non-interactive --clear >"$LOG" 2>&1 &
METRO_PID=$!

ready=0
for i in $(seq 1 240); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$URL" || true)
  if [ "$code" = "200" ]; then ready=1; break; fi
  sleep 2
done
if [ "$ready" != "1" ]; then
  echo "[lab] metro failed to become ready (see $LOG)"; tail -30 "$LOG"; kill $METRO_PID 2>/dev/null; exit 1
fi
echo "[lab] metro ready after ~$((i*2))s — warming bundle"
# first compile can take a while; hit the page once to force bundling
curl -s "$URL" >/dev/null || true
sleep 20

echo "[lab] running device walkthrough"
python3 scripts/device_lab.py
RC=$?

kill $METRO_PID 2>/dev/null
echo "[lab] done rc=$RC"
exit $RC
