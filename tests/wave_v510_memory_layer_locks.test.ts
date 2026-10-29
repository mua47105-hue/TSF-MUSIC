/**
 * WAVE 1 (v5.1.0) · THE MEMORY LAYER — the release's own locks.
 *
 * v5.0.x already ships the Song Stories + Audio Bookmarks cores
 * (tests/wave2_stories_locks.test.ts, tests/wave2_bookmarks_locks.test.ts
 * — untouched, they keep their bars). THIS file locks what v5.1.0 adds:
 *
 *   1. the TrackMenu bookmarks LIST view ("Your bookmarks for this
 *      song") — lazy-loaded, recordingKey-keyed, honest empty state;
 *   2. the honest empty-state words for both features ("NO MEMORY YET" /
 *      "NO BOOKMARKS YET");
 *   3. X7 — streamUrl is unrepresentable in BOTH new tables (the
 *      bookmarks module + the bookmarks SQL block join the stories law);
 *   4. the tap-to-JUMP seek path (the existing PlayerProvider seek — no
 *      second seek implementation, no new ledger write);
 *   5. X5 — zero cold-start cost (the boot file never touches the
 *      content tables);
 *   6. the release announces itself (SEEN_KEY + headline).
 *
 * All assertions are LITERALS — no constant is checked against itself.
 */

import { describe, expect, test } from 'bun:test';
import { bookmarkTimeLabel } from '../src/player/bookmarks';

describe('WAVE 1 · the bookmarks list view (TrackMenu, v5.1.0)', () => {
  const fs = require('fs');
  const menu = fs.readFileSync('src/components/TrackMenu.tsx', 'utf8');

  test('the list view exists, titled "Your bookmarks for this song"', () => {
    expect(menu).toContain('Your bookmarks for this song');
    expect(menu).toContain('bookmarks.list(');
    expect(menu).toContain('contentKeyOf'); // recordingKey-keyed, NOT trackId
  });

  test('the list loads LAZILY (potato rule ⑥) behind a stale-response guard', () => {
    // the rows load only when the listener opens the list — the loader
    // is the press handler, and a request-id drops stale responses
    expect(menu).toContain('openBookmarks');
    expect(menu).toContain('bmReqRef');
    expect(menu).toContain('const req = ++bmReqRef.current');
  });

  test('the empty state is honest — never fake filler rows', () => {
    expect(menu).toContain('NO BOOKMARKS YET');
    expect(menu).toContain("'no note'"); // an empty note says so, honestly
  });

  test('delete confirms against the store BEFORE the list updates', () => {
    expect(menu).toContain('removeBookmark');
    expect(menu).toContain('const ok = await tables.bookmarks.remove(id)');
    expect(menu).toContain('if (ok) setBmRows');
  });

  test('the m:ss row label is pure and literal (4:07 style)', () => {
    expect(bookmarkTimeLabel(65432)).toBe('1:05');
    expect(bookmarkTimeLabel(247000)).toBe('4:07');
    expect(bookmarkTimeLabel(0)).toBe('0:00');
    expect(bookmarkTimeLabel(-40)).toBe('0:00'); // clamps, never lies
    expect(bookmarkTimeLabel(59500)).toBe('1:00'); // rounds at the half
  });
});

describe('WAVE 1 · honest empty states (both features)', () => {
  const fs = require('fs');
  const menu = fs.readFileSync('src/components/TrackMenu.tsx', 'utf8');
  const player = fs.readFileSync('src/screens/PlayerScreen.tsx', 'utf8');

  test('the story editor says NO MEMORY YET instead of pretending', () => {
    expect(menu).toContain('NO MEMORY YET');
  });

  test('the player story line renders NOTHING when there is no story', () => {
    // a player is not the place to nag: the story block is a ternary on
    // the loaded story — no story, no pixels (never fake filler)
    expect(player).toContain('{story ? (');
    expect(player).toContain('song-story-line');
    expect(player).toContain('stories.getStory');
  });
});

describe('WAVE 1 · X7 — streamUrl is unrepresentable in BOTH new tables', () => {
  const fs = require('fs');

  test('bookmarks.ts carries no stream field (the stories law, joined)', () => {
    const src = fs.readFileSync('src/player/bookmarks.ts', 'utf8');
    expect(src).toContain('recordingKey: string');
    expect(src).toContain('positionMs: number');
    expect(src).not.toMatch(/streamUrl/i);
  });

  test('the bookmarks SQL block has exactly the five honest columns', () => {
    const src = fs.readFileSync('src/storage/appTables.ts', 'utf8');
    const m = src.match(/CREATE TABLE IF NOT EXISTS bookmarks \(([\s\S]*?)\);/);
    expect(m).not.toBeNull();
    const block = m![1];
    expect(block).toContain('id TEXT PRIMARY KEY');
    expect(block).toContain('recordingKey TEXT NOT NULL');
    expect(block).toContain('positionMs INTEGER NOT NULL');
    expect(block).toContain('note TEXT NOT NULL DEFAULT');
    expect(block).toContain('createdAt INTEGER NOT NULL');
    expect(block).not.toMatch(/streamUrl/i); // a transient handle, never persisted
  });
});

describe('WAVE 1 · the tap-to-JUMP path is the EXISTING seek', () => {
  const fs = require('fs');
  const player = fs.readFileSync('src/screens/PlayerScreen.tsx', 'utf8');

  test('a quick tap on a dot routes through onScrubEnd — the PlayerProvider seek', () => {
    expect(player).toContain('onScrubEnd(tapHit)'); // the jump commits as a scrub end
    expect(player).toContain('void seek(sec)'); // the ONE seek path (existing)
    expect(player).toContain("} from '../player/bookmarks'"); // the pure classifier is the arbiter
  });

  test('a bookmark verdict never seeks (the gesture was a save/delete)', () => {
    expect(player).toContain('onScrubCancel(); // the gesture was a bookmark op, never a seek');
  });
});

describe('WAVE 1 · X5 — zero cold-start cost', () => {
  test('the boot file never touches the content tables', () => {
    const fs = require('fs');
    const app = fs.readFileSync('App.tsx', 'utf8');
    expect(app).not.toContain('appTables');
    expect(app).not.toContain('songStories');
    expect(app).not.toContain('bookmarks');
  });
});

describe('WAVE 1 · the release announces itself', () => {
  const fs = require('fs');
  const dialog = fs.readFileSync('src/components/WhatsNewDialog.tsx', 'utf8');

  test('SEEN_KEY is the CURRENT release key (the bulletin shows once, then never again)', () => {
    // the ACTIVE key is the const line; the file also carries the
    // release-key history comment (v5_0_1 … v5_3_0) — history stays,
    // the const moves forward. (v5.3.0: reconciled when the bulletin
    // advanced to SPOTIFY RE INTELLIGENCE & AUDIO LIFT — the durable
    // concern is that the key names THIS release, never a previous one.)
    expect(dialog).toMatch(/const SEEN_KEY = 'tsf\.whatsNew\.v5_3_0'/);
    expect(dialog).not.toMatch(/const SEEN_KEY = 'tsf\.whatsNew\.v5_2_1'/);
  });

  test('the headline names THIS release', () => {
    expect(dialog).toContain('TSF MUSIC 5.3.0 — SPOTIFY RE INTELLIGENCE & AUDIO LIFT');
  });
});
