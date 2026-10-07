/**
 * Execution layer shared contracts (P4).
 *
 * The result shape returned by every provider adapter's `invoke()`. P3
 * declared `invoke()` but left it throwing `NOT_IMPLEMENTED`; P4 defines the
 * return contract that replaces it.
 */
import type { ErrorCode } from "../errors.ts";

/** Outcome of a single provider invocation. */
export interface ProviderInvokeResult {
  readonly providerId: string;
  /** The model id that was requested, "provider/model". */
  readonly modelId: string;
  readonly capability: string;
  readonly ok: boolean;
  /** Primary natural-language output. */
  readonly text: string;
  /** Structured output, present only when a schema was requested and honoured. */
  readonly structured?: unknown;
  /**
   * Tool calls the model emitted (D4). Each one is a REQUEST: the provider
   * layer never executes a tool, never approves one, and never presumes one
   * will run. The caller settles each call through its own privilege pipeline.
   */
  readonly toolCalls?: readonly ProviderToolCall[];
  /** Actual cost in USD, from the provider's own usage metadata when available. */
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly finishReason?: string;
  /** Provider-specific raw payload, never logged verbatim. */
  readonly raw?: unknown;
}

/**
 * A tool the model may call, as declared TO the provider (D4). The declaration
 * carries the schema so the model can shape a call; it grants no right to have
 * that call executed.
 */
export interface ProviderToolDeclaration {
  readonly name: string;
  readonly description: string;
  /** A JSON schema the model's input must satisfy. */
  readonly input: object;
}

/**
 * A tool call the model emitted (D4). The model's stated `justification` is
 * evidence for the human and the audit trail — it is never consent, and no
 * field here can satisfy an approval.
 */
export interface ProviderToolCall {
  readonly id: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly justification?: string;
}

/**
 * One structured message in a provider conversation (D7).
 *
 * A flat list of text and image parts is enough for a single-shot completion,
 * but not for a real tool-calling loop: a provider that emitted tool calls
 * expects each result returned as its own `tool` message carrying the
 * originating `toolCallId`. Flattening everything into one blob loses that
 * linkage, so a genuine model cannot continue a tool loop. `messages` carries
 * the conversation faithfully.
 */
export type ProviderMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      /** Tool calls this assistant turn emitted, for the provider to resume. */
      readonly toolCalls?: ReadonlyArray<{
        readonly id: string;
        readonly toolName: string;
        /** JSON-encoded arguments, because that is the wire shape. */
        readonly arguments: string;
      }>;
    }
  | {
      readonly role: "tool";
      readonly content: string;
      /** The `tool_call_id` this result answers. */
      readonly toolCallId: string;
      readonly toolName?: string;
    };

/** A failure surfaced as data rather than a thrown error. */
export interface ProviderInvokeFailure {
  readonly ok: false;
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

/** A transport function: the only seam through which the network is reached. */
export interface HttpTransport {
  post(
    url: string,
    body: unknown,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<HttpResponse>;
  /**
   * Streaming call (D11): starts the request and returns the response status
   * with the parsed frame stream. The same injected transport seam as `post`,
   * so a test can inject a fake stream and never opens a socket.
   */
  postStream?(
    url: string,
    body: unknown,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<StreamTransportResponse>;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * One event from a streaming provider response (D11). Chunk text is the
 * model's prose; tool-call deltas arrive as argument fragments; `usage`
 * carries the provider's own accounting when it reports any.
 */
export type StreamEvent =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "tool-call-delta";
      readonly index: number;
      readonly id?: string;
      readonly toolName?: string;
      readonly argumentsDelta?: string;
    }
  | { readonly kind: "finish"; readonly finishReason?: string }
  | {
      readonly kind: "usage";
      readonly promptTokens?: number;
      readonly completionTokens?: number;
      readonly totalTokens?: number;
    };

/** Transport-level streaming response (D11). */
export interface StreamTransportResponse {
  readonly status: number;
  readonly events: AsyncIterable<StreamEvent>;
}
