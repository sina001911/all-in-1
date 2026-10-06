/**
 * A scripted model gateway (D3) — for tests only, never wired in production.
 *
 * Plays back a fixed script of turns, and records every request it received so
 * a test can prove what the model was *shown*: which tools were visible, which
 * history events, and in which mode. That is how the visibility guarantee is
 * asserted — by inspecting the request rather than inferring it.
 *
 * When the script runs out, the gateway ends the conversation with an empty
 * turn, so a loop under test can never spin on a missing final answer.
 */
import type {
  GatewayTurnRequest,
  GatewayTurnResult,
  ModelGateway,
  ToolCall,
} from "./types.ts";

export interface ScriptedTurn {
  readonly text?: string;
  /** Tool calls the model emits on this turn. */
  readonly toolCalls?: readonly ToolCall[];
  readonly error?: { readonly code: string; readonly message: string; readonly retryable: boolean };
}

export class ScriptedModelGateway implements ModelGateway {
  readonly id = "scripted";
  private readonly script: readonly ScriptedTurn[];
  private cursor = 0;
  /** Every request received, in order — the model's-eye view of the run. */
  readonly requests: GatewayTurnRequest[] = [];

  constructor(script: readonly ScriptedTurn[]) {
    this.script = script;
  }

  async turn(request: GatewayTurnRequest): Promise<GatewayTurnResult> {
    this.requests.push(request);
    const step = this.cursor < this.script.length ? this.script[this.cursor] : undefined;
    this.cursor += 1;
    if (!step) {
      return { ok: true, text: "", finishReason: "end-of-script" };
    }
    if (step.error) {
      return { ok: false, error: step.error, finishReason: "error" };
    }
    return {
      ok: true,
      text: step.text,
      toolCalls: step.toolCalls,
      finishReason: step.toolCalls?.length ? "tool-calls" : "stop",
    };
  }

  /** The tool names the model was offered on the latest turn. */
  get lastVisibleTools(): readonly string[] {
    const last = this.requests[this.requests.length - 1];
    return last ? last.tools.map((t) => t.name) : [];
  }
}
