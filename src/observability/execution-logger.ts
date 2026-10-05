/**
 * Execution observability seam (P5).
 *
 * Wraps the P4 `ExecutionEngine` and emits one structured log line per
 * invocation. The wrapper is a deliberate boundary, not instrumentation of the
 * engine itself: it observes the request, the outcome, and — through the typed
 * error code — *which gate* refused the call, then maps that to a human-readable
 * gate name. No engine internals are exposed and no gate behaviour changes.
 *
 * Secret redaction is applied EXPLICITLY to anything derived from a provider
 * (output text, error messages) before it reaches the logger, and the logger
 * redacts again defensively. Both layers are tested; neither is trusted alone.
 */
import type { ExecutionOutcome, InvocationPortal, InvokeOptions } from "../execution/engine.ts";
import type { SelectionRequest } from "../models/types.ts";
import type { Logger } from "../log/logger.ts";
import { redact } from "../log/redact.ts";
import type { AllInOneError, ErrorCode } from "../errors.ts";

const GATE_NAMES: Readonly<Record<string, string>> = {
  SELECTION_FAILED: "select",
  PROVIDER_UNAVAILABLE: "adapter-resolution",
  MODEL_NOT_FOUND: "adapter-resolution",
  MODEL_UNAVAILABLE: "adapter-resolution",
  CAPABILITY_NOT_SUPPORTED: "adapter-validation",
  PROVIDER_ISOLATION_VIOLATION: "adapter-validation",
  EGRESS_BLOCKED: "egress",
  APPROVAL_REQUIRED: "approval",
  CREDENTIAL_UNAVAILABLE: "secret",
  BUDGET_EXCEEDED: "budget",
  PROVIDER_TIMEOUT: "invoke",
  PROVIDER_CANCELLED: "invoke",
  PROVIDER_UNREACHABLE: "invoke",
  PROVIDER_RATE_LIMITED: "invoke",
  PROVIDER_CALL_FAILED: "invoke",
};

export interface LoggedEngineOptions {
  /** The engine, or another portal that wraps one. */
  readonly engine: InvocationPortal;
  readonly logger: Logger;
}

export class LoggedExecutionEngine {
  private readonly engine: InvocationPortal;
  private readonly logger: Logger;

  constructor(opts: LoggedEngineOptions) {
    this.engine = opts.engine;
    this.logger = opts.logger;
  }

  async invoke(
    request: SelectionRequest,
    options?: InvokeOptions,
  ): Promise<ExecutionOutcome> {
    this.logger.debug("invocation.requested", {
      capability: request.capability,
      inputs: request.inputs?.length ?? 0,
      structuredOutput: request.structuredOutput === true,
    });

    try {
      const outcome = await this.engine.invoke(request, options);
      this.logger.info("invocation.settled", {
        capability: request.capability,
        model: `${outcome.decision.model?.provider}/${outcome.decision.model?.modelId}`,
        adapter: outcome.adapterId,
        basis: outcome.decision.basis,
        committedUsd: outcome.committedUsd,
        latencyMs: outcome.result.latencyMs,
      });
      // Provider-derived text is redacted before it is logged, even though the
      // logger redacts again. Never trust one layer alone. The raw provider
      // payload is deliberately never logged, per the invoke-result contract.
      this.logger.debug("invocation.output", {
        model: outcome.result.modelId,
        text: truncate(redact(outcome.result.text)),
      });
      return outcome;
    } catch (e) {
      const err = e as AllInOneError;
      const gate = GATE_NAMES[err.code as ErrorCode] ?? "unknown";
      // Provider-derived messages are redacted before they are logged, even
      // though the logger redacts again. Never trust one layer alone.
      const message = redact(err.message);
      if (err.category === "security") {
        this.logger.error(`gate.refused.${gate}`, { code: err.code, message });
      } else if (err.category === "unavailable") {
        this.logger.warn(`gate.failed.${gate}`, { code: err.code, message, retryable: err.retryable });
      } else {
        this.logger.warn(`gate.blocked.${gate}`, { code: err.code, message });
      }
      throw e;
    }
  }
}

/**
 * Redact any text a provider produced before it is stored, displayed, or
 * forwarded. Specialist outputs are machine-structured, but providers can echo
 * prompt material back, so the seam applies here too.
 */
export function redactProviderText(text: string): string {
  return redact(text);
}

const MAX_LOG_TEXT = 400;

function truncate(text: string): string {
  if (text.length <= MAX_LOG_TEXT) return text;
  return `${text.slice(0, MAX_LOG_TEXT)}…(${text.length} chars)`;
}
