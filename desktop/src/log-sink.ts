/**
 * A core `LogSink` that feeds the desktop log store (D1).
 *
 * The core `Logger` redacts before it emits, and this sink re-shapes each
 * JSONL line into a persisted `LogRecord`. Double duty: the audit trail stays
 * on disk and the redaction guarantee stays the logger's, not the store's.
 */
import type { LogSink } from "../../src/log/logger.ts";
import type { LogRecord, LogStore } from "./persistence/types.ts";

export class LogStoreSink implements LogSink {
  private readonly store: LogStore;

  constructor(store: LogStore) {
    this.store = store;
  }

  write(line: string): void {
    try {
      const parsed = JSON.parse(line) as {
        runId?: string;
        ts?: number;
        level?: string;
        msg?: string;
        fields?: Record<string, unknown>;
      };
      const record: LogRecord = {
        ts: parsed.ts ?? Date.now(),
        level: parsed.level ?? "info",
        msg: parsed.msg ?? "",
        runId: parsed.runId,
        fields: parsed.fields,
      };
      this.store.append(record);
    } catch {
      // An unparseable line is dropped rather than allowed to corrupt the trail.
    }
  }
}
