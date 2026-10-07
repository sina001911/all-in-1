/**
 * The agent loop (D3).
 *
 * One turn at a time, the model is asked what it wants; every want is routed
 * through the D2 executor, which alone decides whether it happens. The loop's
 * own powers are deliberately narrow:
 *
 *   - it may show the model the tools the safety mode permits (visibility);
 *   - it may pass the model's request to the executor, attaching the run's
 *     abort signal and the model's justification for the audit;
 *   - it may feed the settled result back to the model.
 *
 * It may NOT approve anything. It holds no approver — only an executor — so
 * there is no code path here by which a tool call is satisfied by the model's
 * own say-so. The justification the model writes is shown to the human and
 * recorded in the audit; it is never evaluated as consent.
 *
 * Bounds reuse the frozen `safety/guard.ts`: the mode gate up front, the
 * `--auto` iteration/edit caps and dry-run-first rule, and escalation, which
 * pauses even under `--auto`. Without `--auto` the loop runs ONE turn and
 * pauses; the caller continues it by calling `run` again with the same runId,
 * and may steer it with a new prompt.
 */
import type {
  AgentRequest,
  AgentResult,
  GatewayTurnRequest,
  ModelGateway,
  ToolCall,
  ToolCallOutcome,
  TurnEvent,
} from "./types.ts";
import type { ToolExecutor } from "../tools/executor.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolPermissionPolicy } from "../tools/permissions.ts";
import type { ToolSchema } from "../tools/types.ts";
import type { ToolResult } from "../tools/types.ts";
import { toolsVisibleInMode, isPrivilegedInMode } from "./visibility.ts";
import {
  DEFAULT_AUTO_OPTIONS,
  assertAutoBounds,
  assertCanAnalyze,
  mustPauseForHuman,
  type AutoOptions,
  type SafetyMode,
} from "../safety/guard.ts";

/** A hard ceiling no agent run may exceed, matching the frozen guard's spirit. */
const MAX_AGENT_TURNS = 8;
/** Bound on what one tool result contributes to the model's context. */
const EXCERPT_MAX = 2000;

export interface AgentRuntimeOptions {
  readonly gateway: ModelGateway;
  readonly executor: ToolExecutor;
  readonly registry: ToolRegistry;
  readonly policy: ToolPermissionPolicy;
}

interface RunState {
  readonly request: AgentRequest;
  readonly auto: AutoOptions;
  readonly state: MutableIterationState;
  readonly visible: readonly ToolSchema[];
  readonly history: TurnEvent[];
  readonly outcomes: ToolCallOutcome[];
  /** The CURRENT instruction, refreshed on every `run` call. */
  prompt: string;
  /** Turns fully completed. */
  turn: number;
  done: boolean;
  text: string;
}

export class AgentRuntime {
  private readonly opts: AgentRuntimeOptions;
  /** Resumable runs, keyed by runId. Dropped on completion or cancellation. */
  private readonly runs = new Map<string, RunState>();

  constructor(opts: AgentRuntimeOptions) {
    this.opts = opts;
  }

  /**
   * Run as far as the bounds permit in one call. Under `--auto` that is the
   * whole run; otherwise a single turn, after which the loop pauses for the
   * human and this method returns. Call again with the same `runId` to
   * continue; a fresh `prompt` on a continuation steers the run.
   */
  async run(request: AgentRequest): Promise<AgentResult> {
    // 1. MODE GATE — every turn is at least an analysis, so this is the
    //    precondition for the whole run, not just its first step.
    try {
      assertCanAnalyze(request.mode);
    } catch (e) {
      return this.fail(request, toError(e), request.mode);
    }

    let run: RunState | null | undefined = this.runs.get(request.runId);
    if (!run) {
      run = this.openRun(request);
      if (!run) {
        // No tools are visible in this mode: the model has nothing to call and
        // the run cannot do anything but talk. That is a configuration error,
        // surfaced rather than silently ignored.
        const error = {
          code: "MODE_VIOLATION",
          message: `mode ${request.mode} permits no tools for the agent loop`,
          retryable: false,
        };
        return this.fail(request, error, request.mode);
      }
      this.runs.set(request.runId, run);
    } else {
      // A continuation: the caller's prompt becomes the current instruction.
      run.prompt = request.prompt;
    }
    // NOTE: the prompt is NOT pushed into history. It is the CURRENT
    // instruction, handed to the gateway on this turn via `request.prompt`;
    // history records only what the model and the tools have already done, so
    // a continuation steers the run without being mistaken for a past turn.

    return this.advance(run);
  }

  private openRun(request: AgentRequest): RunState | null {
    const auto: AutoOptions = {
      auto: request.auto?.auto ?? DEFAULT_AUTO_OPTIONS.auto,
      // The frozen guard caps autonomy; a caller cannot raise the ceiling.
      maxIterations: Math.min(
        request.auto?.maxIterations ?? DEFAULT_AUTO_OPTIONS.maxIterations,
        MAX_AGENT_TURNS,
      ),
      maxEdits: request.auto?.maxEdits ?? DEFAULT_AUTO_OPTIONS.maxEdits,
      dryRunFirst: request.auto?.dryRunFirst ?? DEFAULT_AUTO_OPTIONS.dryRunFirst,
    };
    const visible = toolsVisibleInMode(this.opts.registry, this.opts.policy, request.mode, request.tools);
    if (visible.length === 0) return null;

    return {
      request,
      auto,
      state: { iteration: 0, edits: 0, dryRunCompleted: false, escalated: false },
      visible,
      history: [],
      prompt: request.prompt,
      outcomes: [],
      turn: 0,
      done: false,
      text: "",
    };
  }

  private async advance(run: RunState): Promise<AgentResult> {
    const req = run.request;

    while (!run.done) {
      // Cancellation is honoured before every turn and between every call.
      if (req.signal?.aborted) {
        this.runs.delete(req.runId);
        return this.toResult(run, false, {
          code: "AGENT_CANCELLED",
          message: "agent run cancelled by the caller",
          retryable: false,
        });
      }

      // Autonomy bounds between turns. The frozen guard enforces the hard
      // iteration/edit caps and the dry-run-first rule; its escalation rule
      // pauses for the human regardless of the caller's wishes.
      if (run.turn > 0 && run.auto.auto) {
        run.state.iteration = run.turn;
        try {
          assertAutoBounds(run.auto, run.state);
        } catch (e) {
          const err = toError(e);
          const code = /maxIterations|maxEdits/.test(err.message) ? "AGENT_TURN_LIMIT" : "AGENT_DRY_RUN_REQUIRED";
          this.runs.delete(req.runId);
          return this.toResult(run, false, { ...err, code });
        }
        if (mustPauseForHuman(run.auto, run.state)) {
          this.runs.delete(req.runId);
          return this.toResult(run, false, {
            code: "AGENT_ESCALATED",
            message: "agent run escalated; human intervention required before continuing",
            retryable: false,
          });
        }
      }

      // 2. ASK THE MODEL. The gateway executes nothing; it returns wants.
      const gatewayRequest: GatewayTurnRequest = {
        runId: req.runId,
        prompt: run.prompt,
        mode: req.mode,
        history: [...run.history],
        tools: run.visible,
        streaming: req.streaming === true,
      };
      let turn;
      try {
        turn = await this.opts.gateway.turn(gatewayRequest, {
          signal: req.signal,
          timeoutMs: req.timeoutMs,
          onStreamEvent: req.onStreamEvent,
        });
      } catch (e) {
        const err = toError(e);
        if (err.retryable) run.state.escalated = true;
        return this.toResult(run, err.retryable, err, err.retryable);
      }

      if (!turn.ok || !turn.text && !turn.toolCalls?.length) {
        const err = turn.error ?? {
          code: "PROVIDER_CALL_FAILED",
          message: "the model returned an empty turn",
          retryable: false,
        };
        if (turn.ok === false && err.retryable) run.state.escalated = true;
        const paused = err.retryable;
        if (!paused) this.runs.delete(req.runId);
        return this.toResult(run, paused, err, paused);
      }

      const toolCalls = turn.toolCalls ?? [];
      run.history.push({
        kind: "assistant",
        text: turn.text ?? "",
        toolCalls,
      });
      if (turn.text) run.text = turn.text;
      run.turn += 1;

      // A turn with no tool calls is the model's final answer.
      if (toolCalls.length === 0) {
        run.done = true;
        break;
      }

      // 3. EXECUTE each call, in order, through the privilege pipeline. The
      //    loop adds nothing to the pipeline's authority: it passes the mode,
      //    the run signal (so an aborted run releases a pending approval), and
      //    the model's justification for the audit trail.
      let cancelled = false;
      for (const call of toolCalls) {
        if (req.signal?.aborted) {
          cancelled = true;
          break;
        }
        const outcome = await this.executeCall(run, call);
        run.outcomes.push(outcome);
        run.history.push({ kind: "tool", outcome });
        if (outcome.ok && isPrivilegedInMode(this.schemaFor(outcome.toolName), this.opts.policy, req.mode)) {
          run.state.edits += 1;
        }
      }
      if (cancelled) {
        this.runs.delete(req.runId);
        return this.toResult(run, false, {
          code: "AGENT_CANCELLED",
          message: "agent run cancelled by the caller",
          retryable: false,
        });
      }
      // An aborted run never continues to another turn, even if its calls
      // settled (a pending approval is released as TOOL_CANCELLED, for
      // instance). The caller ended the run; the loop honours it here too.
      if (req.signal?.aborted) {
        this.runs.delete(req.runId);
        return this.toResult(run, false, {
          code: "AGENT_CANCELLED",
          message: "agent run cancelled by the caller",
          retryable: false,
        });
      }

      // The dry-run-first rule: an iteration that changed nothing counts as the
      // required dry run, and the next iteration may then edit.
      if (run.turn === 1 && run.state.edits === 0) {
        run.state.dryRunCompleted = true;
      }

      // Without autonomy, a human turn ends here — successfully so far. The
      // caller continues the run with another `run` on the same runId.
      if (!run.auto.auto) {
        return this.toResult(run, true, undefined, true);
      }
    }

    this.runs.delete(req.runId);
    return this.toResult(run, true);
  }

  private async executeCall(run: RunState, call: ToolCall): Promise<ToolCallOutcome> {
    const req = run.request;

    // The dry-run rule, enforced BEFORE the pipeline is entered: the first
    // iteration under `--auto` may not change anything. The model is told its
    // request was not performed, so it can describe the plan instead.
    const schema = this.schemaFor(call.toolName);
    const privileged = schema !== null && isPrivilegedInMode(schema, this.opts.policy, req.mode);
    if (privileged && run.auto.auto && run.auto.dryRunFirst && !run.state.dryRunCompleted && run.state.iteration === 0) {
      return {
        toolCallId: call.id,
        toolName: call.toolName,
        ok: false,
        code: "AGENT_DRY_RUN_REQUIRED",
        message: `dry-run: ${call.toolName} was not performed; describe the plan instead`,
        excerpt: "",
        artifacts: [],
        approved: false,
      };
    }

    const result: ToolResult = await this.opts.executor.execute({
      toolName: call.toolName,
      input: call.input,
      runId: req.runId,
      mode: req.mode,
      justification: call.justification,
      signal: req.signal,
    });

    const rendered = renderContent(result);
    return {
      toolCallId: call.id,
      toolName: call.toolName,
      ok: result.ok,
      code: result.code,
      message: result.message,
      excerpt: rendered.excerpt,
      artifacts: rendered.artifacts,
      approved: result.approved,
    };
  }

  private schemaFor(toolName: string): ToolSchema | null {
    return this.opts.registry.get(toolName)?.schema ?? null;
  }

  private toResult(
    run: RunState,
    ok: boolean,
    error?: { code: string; message: string; retryable: boolean },
    pausedForHuman = false,
  ): AgentResult {
    return {
      ok,
      runId: run.request.runId,
      mode: run.request.mode,
      auto: run.auto.auto,
      turns: run.turn,
      approvedEdits: run.outcomes.filter((o) => o.ok && o.approved).length,
      text: run.text,
      history: [...run.history],
      outcomes: [...run.outcomes],
      pausedForHuman,
      escalated: run.state.escalated,
      error,
    };
  }

  private fail(
    request: AgentRequest,
    error: { code: string; message: string; retryable: boolean },
    mode: SafetyMode,
  ): AgentResult {
    return {
      ok: false,
      runId: request.runId,
      mode,
      auto: false,
      turns: 0,
      approvedEdits: 0,
      text: "",
      history: [],
      outcomes: [],
      pausedForHuman: false,
      escalated: false,
      error,
    };
  }
}

export const AGENT_MAX_TURNS = MAX_AGENT_TURNS;

/**
 * Mutable counterpart of the frozen `IterationState`. The frozen type is
 * read-only by contract, but a loop must advance its own counters. This is
 * private to the module and is passed to the frozen guard unchanged, since a
 * mutable object is assignable to a read-only one — the guard still sees the
 * values it needs and nothing here widens the guard's rules.
 */
interface MutableIterationState {
  iteration: number;
  edits: number;
  dryRunCompleted: boolean;
  escalated: boolean;
}

/** Render a settled tool result into a bounded excerpt for the model. */
function renderContent(result: ToolResult): { excerpt: string; artifacts: string[] } {
  const artifacts: string[] = [];
  const parts: string[] = [];
  let budget = EXCERPT_MAX;
  for (const c of result.content) {
    if (c.type === "image") {
      artifacts.push(c.artifactId);
      continue;
    }
    const text = c.type === "text" ? c.text : c.type === "json" ? JSON.stringify(c.json) : c.diff;
    if (budget <= 0) continue;
    const slice = text.length > budget ? `${text.slice(0, budget)}…[truncated]` : text;
    parts.push(slice);
    budget -= slice.length;
  }
  if (artifacts.length > 0) parts.push(`[${artifacts.length} artifact(s)]`);
  return { excerpt: parts.join("\n"), artifacts };
}

function toError(e: unknown): { code: string; message: string; retryable: boolean } {
  const err = e as { code?: string; message: string; retryable?: boolean; name?: string };
  if (err.name === "ModeViolationError") {
    return { code: "MODE_VIOLATION", message: err.message, retryable: false };
  }
  return {
    code: err.code ?? "AGENT_TURN_LIMIT",
    message: err.message,
    retryable: err.retryable ?? false,
  };
}
