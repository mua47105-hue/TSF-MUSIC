/**
 * WEB MOCK of src/api/lrclib.ts — fixture lyrics for the device lab's
 * lyric-verification checkpoints (S1/S2 bars). Metro redirects this
 * only for platform=web.
 */

const FIXTURE_LYRICS: Record<string, string> = {
  'mashooqa|pritam, shilpa rao':
    'Mashooqa mashooqa\nTu mera mashooqa\nRaat bhar jaage hum\nSehme sehme lage hum\nTeri baaton mein kho gaye\nSubah hone na paayi\nMashooqa mashooqa\nTu mera mashooqa',
  'tum hi ho|mithoon':
    'Hum tere bin ab reh nahi sakte\nTere bina kya wajood mera\nTujhse juda gar ho jaayenge\nToh khud se hi ho jaayenge judaa\nChahun tujhe sanam meri jaan\nFida karu main tera aitam\nKabhi sochu tujhe jab yaad\nMain paaun sukoon sa javidaan',
  'tum hi ho|arijit singh':
    'Hum tere bin ab reh nahi sakte\nTere bina kya wajood mera\nTujhse juda gar ho jaayenge\nToh khud se hi ho jaayenge judaa',
  'apna bana le|arijit singh':
    'Tere bina jiya jaaye na\nApna bana le\nMujhe apna bana le\nHaan tujhe main chunun\nYa tu mujhe chune',
};

/** Deterministic LRC: 3.2s per line — the lab's sing-along timeline. */
function toSyncedLrc(plain: string): string {
  return plain
    .split('\n')
    .map((line, i) => {
      const t = i * 3.2;
      const mm = String(Math.floor(t / 60)).padStart(2, '0');
      const ss = (t % 60).toFixed(2).padStart(5, '0');
      return `[${mm}:${ss}]${line}`;
    })
    .join('\n');
}

/**
 * Webmock of the RAW synced lookup (Task 29): fixture titles return a
 * deterministic LRC timeline, everything else null (honest miss — the
 * real client's contract). The demo boot track ('Mashooqa') is covered
 * so the web lab can drive the karaoke card end-to-end.
 */
export function fetchSyncedLyrics(
  title: string,
  artist: string,
  _signal?: AbortSignal,
): Promise<string | null> {
  const t = title.toLowerCase().trim();
  const a = artist.toLowerCase().trim();
  const direct = FIXTURE_LYRICS[`${t}|${a}`];
  if (direct) {
    return new Promise((resolve) => setTimeout(() => resolve(toSyncedLrc(direct)), 150));
  }
  for (const key of Object.keys(FIXTURE_LYRICS)) {
    const [kt] = key.split('|');
    if (kt === t) {
      return new Promise((resolve) => setTimeout(() => resolve(toSyncedLrc(FIXTURE_LYRICS[key])), 150));
    }
  }
  return Promise.resolve(null);
}

export function fetchPlainLyrics(
  title: string,
  artist: string,
  _signal?: AbortSignal,
): Promise<string | null> {
  const t = title.toLowerCase().trim();
  const a = artist.toLowerCase().trim();
  const direct = FIXTURE_LYRICS[`${t}|${a}`];
  if (direct) {
    return new Promise((resolve) => setTimeout(() => resolve(direct), 150));
  }
  // partial-key fallback (any artist match on the title)
  for (const key of Object.keys(FIXTURE_LYRICS)) {
    const [kt] = key.split('|');
    if (kt === t) {
      const lyrics = FIXTURE_LYRICS[key];
      return new Promise((resolve) => setTimeout(() => resolve(lyrics), 150));
    }
  }
  return Promise.resolve(null);
}

export interface LyricOrigin {
  title: string;
  artist: string;
  line: string;
}

const FRAGMENTS: Array<{ match: RegExp; origin: LyricOrigin }> = [
  {
    match: /tere bin.*(reh|rah).*nahi|hum tere bin/,
    origin: {
      title: 'Tum Hi Ho',
      artist: 'Arijit Singh',
      line: 'Hum tere bin ab reh nahi sakte',
    },
  },
];

/** Webmock of the S1 fragment resolver — deterministic for the lab. */
export function searchLyricByFragment(
  fragment: string,
  _signal?: AbortSignal,
): Promise<LyricOrigin | null> {
  const f = fragment.toLowerCase();
  for (const { match, origin } of FRAGMENTS) {
    if (match.test(f)) {
      return new Promise((resolve) => setTimeout(() => resolve(origin), 150));
    }
  }
  return Promise.resolve(null);
}
