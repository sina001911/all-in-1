/**
 * Structured logger. Emits JSONL lines. Applies redaction *before* any emit,
 * so a secret can never reach a sink even if a caller passes one by mistake.
 */
import { redact } from "./redact.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  readonly ts: number;
  readonly level: LogLevel;
  readonly msg: string;
  readonly fields?: Record<string, unknown>;
}

export interface LogSink {
  write(line: string): void;
}

export class Logger {
  private readonly sink: LogSink;
  private readonly runId: string;
  constructor(sink: LogSink, runId: string) {
    this.sink = sink;
    this.runId = runId;
  }

  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    const entry: LogEntry = {
      ts: Date.now(),
      level,
      msg: redact(msg),
      fields: fields ? redactFields(fields) : undefined,
    };
    this.sink.write(JSON.stringify({ runId: this.runId, ...entry }));
  }

  info(msg: string, fields?: Record<string, unknown>): void {
    this.log("info", msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.log("warn", msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.log("error", msg, fields);
  }
  debug(msg: string, fields?: Record<string, unknown>): void {
    this.log("debug", msg, fields);
  }
}

function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[redact(k)] = typeof v === "string" ? redact(v) : v;
  }
  return out;
}

/** In-memory sink used by tests and by tooling that must not touch disk. */
export class MemorySink implements LogSink {
  readonly lines: string[] = [];
  write(line: string): void {
    this.lines.push(line);
  }
}
