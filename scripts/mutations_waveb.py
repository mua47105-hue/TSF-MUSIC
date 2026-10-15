#!/usr/bin/env python3
"""WAVE B mutation gauntlet driver (v5.2.1).
Applies each mutation, asserts the lock suite goes RED, restores byte-exact
(sha1-verified) and asserts zero residue. One process, full matrix report."""
import hashlib
import subprocess
import sys
from pathlib import Path

ROOT = Path('/home/z/my-project/TSF-MUSIC')
BACKUP = ROOT / '.mutation-backups' / 'v521-waveb'
LOCK = 'tests/fix_v521_waveB_locks.test.ts'
LP02 = 'tests/ai/search_yt_locks.test.ts'


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def run_tests(extra: list[str] | None = None) -> int:
    cmd = ['bun', 'test', LOCK] + (extra or [])
    out = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=300)
    return sum(1 for line in (out.stdout + out.stderr).splitlines() if line.startswith('(fail)'))


MUTATIONS: list[dict] = [
    {
        'id': 'M-B2-1', 'file': 'src/api/artists.ts',
        'old': """  const hostMatch = /^https:\\/\\/([^/]+)\\//.exec(url);
  if (!hostMatch || hostMatch[1] !== 'c.saavncdn.com') return ''; // wrong host (or not https) — rejected""",
        'new': "  // MUTATION M-B2-1: the host law is gone\n",
        'expect_fails_in': [LOCK],
    },
    {
        'id': 'M-B2-2', 'file': 'src/api/artists.ts',
        'old': "  if (!url.includes('/artists/')) return ''; // placeholder / album art / share image",
        'new': "  // MUTATION M-B2-2: the path law is gone\n",
    },
    {
        'id': 'M-B3-1', 'file': 'src/search/seatbelt.ts',
        'old': """  if (late.length === 0 && prev.length > 0) return prev; // a late zero can't unsee rows
  return late;""",
        'new': "  // MUTATION M-B3-1: the seatbelt is gone — the late paint always wins\n  return late;",
    },
    {
        'id': 'M-B3-2', 'file': 'src/screens/SearchScreen.tsx',
        'old': "            const next = seatbeltPaint(finalTracks, prev);",
        'new': "            const next = finalTracks; // MUTATION M-B3-2: the seatbelt is unwired",
    },
    {
        'id': 'M-B4-1', 'file': 'src/components/TrackRow.tsx',
        'old': '      testID="track-row"',
        'new': '      testID="track-row-v2" // MUTATION M-B4-1: the E2E contract renamed',
    },
    {
        'id': 'M-B4-2', 'file': 'src/components/TrackRow.tsx',
        'old': '      testID="track-row"\n',
        'new': '      // MUTATION M-B4-2: the testID is gone\n',
    },
    {
        'id': 'M-B5-1', 'file': 'src/search/verify.ts',
        'old': "  const reconciled = reconcileRecordings([...organicRows, ...rescuedRows]);",
        'new': "  const reconciled = [...organicRows, ...rescuedRows]; // MUTATION M-B5-1: the reconcile is gone",
    },
    {
        'id': 'M-B5-2', 'file': 'src/search/verify.ts',
        'old': "  const reconciled = reconcileRecordings([...organicRows, ...rescuedRows]);",
        'new': "  const reconciled = reconcileRecordings([...rescuedRows, ...organicRows]); // MUTATION M-B5-2: rescue evicts the playable twin",
        'extra_tests': [LP02],
    },
    {
        'id': 'M-B6-1', 'file': 'src/ai/mindbeat.ts',
        'old': """  async radio(seed: Track, count = 12) {
    await this.ready();
    if (this.disabled || !this.ledger) return [];""",
        'new': """  async radio(seed: Track, count = 12) {
    await this.ready();
    if (!this.ledger) return []; // MUTATION M-B6-1: the kill-switch gate is gone""",
    },
    {
        'id': 'M-B6-2', 'file': 'src/ai/mindbeat.ts',
        'old': "    const ladder = decadeQuery(year);\n    if (this.disabled) return { tracks: [], thin: true, ladder }; // kill switch, silent",
        'new': "    const ladder = decadeQuery(year);\n    // MUTATION M-B6-2: the decadeRadio kill-switch gate is gone",
    },
    {
        'id': 'M-B7-1', 'file': 'src/api/youtube.ts',
        'old': "  if (!ytAvailable()) return { tracks: [], latencyMs: 0, error: true };",
        'new': "  if (!ytAvailable()) return { tracks: [], latencyMs: 0 }; // MUTATION M-B7-1: the flag is gone",
    },
    {
        'id': 'M-B7-2', 'file': 'src/api/youtube.ts',
        'old': "  if (!ytAvailable()) return { ok: false, reason: 'disabled' };",
        'new': "  if (!ytAvailable()) return { ok: false, reason: 'network' }; // MUTATION M-B7-2: the reason lies",
    },
    {
        'id': 'M-B8-1', 'file': 'src/api/youtube.ts',
        'old': "  if (videoVerdict > 0 && wallCount === 0) {",
        'new': "  if (videoVerdict > 0) { // MUTATION M-B8-1: the mixed verdict resets the streak again",
    },
    {
        'id': 'M-B8-2', 'file': 'src/api/youtube.ts',
        'old': """    // v5.2.1 FIX-B8: a MIXED verdict (wall observed on another rung) stays
    // NEUTRAL — noteYtSuccess() here reset the streak despite an observed
    // LOGIN_REQUIRED, teaching the switch to trust a bot-walled source.
    noteYtSuccess();""",
        'new': """    // MUTATION M-B8-2: the video-only reset is gone
    // noteYtSuccess();""",
    },
]


def main() -> int:
    baseline = {f: sha(ROOT / f) for f in
                {m['file'] for m in MUTATIONS} | {'src/player/trackOwnership.ts', 'src/player/PlayerProvider.tsx'}}
    BACKUP.mkdir(parents=True, exist_ok=True)
    results: list[str] = []
    for m in MUTATIONS:
        f = ROOT / m['file']
        backup = BACKUP / f"{m['id']}.{f.name}"
        backup.write_bytes(f.read_bytes())
        src = f.read_text()
        if m['old'] not in src:
            results.append(f"{m['id']}: *** ANCHOR NOT FOUND — mutation not applied ***")
            continue
        f.write_text(src.replace(m['old'], m['new'], 1))
        fails = run_tests(m.get('extra_tests'))
        verdict = 'RED-OK' if fails > 0 else '*** GREEN — SURVIVED ***'
        results.append(f"{m['id']}: fails={fails} {verdict}")
        f.write_bytes(backup.read_bytes())
        if sha(f) != baseline[m['file']]:
            results.append(f"{m['id']}: *** RESTORE MISMATCH ***")
            return 9
    # the two B1 mutations (block deletion + inversion) applied via bespoke scripts
    results.extend(b1_mutations(baseline))
    print('\n'.join(results))
    residue = subprocess.run(['git', 'status', '--porcelain'], cwd=ROOT, capture_output=True, text=True).stdout
    dirty = [l for l in residue.splitlines() if not l.startswith(' M .mutation-backups/')]
    print(f"\nnon-backup dirty files after all restores: {len(dirty)}")
    for d in dirty:
        print(' ', d)
    return 0


def b1_mutations(baseline: dict) -> list[str]:
    out: list[str] = []
    pp = ROOT / 'src/player/PlayerProvider.tsx'
    to = ROOT / 'src/player/trackOwnership.ts'

    # M-B1-1 — delete the gate block
    bak = BACKUP / 'M-B1-1.PlayerProvider.tsx'
    bak.write_bytes(pp.read_bytes())
    s = pp.read_text()
    start = s.index('    // SINGLE-OWNER RULE (mirror of the service gate) — v5.2.1 FIX-B1')
    end = s.index('    const prevId = prevTrackId.current;')
    pp.write_text(s[:start] + '    // MUTATION M-B1-1: the single-owner gate is GONE\n' + s[end:])
    fails = run_tests()
    out.append(f"M-B1-1: fails={fails} {'RED-OK' if fails else '*** GREEN — SURVIVED ***'}")
    pp.write_bytes(bak.read_bytes())
    out.append('M-B1-1 restore: ' + ('BYTE-EXACT' if sha(pp) == baseline['src/player/PlayerProvider.tsx'] else '*** MISMATCH ***'))

    # M-B1-2 — invert the ownership law
    bak2 = BACKUP / 'M-B1-2.trackOwnership.ts'
    bak2.write_bytes(to.read_bytes())
    s = to.read_text()
    s = s.replace("  return appState === 'active'; // background transitions belong to the service",
                  "  return appState !== 'active'; // MUTATION M-B1-2: inverted", 1)
    to.write_text(s)
    fails = run_tests()
    out.append(f"M-B1-2: fails={fails} {'RED-OK' if fails else '*** GREEN — SURVIVED ***'}")
    to.write_bytes(bak2.read_bytes())
    out.append('M-B1-2 restore: ' + ('BYTE-EXACT' if sha(to) == baseline['src/player/trackOwnership.ts'] else '*** MISMATCH ***'))
    return out


if __name__ == '__main__':
    sys.exit(main())
