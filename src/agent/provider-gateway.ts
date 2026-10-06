/**
 * The provider-backed model gateway (D4).
 *
 * The implementation of the D3 `ModelGateway` seam against the real execution
 * engine. Each agent turn is routed through the engine, hence through every
 * frozen gate: deterministic selection, provider isolation, the egress check
 * (before any key is read), the approval gate, the budget reservation, the
 * single network seam, and the cost settlement.
 *
 * Under the frozen defaults this reaches only the deterministic local agent
 * model — deny-all egress, FREE_ONLY, and a zero budget make a remote call
 * impossible even to begin. A user must explicitly allowlist a host, register
 * a provider, and grant any required approval for anything else to answer.
 *
 * What this gateway does NOT do, because the interface forbids it and the
 * engine has no path for it: execute a tool, or approve one. It carries the
 * model's wants in and the settled text and tool calls out. Nothing more.
 */
import type { ModelGateway, GatewayTurnRequest, GatewayTurnResult, ToolCall } from "./types.ts";
import type { InvocationPortal, InvokeOptions } from "../execution/engine.ts";
import type { ProviderToolCall, ProviderToolDeclaration } from "../execution/types.ts";

export interface ProviderModelGatewayOptions {
  readonly engine: InvocationPortal;
  /** The capability agent turns route through. Defaults to CODING. */
  readonly capability?: string;
  /** An explicit model preference, honoured first when valid. */
  readonly preference?: { readonly provider: string; readonly modelId: string };
  readonly id?: string;
}

export class ProviderModelGateway implements ModelGateway {
  readonly id: string;
  private readonly opts: Required<Omit<ProviderModelGatewayOptions, "preference">> & {
    readonly preference?: { readonly provider: string; readonly modelId: string };
  };

  constructor(opts: ProviderModelGatewayOptions) {
    this.id = opts.id ?? "provider";
    this.opts = {
      engine: opts.engine,
      capability: opts.capability ?? "CODING",
      preference: opts.preference,
      id: this.id,
    };
  }

  async turn(
    request: GatewayTurnRequest,
    options?: InvokeOptions,
  ): Promise<GatewayTurnResult> {
    // The conversation is rendered into the text input the engine accepts. The
    // tool schemas the mode permits are handed to the provider as declarations,
    // so the model can shape a call — and nothing else.
    const text = renderTranscript(request);
    try {
      const outcome = await this.opts.engine.invoke(
        {
          capability: this.opts.capability,
          inputs: [{ kind: "text", text }],
          tools: true,
          structuredOutput: false,
          toolDeclarations: request.tools.map(toDeclaration),
          preference: this.opts.preference,
        },
        options,
      );
      const result = outcome.result;
      return {
        ok: result.ok,
        text: result.text,
        toolCalls: (result.toolCalls ?? []).map(fromProviderCall),
        finishReason: result.finishReason,
      };
    } catch (e) {
      const err = e as { code?: string; message: string; retryable?: boolean };
      return {
        ok: false,
        error: {
          code: err.code ?? "PROVIDER_CALL_FAILED",
          message: err.message,
          retryable: err.retryable ?? false,
        },
      };
    }
  }
}

function toDeclaration(schema: GatewayTurnRequest["tools"][number]): ProviderToolDeclaration {
  return { name: schema.name, description: schema.description, input: schema.input };
}

function fromProviderCall(call: ProviderToolCall): ToolCall {
  return {
    id: call.id,
    toolName: call.toolName,
    input: call.input,
    justification: call.justification,
  };
}

/**
 * Render the conversation as a single text input. The engine's input contract
 * is a flat list of text and image parts; a transcript is the honest
 * rendering, and it keeps the provider layer free of a conversation data
 * structure it does not yet need.
 *
 * History records what the model and the tools have already done; the CURRENT
 * prompt is appended last, as the final user message. That ordering is also
 * what the deterministic local adapter's end-anchored tool-call protocol
 * relies on: the current turn's directive is the last thing in the text, so a
 * block from an earlier prompt is never replayed.
 */
function renderTranscript(request: GatewayTurnRequest): string {
  const lines: string[] = [];
  for (const event of request.history) {
    if (event.kind === "user") {
      lines.push("user:", event.text, "");
    } else if (event.kind === "assistant") {
      lines.push("assistant:", event.text);
      for (const call of event.toolCalls) {
        lines.push(`  calls ${call.toolName} ${JSON.stringify(call.input)}`);
      }
      lines.push("");
    } else {
      const o = event.outcome;
      lines.push(
        `tool ${o.toolName} (${o.ok ? "ok" : "failed: " + (o.code ?? "unknown")})`,
        o.excerpt,
        "",
      );
    }
  }
  lines.push(`[mode: ${request.mode}]`, "user:", request.prompt);
  return lines.join("\n");
}
