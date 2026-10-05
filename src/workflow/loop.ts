/**
 * Workflow orchestration (P5) — the human-in-the-loop loop.
 *
 * Wires the frozen `safety/guard.ts` rules (which P1 declared and nothing ever
 * called) into a real, bounded loop over specialist steps:
 *
 *   - INSPECT may analyze. SUGGEST may analyze and plan. BUILD may iterate too.
 *   - `--auto` is an explicit per-run opt-in and stays bounded by every hard
 *     limit: maxIterations (5), maxEdits (20), dry-run-first.
 *   - Escalation pauses the loop for the human even under `--auto`; it never
 *     yields autonomy unconditionally.
 *
 * P5 performs NO file writes, by construction. The loop has no filesystem
 * capability and no edit action; the only file writers are the OpenCode tools
 * bound in P6. A `--auto` dry-run-first requirement is therefore vacuously
 * satisfied in P5 (edits never occur), and this is stated rather than assumed.
 *
 * Every step runs through the specialist runner, hence through the P4 engine,
 * hence through every security gate. The workflow is subordinate to those
 * gates: it never retries past an egress, approval, or budget refusal.
 */
import type { SpecialistRequest, SpecialistResponse } from "../specialists/types.ts";
import type { SpecialistRunner } from "../specialists/runner.ts";
import type { ModelRole } from "../registry/roles.ts";
import {
  DEFAULT_AUTO_OPTIONS,
  MODE_PERMISSIONS,
  assertAutoBounds,
  assertCanAnalyze,
  assertCanPlan,
  mustPauseForHuman,
  type AutoOptions,
  type IterationState,
  type SafetyMode,
} from "../safety/guard.ts";
import { AllInOneError } from "../errors.ts";

export interface WorkflowRequest {
  readonly mode: SafetyMode;
  /**
   * Explicit opt-in to autonomous iteration. Never a default; when absent the
   * loop pauses for the human after every step.
   */
  readonly auto?: Partial<AutoOptions>;
  readonly steps: ReadonlyArray<SpecialistRequest>;
  /** Produce a plan summary. Requires plan permission (SUGGEST or BUILD). */
  readonly plan?: boolean;
  /** Abort the whole workflow. Stops with WORKFLOW_CANCELLED. */
  readonly signal?: AbortSignal;
  /** Per-step invocation timeout, forwarded to the engine. */
  readonly timeoutMs?: number;
}

export interface StepResult {
  readonly role: ModelRole;
  readonly response: SpecialistResponse;
}

export interface WorkflowResult {
  readonly ok: boolean;
  readonly mode: SafetyMode;
  readonly auto: boolean;
  readonly iterations: number;
  /** True when the loop stopped to wait for a human decision (not a failure). */
  readonly pausedForHuman: boolean;
  readonly escalated: boolean;
  readonly results: readonly StepResult[];
  readonly plan: readonly string[] | null;
  readonly error?: { readonly code: string; readonly message: string; readonly retryable: boolean };
}

const MAX_ITERATIONS = 5;

export class WorkflowLoop {
  private readonly runner: SpecialistRunner;
  private readonly request: WorkflowRequest;
  private readonly auto: MutableAutoOptions;
  private readonly state: MutableIterationState;
  private results: StepResult[] = [];
  private cursor = 0;
  private done = false;

  constructor(opts: { runner: SpecialistRunner; request: WorkflowRequest }) {
    this.runner = opts.runner;
    this.request = opts.request;
    // Local mutable copies; the frozen guard types are read-only, and the
    // caller's options must never be mutated by the loop.
    this.auto = {
      auto: opts.request.auto?.auto ?? DEFAULT_AUTO_OPTIONS.auto,
      // The frozen guard caps autonomy; a caller cannot raise the ceiling.
      maxIterations: Math.min(
        opts.request.auto?.maxIterations ?? DEFAULT_AUTO_OPTIONS.maxIterations,
        MAX_ITERATIONS,
      ),
      maxEdits: opts.request.auto?.maxEdits ?? DEFAULT_AUTO_OPTIONS.maxEdits,
      dryRunFirst: opts.request.auto?.dryRunFirst ?? DEFAULT_AUTO_OPTIONS.dryRunFirst,
    };
    this.state = {
      iteration: 0,
      edits: 0,
      dryRunCompleted: false,
      escalated: false,
    };
  }
  /**
   * Run as far as the mode and bounds permit. Under `--auto` this consumes all
   * steps; otherwise it runs exactly one step and pauses for the human. Calling
   * `run` again on the same loop continues from where it paused.
   */
  async run(): Promise<WorkflowResult> {
    if (this.done) return this.toResult(true);

    // Mode enforcement, up front: analyze is required by every step, plan by a
    // plan request. An edit permission is intentionally NOT asserted here: P5
    // has no edit action, so asserting it would wrongly refuse INSPECT and
    // SUGGEST. Edits arrive with the OpenCode tool binding in P6, and that
    // binding will assert `assertCanEdit` at the point a write is requested.
    try {
      assertCanAnalyze(this.request.mode);
      if (this.request.plan) assertCanPlan(this.request.mode);
    } catch (e) {
      return this.toResult(false, toError(e));
    }

    while (this.cursor < this.request.steps.length) {
      // Cancellation is honoured between steps.
      if (this.request.signal?.aborted) {
        return this.toResult(false, {
          code: "WORKFLOW_CANCELLED",
          message: "workflow cancelled by the caller",
          retryable: false,
        });
      }

      // Autonomy bounds between iterations. Under `--auto` this enforces the
      // hard iteration cap; the guard's own escalation rule
      // (`mustPauseForHuman`) then decides whether the loop must stop for a
      // human regardless of the caller's wishes. Without `--auto` the loop
      // pauses after each step instead (see the end of the loop body).
      if (this.cursor > 0 && this.auto.auto) {
        this.state.iteration = this.cursor;
        try {
          assertAutoBounds(this.auto, this.state);
        } catch (e) {
          return this.toResult(false, toError(e));
        }
        if (mustPauseForHuman(this.auto, this.state)) {
          return this.toResult(false, {
            code: "WORKFLOW_ESCALATED",
            message: "workflow escalated; human intervention required before continuing",
            retryable: false,
          });
        }
      }

      const step = this.request.steps[this.cursor] as SpecialistRequest;
      let response: SpecialistResponse;
      try {
        response = await this.runner.run(step, {
          timeoutMs: this.request.timeoutMs,
          signal: this.request.signal,
        });
      } catch (e) {
        // The runner converts engine failures into a SpecialistResponse; a
        // throw here is an unexpected caller bug (e.g. an invalid schema).
        return this.toResult(false, toError(e));
      }

      this.results.push({ role: step.role, response });
      this.cursor += 1;

      if (!response.ok) {
        if (response.error.retryable) {
          // A retryable failure escalates: the human decides whether to retry.
          this.state.escalated = true;
          return this.toResult(false, {
            code: "WORKFLOW_ESCALATED",
            message: `step ${this.cursor} failed in a retryable way (${response.error.code}); human intervention required`,
            retryable: true,
          });
        }
        return this.toResult(false, response.error);
      }

      // Without autonomy, a human turn ends here — successfully so far —
      // unless that was the final step, in which case the workflow is done.
      // The next call to run() continues from the following step.
      if (!this.auto.auto && this.cursor < this.request.steps.length) {
        return this.toResult(true, undefined, true);
      }
    }

    this.done = true;
    return this.toResult(true);
  }

  private toResult(
    ok: boolean,
    error?: { code: string; message: string; retryable: boolean },
    pausedForHuman = false,
  ): WorkflowResult {
    return {
      ok,
      mode: this.request.mode,
      auto: this.auto.auto,
      iterations: this.cursor,
      pausedForHuman,
      escalated: this.state.escalated,
      results: [...this.results],
      plan: this.request.plan ? buildPlan(this.results) : null,
      error,
    };
  }
}

function toError(e: unknown): { code: string; message: string; retryable: boolean } {
  const err = e as AllInOneError & { action?: string };
  if (err instanceof Error && err.name === "ModeViolationError") {
    return {
      code: "MODE_VIOLATION",
      message: err.message,
      retryable: false,
    };
  }
  if (err instanceof Error && /--auto hard limit reached/.test(err.message)) {
    return { code: "WORKFLOW_AUTO_LIMIT", message: err.message, retryable: false };
  }
  return {
    code: err.code ?? "WORKFLOW_AUTO_LIMIT",
    message: err.message,
    retryable: err.retryable ?? false,
  };
}

/** Derive a readable plan from validated structured outputs, if any. */
function buildPlan(results: readonly StepResult[]): string[] {
  const lines: string[] = [];
  for (const r of results) {
    if (!r.response.ok) continue;
    const structured = r.response.structured as Record<string, unknown> | null;
    const summary =
      structured && typeof structured === "object" && "summary" in structured
        ? String(structured.summary)
        : "analysis completed";
    lines.push(`- [${r.role}] ${summary}`);
  }
  return lines;
}

export const WORKFLOW_MAX_ITERATIONS = MAX_ITERATIONS;
export { MODE_PERMISSIONS };

/**
 * Mutable counterparts of the frozen guard types. The frozen `AutoOptions` and
 * `IterationState` are read-only by contract, but a loop must advance its own
 * counters. These are private to this module and are passed to the frozen guard
 * unchanged, since a mutable object is assignable to a read-only one.
 */
interface MutableAutoOptions {
  auto: boolean;
  maxIterations: number;
  maxEdits: number;
  dryRunFirst: boolean;
}

interface MutableIterationState {
  iteration: number;
  edits: number;
  dryRunCompleted: boolean;
  escalated: boolean;
}
