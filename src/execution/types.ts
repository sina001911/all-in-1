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
  /** Actual cost in USD, from the provider's own usage metadata when available. */
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly finishReason?: string;
  /** Provider-specific raw payload, never logged verbatim. */
  readonly raw?: unknown;
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
