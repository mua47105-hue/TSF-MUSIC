#!/usr/bin/env python3
"""WAVE D mutation gauntlet driver (v5.2.1) — 14 mutations across D1..D7."""
import hashlib
import subprocess
from pathlib import Path

ROOT = Path('/home/z/my-project/TSF-MUSIC')
BACKUP = ROOT / '.mutation-backups' / 'v521-waved'
LOCK = 'tests/fix_v521_waveD_locks.test.ts'


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def run_tests() -> int:
    out = subprocess.run(['bun', 'test', LOCK], cwd=ROOT, capture_output=True, text=True, timeout=300)
    return sum(1 for line in (out.stdout + out.stderr).splitlines() if line.startswith('(fail)'))


MUTATIONS: list[dict] = [
    {
        'id': 'M-D1-1', 'file': 'README.md',
        'old': '| QA | 1,143 tests (573 replay suite + 570 improvement-arc & hardening locks) · 5,217 assertions · tsc strict · 93-checkpoint device lab · post-ship APK binary verification |',
        'new': '| QA | 1,072 tests (885 replay suite + 187 improvement-arc 1,071 tests (885 replay suite + 186 improvement-arc & wave locks) · 4,808 assertions wave locks) · 4,811 assertions · tsc strict · 93-checkpoint device lab · post-ship APK binary verification |',
    },
    {
        'id': 'M-D1-2', 'file': 'README.md',
        'old': '1,143 tests (573 replay suite + 570 improvement-arc & hardening locks) · 5,217 assertions',
        'new': '1,200 tests (573 replay suite + 627 improvement-arc & hardening locks) · 5,300 assertions',
    },
    {
        'id': 'M-D2-1', 'file': 'App.tsx',
        'old': "      'SpaceMono-700': require('./assets/fonts/SpaceMono-700.ttf'),",
        'new': """      'SpaceMono-700': require('./assets/fonts/SpaceMono-700.ttf'),
      'Figtree-400': require('./assets/fonts/Figtree-400.ttf'), // MUTATION M-D2-1: the dead fonts ride again""",
    },
    {
        'id': 'M-D2-2', 'file': 'src/theme.ts',
        'old': "  figtreeRegular: 'Figtree-400',",
        'new': "  // MUTATION M-D2-2: the reserved family names are gone\n",
    },
    {
        'id': 'M-D3-1', 'file': 'src/screens/AIScreen.tsx',
        'old': "const MindbeatWireScreen = React.lazy(() =>\n  import('./MindbeatWireScreen').then((m) => ({ default: m.MindbeatWireScreen })),\n);",
        'new': "import { MindbeatWireScreen } from './MindbeatWireScreen'; // MUTATION M-D3-1: the eager pull is back",
    },
    {
        'id': 'M-D3-2', 'file': 'src/screens/AIScreen.tsx',
        'old': '<Suspense',
        'new': '<LazyBoundary // MUTATION M-D3-2: the lazy boundary is severed',
    },
    {
        'id': 'M-D4-1', 'file': 'src/theme/DynamicThemeProvider.tsx',
        'old': "/** The palette of whatever is playing right now. */",
        'new': """/** The palette of whatever is playing right now. */
export function AmbientBackdrop() {
  return null; // MUTATION M-D4-1: the dead component is back
}""",
    },
    {
        'id': 'M-D4-2', 'file': 'src/theme/DynamicThemeProvider.tsx',
        'old': " * (v5.2.1 FIX-D4: the AmbientBackdrop component — a documented-but-never-",
        'new': " * • AmbientBackdrop: the cross-fading wash that sits behind the tab screens (MUTATION M-D4-2).\n * (v5.2.1 FIX-D4: the AmbientBackdrop component — a documented-but-never-",
    },
    {
        'id': 'M-D5-1', 'file': 'src/ai/surfaces/deps.ts',
        'old': "/** Candidates from a search — RAW. v5.2.1 FIX-D5: the old comment claimed",
        'new': "/** Safety-filtered, playable, non-preview candidates from a search. MUTATION M-D5-1: the lie is back.\n *  (v5.2.1 FIX-D5: the old comment claimed",
    },
    {
        'id': 'M-D5-2', 'file': 'tests/ai/surfaces.test.ts',
        'old': " *    20-prompt corpus produces ≥18-track playlists",
        'new': " *    20-prompt corpus produces ≥18-track playlists\n *  ✓ Mixes v2: 60/25/15 split + ≤30% yesterday repeat (MUTATION M-D5-2)",
    },
    {
        'id': 'M-D6-1', 'file': 'src/api/ytCipherCache.ts',
        'old': "  if (entry.bodyHash !== fnv1a(entry.body)) return null;",
        'new': "  // MUTATION M-D6-1: the integrity gate is gone",
    },
    {
        'id': 'M-D6-2', 'file': 'src/api/ytCipherCache.ts',
        'old': "    bodyHash: fnv1a(body),",
        'new': "    bodyHash: 'tampered-stamp', // MUTATION M-D6-2: the stamp lies",
    },
    {
        'id': 'M-D7-1', 'file': 'src/api/ytPoToken.tsx',
        'old': "      originWhitelist={['https://www.youtube.com', 'https://youtube.com', 'https://jnn-pa.googleapis.com']}",
        'new': "      originWhitelist={['*']} // MUTATION M-D7-1: the wildcard is back",
    },
    {
        'id': 'M-D7-2', 'file': 'src/api/ytPoToken.tsx',
        'old': "      originWhitelist={['https://www.youtube.com', 'https://youtube.com', 'https://jnn-pa.googleapis.com']}",
        'new': "      originWhitelist={['https://www.youtube.com', 'https://youtube.com']} // MUTATION M-D7-2: an origin dropped",
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
        fails = run_tests()
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
