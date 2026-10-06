/**
 * Baked-table key shapes — the RUNTIME half of the bake contract.
 *
 * The Python bake script (scripts/bake_features.py) ports
 * src/search/normalize.ts (normalizeQuery + clusterKey) VERBATIM and
 * emits keys with these exact shapes. This module builds the same keys
 * from the SAME source functions, so runtime and baked data can never
 * drift — and the lock test pins parity with fixtures.
 *
 *   recordingKey    = normalizeQuery(title) + '|' + normalizeQuery(primaryArtist)
 *   titleKey        = normalizeQuery(title)
 *   clusterTitleKey = clusterKey(title)   (decoration-stripped)
 */

import { clusterKey, normalizeQuery } from '../../search/normalize';

export function recordingKeyOf(title: string, primaryArtist: string): string {
  const t = normalizeQuery(String(title ?? ''));
  const a = normalizeQuery(String(primaryArtist ?? ''));
  if (!t || !a) return '';
  return `${t}|${a}`;
}

export function titleKeyOf(title: string): string {
  return normalizeQuery(String(title ?? ''));
}

export function clusterTitleKeyOf(title: string): string {
  return clusterKey(String(title ?? ''));
}
