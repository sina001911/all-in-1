/**
 * Agent runtime contracts (D3).
 *
 * The agentic loop that connects a model to the privileged tool layer:
 *
 *      DesktopFacade -> AgentRuntime -> ( ModelGateway | ToolRuntime )
 *
 * The division of trust is the whole point of this module:
 *
 *   - The MODEL decides what to ask for. It emits `ToolCall`s — requests that
 *     name a tool, an input, and a justification. That is the entire extent of
 *     its power over the machine.
 *   - The RUNTIME decides whether the request is even admissible, and executes
 *     it through the D2 executor: validation, permission class, safety mode,
 *     workspace boundary, human approval, bounded execution, audit.
 *   - The HUMAN is the only source of an approval. Nothing in this module can
 *     produce one: `AgentRuntimeOptions` takes an executor and a registry, and
 *     deliberately has no `approver` field. The executor holds the approver;
 *     the agent holds the executor.
 *
 * So a tool call from the model is a question asked on the human's behalf, and
 * the answer can only ever come from the pipeline — never from the model's own
 * justification, however convincing.
 */
import type { SafetyMode } from "../safety/guard.ts";
import type { AutoOptions } from "../safety/guard.ts";
import type { ToolSchema } from "../tools/types.ts";
import type { ToolResult } from "../tools/types.ts";

/** One tool call, as emitted by the model. A request — never a command. */
export interface ToolCall {
  /** The model's own id for this call, so results can be matched back. */
  readonly id: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  /**
   * The model's stated reason for the call. Recorded verbatim in the audit
   * trail as the justification, and shown to the human when approval is asked.
   * It is evidence presented to the human — it is never a substitute for the
   * human's decision, and no field here can satisfy an approval.
   */
  readonly justification?: string;
}

/** A tool result, matched back to its call and rendered for the model. */
export interface ToolCallOutcome {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
  /** A bounded text rendering of the result, so the model cannot be flooded. */
  readonly excerpt: string;
  /** Artifact ids the tool produced (e.g. a screenshot), for the gateway. */
  readonly artifacts: readonly string[];
  /** True when a human approval was requested and granted for this call. */
  readonly approved: boolean;
}

/** The conversation events the model sees on a later turn. */
export type TurnEvent =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "assistant"; readonly text: string; readonly toolCalls: readonly ToolCall[] }
  | { readonly kind: "tool"; readonly outcome: ToolCallOutcome };

/**
 * The model-facing seam. D4 implements this against the real provider layer;
 * D3 defines it and drives it.
 *
 * A gateway turns the prompt, the conversation so far, and the tools the mode
 * permits into one turn: text, tool calls, or a failure. It NEVER executes a
 * tool and NEVER approves anything; those are the runtime's duties, and the
 * interface has no method that could.
 */
export interface ModelGateway {
  /** A short id for the audit trail and the UI. */
  readonly id: string;
  turn(
    request: GatewayTurnRequest,
    options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ): Promise<GatewayTurnResult>;
}

export interface GatewayTurnRequest {
  readonly runId: string;
  readonly prompt: string;
  readonly mode: SafetyMode;
  readonly history: readonly TurnEvent[];
  /** The tools the model may call, already filtered to what the mode permits. */
  readonly tools: readonly ToolSchema[];
}

export interface GatewayTurnResult {
  readonly ok: boolean;
  readonly text?: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly finishReason?: string;
  readonly error?: { readonly code: string; readonly message: string; readonly retryable: boolean };
}

export interface AgentRequest {
  readonly runId: string;
  readonly prompt: string;
  readonly mode: SafetyMode;
  /**
   * Explicit opt-in to multi-turn autonomy. Without it the loop runs ONE turn
   * and pauses for the human — the human's approval of a privileged tool is a
   * turn, and continuing requires the caller to call `run` again.
   */
  readonly auto?: Partial<AutoOptions>;
  /**
   * The tool names the caller allows the model to see, on top of what the mode
   * permits. The mode filter is applied regardless, so this can only narrow.
   */
  readonly tools?: readonly string[];
  /** Per-turn timeout forwarded to the gateway. */
  readonly timeoutMs?: number;
  /** Abort the run. Releases any pending approval and stops the loop. */
  readonly signal?: AbortSignal;
}

export interface AgentResult {
  readonly ok: boolean;
  readonly runId: string;
  readonly mode: SafetyMode;
  readonly auto: boolean;
  /** Model turns completed. */
  readonly turns: number;
  /** Privileged tool calls that completed with a human approval. */
  readonly approvedEdits: number;
  readonly text: string;
  readonly history: readonly TurnEvent[];
  readonly outcomes: readonly ToolCallOutcome[];
  /** True when the loop stopped for a human decision (not a failure). */
  readonly pausedForHuman: boolean;
  readonly escalated: boolean;
  readonly error?: { readonly code: string; readonly message: string; readonly retryable: boolean };
}
