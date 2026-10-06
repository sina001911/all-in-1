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

/** A failure surfaced as data rather than a thrown error. */
export interface ProviderInvokeFailure {
  readonly ok: false;
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

/** A transport function: the only seam through which the network is reached. */
export interface HttpTransport {
  post(url: string, body: unknown, headers: Record<string, string>): Promise<HttpResponse>;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
}
