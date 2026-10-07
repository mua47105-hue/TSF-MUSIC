/**
 * In-memory LedgerStore — web screenshot harness + Node/bun replay tests.
 *
 * Same export signature as storeSqlite.ts (createLedgerStore) so the metro
 * web redirect can swap the two without touching app code.
 */

import type { LedgerStore } from './store';
import type { LedgerEvent, ListenRecord, SessionRecord } from './types';
import type { HistoricalDay } from './historical';

class MemoryStore implements LedgerStore {
  private events: LedgerEvent[] = [];
  private listens: ListenRecord[] = [];
  private sessions = new Map<string, SessionRecord>();
  private kv = new Map<string, unknown>();
  /** F9 · historical_summary — the Time Machine's own table. */
  private historical = new Map<string, HistoricalDay>();

  async appendEvents(events: LedgerEvent[]): Promise<void> {
    this.events.push(...events);
    this.events.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
  }

  async getEvents(sinceTs?: number): Promise<LedgerEvent[]> {
    return sinceTs == null ? [...this.events] : this.events.filter((e) => e.ts >= sinceTs);
  }

  async countEvents(): Promise<number> {
    return this.events.length;
  }

  async deleteEventsBefore(cutoffTs: number): Promise<number> {
    const before = this.events.length;
    this.events = this.events.filter((e) => e.ts >= cutoffTs);
    return before - this.events.length;
  }

  async appendListen(record: ListenRecord): Promise<void> {
    this.listens.push(record);
    this.listens.sort((a, b) => a.startedTs - b.startedTs);
  }

  async getlistens(sinceTs?: number): Promise<ListenRecord[]> {
    return sinceTs == null ? [...this.listens] : this.listens.filter((l) => l.startedTs >= sinceTs);
  }

  async deleteListensBefore(cutoffTs: number): Promise<number> {
    const before = this.listens.length;
    this.listens = this.listens.filter((l) => l.startedTs >= cutoffTs);
    return before - this.listens.length;
  }

  async upsertSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async getSessions(sinceTs?: number): Promise<SessionRecord[]> {
    const all = [...this.sessions.values()].sort((a, b) => a.startTs - b.startTs);
    return sinceTs == null ? all : all.filter((s) => s.startTs >= sinceTs);
  }

  async getKV<T>(key: string): Promise<T | null> {
    return (this.kv.get(key) as T) ?? null;
  }

  async setKV<T>(key: string, value: T): Promise<void> {
    this.kv.set(key, value);
  }

  // ── F9 · historical_summary ──────────────────────────────────────────

  async upsertHistoricalDay(day: HistoricalDay): Promise<void> {
    this.historical.set(day.dayKey, { ...day });
  }

  async getHistoricalDays(sinceTs?: number): Promise<HistoricalDay[]> {
    const all = [...this.historical.values()].sort((a, b) => a.dayStartTs - b.dayStartTs);
    return sinceTs == null ? all : all.filter((d) => d.dayStartTs >= sinceTs);
  }

  async deleteHistoricalDaysBefore(cutoffTs: number): Promise<number> {
    let removed = 0;
    for (const [key, day] of this.historical) {
      if (day.dayStartTs < cutoffTs) {
        this.historical.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}

export async function createLedgerStore(): Promise<LedgerStore> {
  return new MemoryStore();
}
