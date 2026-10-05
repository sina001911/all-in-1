/**
 * Desktop cancellation hub (D1).
 *
 * This does NOT introduce a second cancellation mechanism. The core already
 * supports `AbortSignal` end-to-end:
 *
 *   WorkflowRequest.signal (src/workflow/loop.ts) -> InvokeOptions.signal
 *   (src/execution/engine.ts) -> raceInvocation() -> PROVIDER_CANCELLED, with
 *   the budget reservation released in the catch block.
 *
 * This module only owns the desktop-level `AbortController` per run and hands
 * its `signal` to the existing plumbing. One mechanism, one owner.
 */
export class CancellationHub {
  private readonly controllers = new Map<string, AbortController>();

  /** Register a run id and return the signal the core should be given. */
  signalFor(runId: string): AbortSignal {
    let controller = this.controllers.get(runId);
    if (!controller) {
      controller = new AbortController();
      this.controllers.set(runId, controller);
    }
    return controller.signal;
  }

  /** Abort a running run. Returns true when a controller existed. */
  cancel(runId: string): boolean {
    const controller = this.controllers.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** Forget a finished/failed run so its controller can be collected. */
  release(runId: string): void {
    this.controllers.delete(runId);
  }

  /** True when the run's controller exists and has been aborted. */
  isCancelled(runId: string): boolean {
    return this.controllers.get(runId)?.signal.aborted ?? false;
  }

  /** Abort everything; used on shutdown. */
  cancelAll(): void {
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    this.controllers.clear();
  }
}
