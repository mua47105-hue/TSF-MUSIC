/**
 * Track source chip label — the pure (no-RN) half of Brutal's SourceBadge.
 *
 * YT / PREVIEW / SAVED carry real information (a different engine, a 30s
 * clip, a local file). The default SAAVN chip carried none — the
 * user-reported P-B fix (v4.0.4): a trending wall of 14 identical "SAAVN"
 * stamps is branding noise, so the default source renders NO chip at all.
 * Lives in its own module so locks can import it without pulling
 * react-native into bun tests.
 */
export function sourceBadgeLabel(source?: string): string | null {
  if (!source) return null;
  if (source === 'youtube') return 'YT';
  if (source === 'itunes') return 'PREVIEW';
  if (source === 'local') return 'SAVED';
  return null; // 'saavn' and anything else — no stamp
}
