/**
 * PERSONAL NOTES SEARCH CORE (Wave C · C2) — the pure machinery behind
 * full-text search over the user's own words (Song Stories F6, Memory
 * Tags F20). No React, no RN, no network.
 *
 * ARCHITECTURE: the search INDEX is an interface (NotesIndex) with two
 * backends:
 *   • native  — FTS5 virtual table `personal_notes_fts` (appTables.ts;
 *     expo-sqlite ships with -DSQLITE_ENABLE_FTS5=1) with an honest
 *     LIKE-based fallback should FTS5 ever be unavailable;
 *   • memory  — the in-memory twin (webmock parity, house rule ⑮; also
 *     the lock-test backend).
 * The DECORATORS (createIndexedStories / createIndexedMemoryTags) wrap
 * a store adapter so EVERY write path — user save, service LRU
 * eviction, future migrations — keeps the index in sync for free.
 *
 * SEARCH CONTRACT (THE BAR): a query matches against the note text AND
 * the recording key (title|artist identity) — searching "Goa" finds the
 * tag "Tagged this moment in Goa"; searching "heartbreak" finds a story
 * attached to a track whose recording identity carries the word. The
 * results carry the recordingKey so the UI can resolve + play the track.
 *
 * POTATO BUDGET (X6): FTS5 is an index (bm25-ranked, <10ms for <1000
 * notes); the memory backend is a linear scan over a capped table
 * (STORIES.cap 1000 + MEMORY_TAGS.cap 500 rows max — trivial).
 */

import type { SongStoriesStore, SongStory } from './songStories';
import type { MemoryTagsStore, MemoryTag } from './memoryTags';

export type NoteSource = 'story' | 'memory_tag';

/** One indexed note: the identity + the words. */
export interface NoteEntry {
  /** Unique index key: `story:<recordingKey>` or `tag:<memoryTagId>`. */
  entryKey: string;
  recordingKey: string;
  text: string;
  source: NoteSource;
}

/** A search hit: the note + a display snippet. */
export interface PersonalNoteHit {
  entryKey: string;
  recordingKey: string;
  text: string;
  source: NoteSource;
  /** The matched context (the UI shows this under the track name). */
  snippet: string;
}

/** The backend-agnostic index every note write must keep in sync. */
export interface NotesIndex {
  upsert(entry: NoteEntry): Promise<void>;
  remove(entryKey: string): Promise<void>;
  search(query: string, limit?: number): Promise<PersonalNoteHit[]>;
  count(): Promise<number>;
}

/** Below this many characters a query is noise — no notes section. */
export const MIN_NOTE_QUERY_CHARS = 3;

/** The one place index keys are built (story:<key> / tag:<id>). */
export function noteEntryKey(source: NoteSource, id: string): string {
  return `${source === 'story' ? 'story' : 'tag'}:${id}`;
}

/** Extract the searchable lowercase tokens of a query. */
function tokensOf(query: string): string[] {
  return String(query ?? '')
    .toLowerCase()
    .match(/[a-z0-9\u0900-\u097f]+/g) ?? [];
}

/**
 * Sanitize a user query into an FTS5 MATCH expression: each token
 * becomes a quoted prefix term (`"goa"*`), tokens AND together
 * (whitespace in FTS5 = implicit AND). Quotes/operators in user input
 * are neutralized by the quoting. Returns null when the query carries
 * no usable tokens.
 */
export function ftsQueryFor(query: string): string | null {
  const tokens = tokensOf(query);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t}"*`).join(' ');
}

/** Build a display snippet around the first token hit in the text. */
export function snippetFor(text: string, query: string, radius = 34): string {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= radius * 2) return clean;
  const lower = clean.toLowerCase();
  let at = -1;
  for (const tok of tokensOf(query)) {
    const i = lower.indexOf(tok);
    if (i >= 0 && (at === -1 || i < at)) at = i;
  }
  if (at < 0) return clean.slice(0, radius * 2);
  const from = Math.max(0, at - radius);
  const to = Math.min(clean.length, at + radius);
  return `${from > 0 ? '…' : ''}${clean.slice(from, to)}${to < clean.length ? '…' : ''}`;
}

/** Every token must appear somewhere in the haystack (text OR key). */
function memoryMatch(entry: NoteEntry, tokens: string[]): boolean {
  const hay = `${entry.text}\n${entry.recordingKey}`.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

/** The in-memory twin (webmock parity + lock tests). */
export function createMemoryNotesIndex(): NotesIndex {
  const entries = new Map<string, NoteEntry>();
  return {
    async upsert(entry) {
      entries.set(entry.entryKey, { ...entry });
    },
    async remove(entryKey) {
      entries.delete(entryKey);
    },
    async search(query, limit = 8) {
      const tokens = tokensOf(query);
      if (tokens.length < 1 || String(query ?? '').trim().length < MIN_NOTE_QUERY_CHARS) return [];
      const hits: PersonalNoteHit[] = [];
      for (const e of entries.values()) {
        if (!memoryMatch(e, tokens)) continue;
        hits.push({
          entryKey: e.entryKey,
          recordingKey: e.recordingKey,
          text: e.text,
          source: e.source,
          snippet: snippetFor(e.text, query),
        });
        if (hits.length >= limit) break;
      }
      return hits;
    },
    async count() {
      return entries.size;
    },
  };
}

/**
 * Wrap a SongStoriesStore so every upsert/delete also maintains the
 * index — INCLUDING the service's LRU evictions, which call the same
 * store methods. The index write is awaited (the sync IS the feature);
 * a failed index write never loses the user's story (store first,
 * index second, index errors swallowed honestly).
 */
export function createIndexedStories(store: SongStoriesStore, index: NotesIndex): SongStoriesStore {
  return {
    async getStory(key) {
      return store.getStory(key);
    },
    async upsertStory(story: SongStory) {
      await store.upsertStory(story);
      try {
        await index.upsert({
          entryKey: noteEntryKey('story', story.recordingKey),
          recordingKey: story.recordingKey,
          text: story.text,
          source: 'story',
        });
      } catch {
        /* the row is saved; the index degrades honestly */
      }
    },
    async deleteStory(key) {
      await store.deleteStory(key);
      try {
        await index.remove(noteEntryKey('story', key));
      } catch {
        /* the row is gone; a stale index row degrades honestly */
      }
    },
    async allStories() {
      return store.allStories();
    },
  };
}

/** The MemoryTagsStore twin: only non-blank notes are indexed. */
export function createIndexedMemoryTags(store: MemoryTagsStore, index: NotesIndex): MemoryTagsStore {
  return {
    async get(id) {
      return store.get(id);
    },
    async all() {
      return store.all();
    },
    async put(tag: MemoryTag) {
      await store.put(tag);
      try {
        const key = noteEntryKey('memory_tag', tag.id);
        if (String(tag.note ?? '').trim()) {
          await index.upsert({
            entryKey: key,
            recordingKey: tag.recordingKey,
            text: tag.note,
            source: 'memory_tag',
          });
        } else {
          await index.remove(key);
        }
      } catch {
        /* the row is saved; the index degrades honestly */
      }
    },
    async del(id) {
      await store.del(id);
      try {
        await index.remove(noteEntryKey('memory_tag', id));
      } catch {
        /* the row is gone; a stale index row degrades honestly */
      }
    },
  };
}
