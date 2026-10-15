/**
 * BOUNDED MAP (v5.2.1 FIX-C2 + FIX-C3) — the tiny LRU the caches were
 * documented to have and didn't.
 *
 * THE BUG CLASS (forensic audit): lrclib.ts's originCache grew forever
 * while its doc claimed "LRU-30", and artists.ts's photoCache +
 * namePhotoCache grew forever — a long session leaks memory on the
 * potato phones this app targets.
 *
 * THE LAW: `cap` is a hard ceiling. A set() beyond it evicts the
 * LEAST-RECENTLY-USED entry (Map preserves insertion order; a get()
 * refreshes recency by re-inserting). Pure — no React, no RN, no
 * storage — locked in tests/fix_v521_waveC_locks.
 */
export class BoundedMap<K, V> {
  private map = new Map<K, V>();

  constructor(private readonly cap: number) {
    if (!Number.isInteger(cap) || cap < 1) throw new Error(`BoundedMap cap must be a positive integer, got ${cap}`);
  }

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      // refresh recency: delete + re-insert moves the key to the tail
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key); // re-set = newest recency
    this.map.set(key, value);
    while (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}
