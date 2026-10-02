#!/usr/bin/env python3
"""parse_perf.py — turn logcat [TSF-PERF] marks into the lab report.

Reads the captured logcat, pairs request/playing marks into latency
samples, checks them against the gauntlet bars, and writes perf-report.json.

Exit codes:
  0  report written, no hard-ceiling breach
  2  report written, at least one HARD ceiling breached (fails the lab)
  3  input problems (no logcat / no marks at all)

Bars (set per the user's "Spotify-grade" directive):
  cold start    target <= 9s    hard 15s    (CI emulator, swiftshader GPU)
  play->audio   target <= 4s    hard 8s     p50
  skip->audio   target <= 3s    hard 6s     p50
  search->rows  target <= 4s    hard 8s     p50
Between target and hard = PASS-with-issue (recorded, feeds the backlog).
"""

import argparse
import json
import re
import statistics
import sys

BARS = {
    "cold_start": {"target": 9.0, "hard": 15.0, "unit": "s"},
    "time_to_audio": {"target": 4.0, "hard": 8.0, "unit": "s"},
    "skip_latency": {"target": 3.0, "hard": 6.0, "unit": "s"},
    "search_latency": {"target": 4.0, "hard": 8.0, "unit": "s"},
}

MARK_RE = re.compile(r"\[TSF-PERF\] t=(\d+) event=([a-z-]+)(?: detail=(.*))?$")
FATAL_RE = re.compile(r"FATAL EXCEPTION|beginning of crash")
ANR_RE = re.compile(r"ANR in com\.tsf\.music")
JS_ERR_RE = re.compile(r"ReactNativeJS.*\b(Error|Unhandled)\b")


def verdict(metric: str, seconds: float) -> str:
    bar = BARS[metric]
    if seconds <= bar["target"]:
        return "PASS"
    if seconds <= bar["hard"]:
        return "PASS_WITH_ISSUE"
    return "HARD_FAIL"


def pair_requests(events, request_ev, label):
    """For each request mark, take the first unconsumed audio-playing AFTER it."""
    consumed = set()
    samples = []
    reqs = [(i, e) for i, e in enumerate(events) if e["event"] == request_ev]
    for i, req in reqs:
        for j, ev in enumerate(events):
            if j <= i or j in consumed:
                continue
            if ev["event"] == "audio-playing":
                consumed.add(j)
                samples.append((ev["t"] - req["t"]) / 1000.0)
                break
    return {"metric": label, "samples": samples}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("logcat")
    ap.add_argument("--amstart", required=True, help="am start -W output file")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    try:
        raw = open(args.logcat, "r", errors="replace").read()
    except OSError as e:
        print(f"cannot read logcat: {e}", file=sys.stderr)
        return 3

    events = []
    for line in raw.splitlines():
        m = MARK_RE.search(line)
        if m:
            events.append(
                {"t": int(m.group(1)), "event": m.group(2), "detail": (m.group(3) or "").strip()}
            )
    events.sort(key=lambda e: e["t"])

    if not events:
        print("NO [TSF-PERF] marks found in logcat — instrumented build missing?", file=sys.stderr)
        return 3

    # ── cold start from am start -W ─────────────────────────────────────
    cold = None
    try:
        am = open(args.amstart).read()
        m = re.search(r"TotalTime:\s*(\d+)", am)
        if m:
            cold = int(m.group(1)) / 1000.0
    except OSError:
        pass

    # ── latency metrics ─────────────────────────────────────────────────
    play_pairs = pair_requests(events, "play-request", "time_to_audio")
    skip_pairs = pair_requests(events, "skip-request", "skip_latency")

    # search: run → first results mark with n > 0 after it
    search_samples = []
    last_run = None
    for e in events:
        if e["event"] == "search-run":
            last_run = e["t"]
        elif e["event"] in ("search-results", "search-early", "search-final", "search-yt", "search-vibe") and last_run is not None:
            try:
                n = int(e["detail"])
            except ValueError:
                n = 0
            if n > 0:
                search_samples.append((e["t"] - last_run) / 1000.0)
                last_run = None

    metrics = {}
    issues = []
    hard_fail = False

    def record(metric, samples, cold_s=None):
        nonlocal hard_fail
        bar = BARS[metric]
        if cold_s is not None:
            p50 = cold_s
            entry = {"p50_s": round(p50, 2), "samples": [round(cold_s, 2)]}
        elif samples:
            p50 = statistics.median(samples)
            entry = {
                "p50_s": round(p50, 2),
                "min_s": round(min(samples), 2),
                "max_s": round(max(samples), 2),
                "n": len(samples),
                "samples": [round(s, 2) for s in samples],
            }
        else:
            entry = {"p50_s": None, "n": 0, "note": "no samples captured"}
            p50 = None
        if p50 is None:
            entry["verdict"] = "NO_DATA"
            issues.append(f"{metric}: no samples — pairing failed or flow skipped")
        else:
            v = verdict(metric, p50)
            entry["verdict"] = v
            if v == "PASS_WITH_ISSUE":
                issues.append(
                    f"{metric}: p50 {p50:.2f}s exceeds target {bar['target']}s (under hard {bar['hard']}s)"
                )
            if v == "HARD_FAIL":
                hard_fail = True
                issues.append(f"{metric}: p50 {p50:.2f}s BREACHES hard ceiling {bar['hard']}s")
        metrics[metric] = entry

    record("cold_start", None, cold_s=cold)
    record("time_to_audio", play_pairs["samples"])
    record("skip_latency", skip_pairs["samples"])
    record("search_latency", search_samples)

    # ── hygiene: crashes / ANRs / JS errors ─────────────────────────────
    fatal = [l.strip() for l in raw.splitlines() if FATAL_RE.search(l)]
    anr = [l.strip() for l in raw.splitlines() if ANR_RE.search(l)]
    js_err = sorted({l.strip()[:220] for l in raw.splitlines() if JS_ERR_RE.search(l)})
    if fatal:
        hard_fail = True
        issues.append(f"hygiene: {len(fatal)} FATAL/crash lines in logcat")
    if anr:
        hard_fail = True
        issues.append(f"hygiene: {len(anr)} ANR lines in logcat")

    report = {
        "bars": BARS,
        "metrics": metrics,
        "events": events,
        "hygiene": {
            "fatal_crash_lines": len(fatal),
            "anr_lines": len(anr),
            "js_error_lines": js_err[:40],
        },
        "issues_found": issues,
    }
    with open(args.out, "w") as f:
        json.dump(report, f, indent=1)

    # ── human summary for the Actions log ───────────────────────────────
    print("\n===== TSF ANDROID LAB REPORT =====")
    for k, v in metrics.items():
        print(f"{k:14} p50={v['p50_s']}s verdict={v['verdict']} samples={v.get('n', v.get('samples'))}")
    print(f"hygiene: fatal={len(fatal)} anr={len(anr)} js_err={len(js_err)}")
    if issues:
        print("issues found:")
        for i in issues:
            print(f"  - {i}")
    print("==================================\n")

    return 2 if hard_fail else 0


if __name__ == "__main__":
    sys.exit(main())
