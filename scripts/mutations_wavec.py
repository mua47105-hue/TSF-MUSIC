#!/usr/bin/env python3
"""WAVE C mutation gauntlet driver (v5.2.1) — 13 mutations across C1..C5."""
import hashlib
import subprocess
from pathlib import Path

ROOT = Path('/home/z/my-project/TSF-MUSIC')
BACKUP = ROOT / '.mutation-backups' / 'v521-wavec'
LOCK = 'tests/fix_v521_waveC_locks.test.ts'
PERF = 'tests/ai/perf.test.ts'
HYG = 'tests/ai/hygiene_behavioral_locks.test.ts'


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def run_tests(extra: list[str] | None = None) -> int:
    cmd = ['bun', 'test', LOCK] + (extra or [])
    out = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=600)
    return sum(1 for line in (out.stdout + out.stderr).splitlines() if line.startswith('(fail)'))


MUTATIONS: list[dict] = [
    {
        'id': 'M-C1-1', 'file': 'src/ai/engine.ts',
        'old': "    .filter((t) => t.id !== seed.id && t.source === 'saavn')",
        'new': "    .filter((t) => t.source === 'saavn') // MUTATION M-C1-1: the seed can radio itself",
    },
    {
        'id': 'M-C1-2', 'file': 'src/ai/surfaces/mixes.ts',
        'old': "        const isYesterday = yesterdayIds.has(c.trackId);",
        'new': "        const isYesterday = false; // MUTATION M-C1-2: the anti-staleness cap is dead",
    },
    {
        'id': 'M-C1-3', 'file': 'src/ai/surfaces/daylist.ts',
        'old': "  const name = microgenreName(block, moodLabel, topLanguage);",
        'new': "  const name = ''; // MUTATION M-C1-3: the microgenre name is fabricated empty",
    },
    {
        'id': 'M-C1-4', 'file': 'src/ai/surfaces/shuffle.ts',
        'old': "  return { recCount: Math.max(2, Math.floor(queueLength / CADENCE.smartShuffleRatio)), insertEvery: CADENCE.smartShuffleRatio };",
        'new': "  return { recCount: Math.max(2, Math.floor(queueLength / CADENCE.smartShuffleRatio)), insertEvery: 1 }; // MUTATION M-C1-4: the injection rhythm is broken",
    },
    {
        'id': 'M-C1-5', 'file': 'src/ai/surfaces/ontherise.ts',
        'old': "      reason: reasonLine('NEIGHBOR', viaArtistOf(c.artist, viaById)),",
        'new': "      reason: '', // MUTATION M-C1-5: the honest chain is dropped",
    },
    {
        'id': 'M-C2-1', 'file': 'src/api/boundedMap.ts',
        'old': """    while (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }""",
        'new': "    // MUTATION M-C2-1: the eviction is gone — the cache grows forever",
    },
    {
        'id': 'M-C2-2', 'file': 'src/api/lrclib.ts',
        'old': "const originCache = new BoundedMap<string, { at: number; origin: LyricOrigin | null }>(ORIGIN_CACHE_CAP);",
        'new': "const originCache = new Map<string, { at: number; origin: LyricOrigin | null }>(); // MUTATION M-C2-2: unbounded again",
    },
    {
        'id': 'M-C3-1', 'file': 'src/api/artists.ts',
        'old': "const photoCache = new BoundedMap<string, string>(ARTIST_PHOTO_CACHE_CAP);",
        'new': "const photoCache = new Map<string, string>(); // MUTATION M-C3-1: unbounded again",
    },
    {
        'id': 'M-C3-2', 'file': 'src/api/boundedMap.ts',
        'old': """    const v = this.map.get(key);
    if (v !== undefined) {
      // refresh recency: delete + re-insert moves the key to the tail
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;""",
        'new': """    // MUTATION M-C3-2: get() no longer refreshes recency (FIFO, not LRU)
    return this.map.get(key);""",
    },
    {
        'id': 'M-C4-1', 'file': 'tests/ai/perf.test.ts',
        'old': "    expect(p95).toBeLessThan(PERF_BUDGETS.decisionQueryMs);",
        'new': "    expect(p95).toBeLessThan(150); // MUTATION M-C4-1: the budget name is unlinked",
    },
    {
        'id': 'M-C4-2', 'file': 'tests/ai/perf.test.ts',
        'old': "    expect(dt).toBeLessThan(PERF_BUDGETS.coldStartDeltaMs);",
        'new': "    // MUTATION M-C4-2: the init-slice budget is unasserted",
    },
    {
        'id': 'M-C5-1', 'file': 'tests/ai/hygiene_behavioral_locks.test.ts',
        'old': """afterAll(() => {
  mock.module('../../src/api/saavn', () => realSaavn);
});""",
        'new': "/* MUTATION M-C5-1: the restoration is gone — the fixture rows leak */",
    },
    {
        'id': 'M-C5-2', 'file': 'tests/ai/hygiene_behavioral_locks.test.ts',
        'old': "  mock.module('../../src/api/saavn', () => realSaavn);",
        'new': "  mock.module('../../src/api/saavn', () => ({ ...realSaavn, getArtistTracks: async () => [] })); // MUTATION M-C5-2: a WRONG restore",
    },
]


def main() -> int:
    files = {m['file'] for m in MUTATIONS}
    baseline = {f: sha(ROOT / f) for f in files}
    BACKUP.mkdir(parents=True, exist_ok=True)
    results: list[str] = []
    for m in MUTATIONS:
        f = ROOT / m['file']
        backup = BACKUP / f"{m['id']}.{f.name}"
        backup.write_bytes(f.read_bytes())
        src = f.read_text()
        if m['old'] not in src:
            results.append(f"{m['id']}: *** ANCHOR NOT FOUND ***")
            continue
        f.write_text(src.replace(m['old'], m['new'], 1))
        extra = [PERF] if m['id'].startswith('M-C4') else ([HYG] if m['id'].startswith('M-C5') else None)
        fails = run_tests(extra)
        results.append(f"{m['id']}: fails={fails} {'RED-OK' if fails else '*** GREEN — SURVIVED ***'}")
        f.write_bytes(backup.read_bytes())
        if sha(f) != baseline[m['file']]:
            results.append(f"{m['id']}: *** RESTORE MISMATCH ***")
            return 9
        results.append(f"{m['id']} restore: BYTE-EXACT")
    print('\n'.join(results))
    return 0


if __name__ == '__main__':
    import sys
    sys.exit(main())
