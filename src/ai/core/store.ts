/**
 * Ledger storage contract — a DOMAIN interface, not SQL.
 *
 * Two implementations exist:
 *   • storeSqlite.ts  — expo-sqlite, the canonical on-device store (Android)
 *   • storeMemory.ts  — pure JS structures (web harness, replay tests)
 *
 * Both export `createLedgerStore(): Promise<LedgerStore>` with identical
 * signatures, so metro.config.js can redirect one to the other for the web
 * screenshot harness (the same trick the saavn API mocks use).
 *
 * Tables (conceptual, §5.4):
 *   events   — append-only raw ledger, 90-day retention
 *   listens  — ListenRecords (graded evidence, kept with sessions 180d)
 *   sessions — session records, 180-day retention
 *   kv       — profile snapshots + caches (aggregates kept forever)
 */

import type { LedgerEvent, ListenRecord, SessionRecord } from './types';
import type { HistoricalDay } from './historical';

export interface LedgerStore {
  /** Append raw events (batched by the ledger's write chain). */
  appendEvents(events: LedgerEvent[]): Promise<void>;
  /** Raw events in [sinceTs, ∞), oldest first. */
  getEvents(sinceTs?: number): Promise<LedgerEvent[]>;
  /** Count of raw events — cheap probe for compaction checks. */
  countEvents(): Promise<number>;
  /** Delete raw events older than the cutoff, returning the count removed. */
  deleteEventsBefore(cutoffTs: number): Promise<number>;

  appendListen(record: ListenRecord): Promise<void>;
  /** ListenRecords in [sinceTs, ∞), oldest first. */
  getlistens(sinceTs?: number): Promise<ListenRecord[]>;
  /** Retention: drop graded listens older than cutoff (aggregates live in kv). */
  deleteListensBefore(cutoffTs: number): Promise<number>;

  upsertSession(session: SessionRecord): Promise<void>;
  getSessions(sinceTs?: number): Promise<SessionRecord[]>;

  getKV<T>(key: string): Promise<T | null>;
  setKV<T>(key: string, value: T): Promise<void>;

  // ── F9 · historical_summary (OPTIONAL methods) ────────────────────────
  // The Time Machine's own table. These are ADDITIVE to the contract:
  // the events/listens/sessions tables and their behaviors are untouched
  // (sacred-ground law L1). Implementations that predate F9 simply omit
  // them and the ledger skips the fold (honest degradation).

  /** Upsert one day summary (keyed by dayKey). */
  upsertHistoricalDay?(day: HistoricalDay): Promise<void>;
  /** Day summaries with dayStartTs ≥ sinceTs, oldest first. */
  getHistoricalDays?(sinceTs?: number): Promise<HistoricalDay[]>;
  /** Retention: drop summaries older than the cutoff, return count removed. */
  deleteHistoricalDaysBefore?(cutoffTs: number): Promise<number>;

  /** Close + (for sqlite) checkpoint. Safe to call repeatedly. */
  close(): Promise<void>;
}
