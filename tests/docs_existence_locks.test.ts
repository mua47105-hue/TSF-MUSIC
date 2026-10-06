/**
 * THE LOST-DOC GUARD — v4.3.1 (the auditor's BAR 4).
 *
 * The merge at bfa37fb silently deleted docs/GENIUS-NOTE.md (the
 * operator's page: re-bake commands, MIT/VADER license notes, honest
 * per-technique limits). Nothing in CI noticed — a doc is not code, so
 * no test ever looked. One existence lock makes a silent doc deletion
 * impossible from now on: if a merge drops a tracked doc, the suite
 * goes RED before the branch lands.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const doc = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

describe('v4.3.1 · auditor BAR 4 — tracked docs survive merges', () => {
  test('docs/GENIUS-NOTE.md exists and is a real note, not a stub', () => {
    const p = doc('../docs/GENIUS-NOTE.md');
    expect(existsSync(p)).toBeTrue();
    // the recovered note is ~4.8KB — a stub/empty recovery must fail
    expect(statSync(p).size).toBeGreaterThan(1000);
  });

  test('its sibling operator docs survived too (the same merge class)', () => {
    // these were never deleted — pinned so the NEXT merge cannot take
    // them down quietly either
    for (const rel of ['../docs/ARCHITECTURE.md', '../docs/MINDBEAT.md', '../docs/CHANGELOG.md']) {
      expect(existsSync(doc(rel))).toBeTrue();
    }
  });
});
