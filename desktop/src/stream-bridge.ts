/**
 * Progressive stream bridge (D12).
 *
 * The core emits nothing itself: ProviderModelGateway nodes deliver
 * `StreamEvent`s through InvokeOptions.onStreamEvent. This bridge is the
 * single owner of that fan-out. It exists only in main-process memory: no
 * event ever reaches a store, log, or file. Its purpose is to let the
 * renderer pull what arrived for one run, from a cursor, without rewriting
 * the engine.
 *
 * Isolation keying is by `runId`: two concurrent runs each get their own
 * envelope, never a shared buffer. A run's envelope is written in start →
 * events… → done|failed order only; appends after terminal state are
 * dropped, because a finished run must not appear to emit.
 */
import type { StreamEvent } from "../../src/execution/types.ts";

export interface AgentStreamEnvelope {
  /** Events received so far, oldest first. Slice it with `nextIndex`. */
  readonly events: readonly StreamEvent[];
  /** Terminal state reached, if any. */
  readonly state: "running" | "done" | "failed";
  /** Typed-code + safe message when the run died. Never the key, never the stream text. */
  readonly error?: { readonly code: string; readonly message: string };
}

export class AgentStreamBridge {
  private readonly runs = new Map<string, { events: StreamEvent[]; state: AgentStreamEnvelope["state"]; error?: AgentStreamEnvelope["error"] }>();

  start(runId: string): void {
    this.runs.set(runId, { events: [], state: "running" });
  }

  append(runId: string, event: StreamEvent): void {
    const run = this.runs.get(runId);
    if (!run || run.state !== "running") return;
    // Bound the buffer: never more than 2000 frames per run. Oldest text
    // deltas are already assembled elsewhere by the result anyway.
    if (run.events.length >= 2000) return;
    run.events.push(event);
  }

  done(runId: string): void {
    const run = this.runs.get(runId);
    if (run && run.state === "running") run.state = "done";
  }

  failed(runId: string, error: AgentStreamEnvelope["error"]): void {
    const run = this.runs.get(runId);
    if (run && run.state === "running") {
      run.state = "failed";
      run.error = error;
    }
  }

  /**
   * Events Since a cursor plus terminal marker. Callers advancing the cursor
   * every poll never re-read old frames; `nextIndex` tells them where they
   * were. The envelope is copy-on-read: the bridge releases its internal
   * references when the caller claims them.
   */
  getSince(runId: string, cursor: number): { readonly events: readonly StreamEvent[]; readonly state: AgentStreamEnvelope["state"]; readonly error?: AgentStreamEnvelope["error"]; readonly nextIndex: number } | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    const from = Math.max(0, Math.min(cursor, run.events.length));
    const events = run.events.slice(from);
    return { events, state: run.state, error: run.error, nextIndex: run.events.length };
  }

  /** Remove a run's envelope. The gateway may reuse the run id later. */
  release(runId: string): void {
    this.runs.delete(runId);
  }
}
