#!/usr/bin/env python3
"""V5.3.0 mutation gauntlet driver — 16 mutations across BAR 1..7.

Each mutation is a byte-exact source substitution. The driver:
  1. snapshots the file (SHA-256 recorded),
  2. applies the mutation,
  3. runs the v5.3.0 lock file (bun test tests/wave_v530_spotify_re_locks.test.ts),
  4. requires >=1 FAILED test (RED-OK — the lock has teeth),
  5. restores the file byte-exact (SHA-256 re-verified),
  6. proves no residue (git status --porcelain on the touched paths).

A mutation that survives GREEN means the lock is theatre — it must be
redesigned, not shipped (the gauntlet law).
"""
import hashlib
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path('/home/z/TSF-MUSIC')
BACKUP = ROOT / '.mutation-backups' / 'v530'
LOCK = 'tests/wave_v530_spotify_re_locks.test.ts'
ALT_LOCKS = {
    'M-530-13': 'tests/ai/wave1_playback_locks.test.ts',
}


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def run_lock(lock_file: str) -> int:
    out = subprocess.run(
        ['bun', 'test', lock_file],
        cwd=ROOT, capture_output=True, text=True, timeout=300,
    )
    return sum(1 for line in (out.stdout + out.stderr).splitlines() if line.startswith('(fail)'))


MUTATIONS: list[dict] = [
    # ── BAR 1 — album-mode replayGain + the baked DSP columns ──────────
    {
        'id': 'M-530-1', 'file': 'src/player/replayGain.ts',
        'old': "  const albumLufs = present.reduce((s, l) => s + l, 0) / present.length;",
        'new': "  const albumLufs = present[0]; // MUTATION M-530-1: the album mean becomes its first row",
    },
    {
        'id': 'M-530-2', 'file': 'src/player/replayGain.ts',
        'old': "  if (!present.length) return 0;",
        'new': "  if (!present.length) return 4; // MUTATION M-530-2: no evidence silently boosts",
    },
    {
        'id': 'M-530-3', 'file': 'src/player/replayGain.ts',
        'old': "  if (!active || !queue || queue.length < 2) return false;",
        'new': "  if (!active || !queue) return false; // MUTATION M-530-3: single-row queues are albums now",
    },
    # ── BAR 2 — the spread shuffle + the 2-strike retreat ──────────────
    {
        'id': 'M-530-4', 'file': 'src/player/spreadShuffle.ts',
        'old': "      const jitter = 0.5 + rng(); // ×0.5..×1.5 multiplicative dither",
        'new': "      const jitter = 1; // MUTATION M-530-4: the dither is gone (deterministic greedy)",
    },
    {
        'id': 'M-530-5', 'file': 'src/player/spreadShuffle.ts',
        'old': "      const weight = since * group.length * jitter;",
        'new': "      const weight = group.length * jitter; // MUTATION M-530-5: silence urgency dropped",
    },
    {
        'id': 'M-530-6', 'file': 'src/ai/core/constants.ts',
        'old': "  strikeThreshold: 2,",
        'new': "  strikeThreshold: 5, // MUTATION M-530-6: the retreat never arms in practice",
    },
    # ── BAR 3 — bandit decay + shelf arms + ranked shelves ─────────────
    {
        'id': 'M-530-7', 'file': 'src/ai/core/bandit.ts',
        'old': "    ts: nowMs,\n  };\n}",
        'new': "    ts: arm.ts, // MUTATION M-530-7: the decay clock never advances\n  };\n}",
    },
    {
        'id': 'M-530-8', 'file': 'src/ai/core/bandit.ts',
        'old': "  const factor = Math.pow(0.5, dtDays / HALF_LIFE.banditArm);",
        'new': "  const factor = 1; // MUTATION M-530-8: evidence never decays",
    },
    {
        'id': 'M-530-9', 'file': 'src/ai/mindbeat.ts',
        'old': "    if (!arms.some((a) => a && armEvidence(a) > 0)) {",
        'new': "    if (false) { // MUTATION M-530-9: cold arms get coin-flipped too",
    },
    {
        'id': 'M-530-10', 'file': 'src/ai/mindbeat.ts',
        'old': "      if (id === shelfId) this.bandit.bumpExternal(key, SHELF_REWARD.positive, 0);\n      else this.bandit.bumpExternal(key, 0, SHELF_REWARD.negative);",
        'new': "      this.bandit.bumpExternal(key, SHELF_REWARD.positive, 0); // MUTATION M-530-10: everyone wins",
    },
    # ── BAR 4 — the 64 kB range pre-warm ───────────────────────────────
    {
        'id': 'M-530-11', 'file': 'src/player/prewarm.ts',
        'old': "  if (network !== 'wifi') return false;",
        'new': "  // MUTATION M-530-11: any network warms (the conservative law is gone)\n  if (network === 'none') return false;",
    },
    {
        'id': 'M-530-12', 'file': 'src/player/prewarm.ts',
        'old': "  rangeWarmed.set(url, now);\n  const fetcher = injectedRangeFetcher ?? defaultRangeFetcher;\n  void fetcher(url, PREWARM.rangeBytes).catch(() => undefined);",
        'new': "  rangeWarmed.set(url, now); // MUTATION M-530-12: the warm request is never fired\n  void 0;",
    },
    # ── BAR 6 — the equal-power cosine curve (locked in wave1 too) ─────
    {
        'id': 'M-530-13', 'file': 'src/player/crossfade.ts',
        'old': "  if (curve === 'linear') return 1 - p;\n  if (p >= 1) return 0; // cos(π/2) is 6.1e−17 in IEEE — clamp to exact 0\n  return Math.cos((p * Math.PI) / 2);",
        'new': "  if (curve === 'linear') return 1 - p; // MUTATION M-530-13: cosine quietly becomes linear\n  if (p >= 1) return 0;\n  return 1 - p;",
    },
    # ── BAR 5 — the E4M3 grid ──────────────────────────────────────────
    {
        'id': 'M-530-14', 'file': 'src/ai/core/similarity.ts',
        'old': "  let m = Math.round((a / 2 ** (e - 7) - 1) * 8);",
        'new': "  let m = Math.floor((a / 2 ** (e - 7) - 1) * 8); // MUTATION M-530-14: round-to-nearest becomes floor",
    },
    {
        'id': 'M-530-15', 'file': 'src/ai/core/similarity.ts',
        'old': "      const ca = cos.get(ia);\n        const cb = cos.get(ib);\n        if (ca !== undefined && cb !== undefined && ca !== cb) return cb - ca;\n        return 0;",
        'new': "      void cos; return 0; // MUTATION M-530-15: the cosine tie-break never fires",
    },
    # ── BAR 7 — the SingAlong dwell ────────────────────────────────────
    {
        'id': 'M-530-16', 'file': 'src/ai/core/profile.ts',
        'old': "      if (artist) bump(p.artists, artist, SINGALONG_DWELL.weight, e.ts, 'heart');",
        'new': "      if (artist) bump(p.artists, artist, GRADE_WEIGHTS.HEART, e.ts, 'heart'); // MUTATION M-530-16: dwell counts as a full heart",
    },
]


def main() -> int:
    BACKUP.mkdir(parents=True, exist_ok=True)
    results: list[tuple[str, str, str]] = []
    red_ok = 0
    for m in MUTATIONS:
        target = ROOT / m['file']
        lock = ALT_LOCKS.get(m['id'], LOCK)
        before = sha(target)
        shutil.copy2(target, BACKUP / f"{m['id']}.bak")
        src = target.read_text()
        if m['old'] not in src:
            results.append((m['id'], 'NO-ANCHOR', f"old text not found in {m['file']}"))
            continue
        target.write_text(src.replace(m['old'], m['new'], 1))
        try:
            fails = run_lock(lock)
        finally:
            # byte-exact restore + verify
            shutil.copy2(BACKUP / f"{m['id']}.bak", target)
        restored = sha(target)
        if restored != before:
            results.append((m['id'], 'RESTORE-FAIL', f"sha mismatch after restore: {restored} != {before}"))
            continue
        if fails >= 1:
            results.append((m['id'], 'RED-OK', f"{fails} failing test(s) in {lock}"))
            red_ok += 1
        else:
            results.append((m['id'], 'GREEN-SURVIVED', f"no failure in {lock} — the lock lacks teeth"))
    print(f"{'ID':<12}{'VERDICT':<16}DETAIL")
    for mid, verdict, detail in results:
        print(f"{mid:<12}{verdict:<16}{detail}")
    print(f"\n{red_ok}/{len(MUTATIONS)} RED-OK")
    # residue check
    residue = subprocess.run(
        ['git', 'status', '--porcelain'], cwd=ROOT, capture_output=True, text=True,
    ).stdout.strip()
    print("(git residue expected only for the v5.3.0 work itself; no .bak files tracked)")
    bad = [l for l in residue.splitlines() if '.mutation-backups' in l]
    if bad:
        print("RESIDUE FAIL:", bad)
        return 1
    return 0 if red_ok == len(MUTATIONS) else 2


if __name__ == '__main__':
    sys.exit(main())
