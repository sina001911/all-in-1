/**
 * Log store (D1).
 *
 * A persisted `LogSink` implementation: the desktop keeps an append-only audit
 * trail. Redaction is the logger's responsibility (it redacts before emitting);
 * this store additionally never accepts a field named like a secret.
 */
import type { LogRecord, LogStore } from "./types.ts";
import { JsonlAppendStore } from "./json-store.ts";

const SUSPECT_KEY = /(?:key|token|secret|password|credential|auth)/i;

function stripSuspectFields(fields?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!fields) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SUSPECT_KEY.test(k)) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export class FileLogStore implements LogStore {
  private readonly store: JsonlAppendStore;

  constructor(store: JsonlAppendStore) {
    this.store = store;
  }

  append(entry: LogRecord): void {
    const line = JSON.stringify({
      ts: entry.ts,
      level: entry.level,
      msg: entry.msg,
      runId: entry.runId,
      fields: stripSuspectFields(entry.fields),
    });
    this.store.append(line);
  }

  list(since?: number): readonly LogRecord[] {
    return this.store
      .readAll()
      .map((line) => {
        try {
          return JSON.parse(line) as LogRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is LogRecord => r !== null)
      .filter((r) => since === undefined || r.ts >= since);
  }

  clear(): void {
    this.store.clear();
  }

  save(): void {
    /* append-only: already persisted */
  }
}

export class MemoryLogStore implements LogStore {
  private entries: LogRecord[] = [];

  append(entry: LogRecord): void {
    this.entries = [...this.entries, { ...entry, fields: stripSuspectFields(entry.fields) }];
  }
  list(since?: number): readonly LogRecord[] {
    return this.entries.filter((r) => since === undefined || r.ts >= since);
  }
  clear(): void {
    this.entries = [];
  }
  save(): void {
    /* in-memory: no-op */
  }
}
