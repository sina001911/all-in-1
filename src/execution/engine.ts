/**
 * Execution engine (P4) — the first real call path.
 *
 * Wires the gates in one fixed order. The order is a security property, not an
 * implementation detail:
 *
 *   1. SELECT       — deterministic, side-effect free, fully traced
 *   2. VALIDATE     — provider isolation (frozen P3 logic)
 *   3. EGRESS GATE  — endpoint must be allowlisted, BEFORE any key is read
 *   4. SECRET GATE  — key value read only after egress is proven allowed
 *   5. RESERVE      — budget reserved before the call is made
 *   6. INVOKE       — the single network seam (adapter transport)
 *   7. SETTLE       — commit on success, release on failure; never both, never
 *                     neither (try/finally), so the ledger cannot leak
 *
 * Why egress precedes the secret: a key must never be read for a destination
 * that will be refused. Reading the key first would hand a credential to a
 * caller that has no right to receive it.
 *
 * Under the frozen defaults (`FREE_ONLY`, `spendBudgetUsd = 0`, deny-all
 * egress, no remote provider registered) this engine can only ever reach the
 * deterministic local adapter. The machinery is complete, but it is inert
 * unless a user explicitly allowlists a host, registers a provider, and grants
 * any required approval.
 */
import type { ModelCatalog } from "../models/catalog.ts";
import type { StreamEvent } from "./types.ts";
import type { CapabilityRegistry } from "../capabilities/registry.ts";
import type { PriorityChains } from "../models/priorities.ts";
import type { ApprovalStore } from "../registry/approvals.ts";
import type { BudgetLedger } from "../registry/budget.ts";
import type { SelectionDecision, SelectionRequest } from "../models/types.ts";
import { select, type SelectorOptions } from "./selector.ts";
import { assertEgressAllowed, type EgressPolicy } from "./egress.ts";
import { DEFAULT_EGRESS_POLICY } from "./egress.ts";
import type { ProviderInvokeResult } from "./types.ts";
import type { ProviderInvokeRequest } from "../providers/types.ts";
import { AdapterRegistry } from "./adapter-registry.ts";
import { AllInOneError, toAllInOneError } from "../errors.ts";
import { redact } from "../log/redact.ts";

export interface ExecutionEngineOptions {
  readonly catalog: ModelCatalog;
  readonly capabilities: CapabilityRegistry;
  readonly chains: PriorityChains;
  readonly approvals: ApprovalStore;
  readonly budget: BudgetLedger;
  /** Provider adapters keyed by adapter id. */
  readonly adapters: AdapterRegistry;
  readonly policy?: SelectorOptions["policy"];
  readonly egress?: EgressPolicy;
}

export interface ExecutionOutcome {
  readonly decision: SelectionDecision;
  readonly adapterId: string;
  readonly result: ProviderInvokeResult;
  /** Actual spend committed to the ledger, in USD. */
  readonly committedUsd: number;
}

/**
 * Per-call invocation controls (P5). Both optional and backward compatible.
 *
 * Settlement guarantee: on timeout or cancellation the reservation is released
 * immediately and the call fails with a typed error — the ledger can never leak
 * a reservation because a caller abandoned the wait.
 */
export interface InvokeOptions {
  /** Abort the call after this many milliseconds (throws PROVIDER_TIMEOUT). */
  readonly timeoutMs?: number;
  /** Abort the call when this signal aborts (throws PROVIDER_CANCELLED). */
  readonly signal?: AbortSignal;
  /**
   * Streaming sink (D11). When the selected model supports streaming and the
   * engine request says `streaming: true`, each provider frame is forwarded
   * here. Non-streaming invocations simply never emit events.
   */
  readonly onStreamEvent?: (event: StreamEvent) => void;
}

/**
 * The minimum surface a consumer needs: anything that can invoke a selection
 * and settle the cost. `ExecutionEngine` satisfies it, and so does the P5
 * observability wrapper, so logging can be layered without changing call sites.
 */
export interface InvocationPortal {
  invoke(request: SelectionRequest, options?: InvokeOptions): Promise<ExecutionOutcome>;
}

export class ExecutionEngine {
  private readonly opts: ExecutionEngineOptions;

  constructor(opts: ExecutionEngineOptions) {
    this.opts = opts;
  }

  async invoke(request: SelectionRequest, options?: InvokeOptions): Promise<ExecutionOutcome> {
    // 1. SELECT — deterministic, no side effects.
    const decision = select(request, {
      catalog: this.opts.catalog,
      capabilities: this.opts.capabilities,
      chains: this.opts.chains,
      approvals: this.opts.approvals,
      policy: this.opts.policy,
    });
    if (!decision.ok || !decision.model) {
      throw new AllInOneError(
        `No model selectable for capability ${request.capability}`,
        "SELECTION_FAILED",
        "config",
        { retryable: false },
      );
    }

    const modelId = `${decision.model.provider}/${decision.model.modelId}`;
    const descriptor = this.opts.catalog.get(modelId);
    if (!descriptor) {
      throw new AllInOneError(
        `Selected model ${modelId} is not in the catalogue`,
        "SELECTION_FAILED",
        "config",
        { retryable: false },
      );
    }

    const adapter = this.opts.adapters.get(descriptor.providerAdapter);
    if (!adapter) {
      throw new AllInOneError(
        `Adapter ${descriptor.providerAdapter} for model ${modelId} is not registered`,
        "PROVIDER_UNAVAILABLE",
        "unavailable",
        { retryable: false },
      );
    }

    // 2. VALIDATE — frozen P3 isolation rules.
    const invokeRequest: ProviderInvokeRequest = {
      model: modelId,
      capability: request.capability,
      inputs:
        request.inputs?.map((i) =>
          i.kind === "text" ? { kind: "text", text: i.text } : { kind: "image", artifactId: i.artifactId },
        ) ?? [],
      structuredOutputSchema: request.structuredOutput ? {} : undefined,
      tools: request.toolDeclarations,
      messages: request.messages,
    };
    adapter.validateInvoke(invokeRequest, this.opts.catalog);

    // 3. EGRESS GATE — before any key is read.
    assertEgressAllowed(adapter.endpoint, this.opts.egress ?? DEFAULT_EGRESS_POLICY);

    // 4. APPROVAL GATE. The selector reports *what* a call requires; the engine
    // enforces it. A paid or unknown-cost model that has no recorded approval
    // stops here — after egress, before any credential is read or budget
    // reserved — so an unapproved spend can never begin.
    if (decision.requiresApproval && !this.opts.approvals.isApproved(modelId)) {
      throw new AllInOneError(
        `Model ${modelId} requires an explicit approval before a paid call; none is recorded`,
        "APPROVAL_REQUIRED",
        "config",
        { retryable: false },
      );
    }

    // 5. RESERVE — before the call. NaN (unknown cost) reserves 0, mirroring
    // the frozen router, so an unknown-cost model never pre-spends budget it
    // cannot estimate.
    const reserved = Number.isFinite(decision.costEstimateUsd)
      ? Math.max(0, decision.costEstimateUsd)
      : 0;
    if (!this.opts.budget.reserve(reserved)) {
      throw new AllInOneError(
        `Spend budget exceeded when invoking ${modelId}`,
        "BUDGET_EXCEEDED",
        "config",
        { retryable: false },
      );
    }

    // 6 + 7. INVOKE and SETTLE. The finally block guarantees the reservation
    // is released if the call throws, so the ledger cannot leak.
    let result: ProviderInvokeResult;
    // One controller bounded by the caller's signal AND the engine timeout,
    // so timeout/cancellation tear down the actual socket inside the adapter,
    // not just the caller's wait. The adapter resolves its own typed errors
    // from the aborted signal; this controller is the propagation vehicle.
    const invokeController = new AbortController();
    let invokeTimerFired = false;
    if (options?.signal) {
      if (options.signal.aborted) invokeController.abort();
      else options.signal.addEventListener("abort", () => invokeController.abort(), { once: true });
    }
    let invokeTimer: ReturnType<typeof setTimeout> | undefined;
    if (options?.timeoutMs !== undefined) {
      invokeTimer = setTimeout(() => {
        invokeTimerFired = true;
        invokeController.abort();
      }, options.timeoutMs);
    }
    try {
      result = await raceInvocation(
        adapter.invoke(invokeRequest, {
          stream: request.streaming === true,
          onEvent: options?.onStreamEvent,
          signal: invokeController.signal,
        }),
        options,
      );
    } catch (e) {
      this.opts.budget.release(reserved);
      // Cancellation is authoritative even when the transport error fires
      // first: an aborted signal can never be relabelled a provider failure.
      if (options?.signal?.aborted) {
        throw new AllInOneError("invocation cancelled by the caller", "PROVIDER_CANCELLED", "unavailable", {
          retryable: false,
        });
      }
      if (invokeTimerFired) {
        // The engine's own wall-clock timeout tore down the socket.
        throw new AllInOneError(
          `invocation exceeded the ${options?.timeoutMs}ms timeout`,
          "PROVIDER_TIMEOUT",
          "unavailable",
          { retryable: true },
        );
      }
      if (e instanceof AllInOneError && e.code === "PROVIDER_CANCELLED") {
        throw e;
      }
      if (e instanceof InvocationAbortedError) {
        throw new AllInOneError(e.message, e.code, "unavailable", {
          retryable: e.code === "PROVIDER_TIMEOUT",
        });
      }
      throw toAllInOneError(e, {
        code: "PROVIDER_CALL_FAILED",
        category: "unavailable",
        message: `Invocation of ${modelId} via ${adapter.id} failed: ${describe(e)}`,
      });
    } finally {
      if (invokeTimer !== undefined) clearTimeout(invokeTimer);
    }

    // Commit the ACTUAL cost, not the estimate. The reservation is released
    // first so an over-estimate never stays pinned to the ledger.
    this.opts.budget.release(reserved);
    const committed = Math.max(0, result.costUsd ?? 0);
    if (committed > 0) this.opts.budget.commit(committed);

    return {
      decision,
      adapterId: adapter.id,
      result,
      committedUsd: committed,
    };
  }
}

function describe(e: unknown): string {
  const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return redact(message);
}

/**
 * Raised when an invocation is abandoned by timeout or cancellation. Distinct
 * from a provider failure so the engine can give it the right typed code, and
 * so the reservation is released before the error propagates.
 */
class InvocationAbortedError extends Error {
  readonly code: "PROVIDER_TIMEOUT" | "PROVIDER_CANCELLED";
  constructor(code: "PROVIDER_TIMEOUT" | "PROVIDER_CANCELLED", message: string) {
    super(message);
    this.name = "InvocationAbortedError";
    this.code = code;
  }
}

/**
 * Race an invocation against an optional timeout and/or abort signal. The
 * underlying promise is never cancelled (that is the adapter's concern); this
 * only decides when the caller stops waiting. Settlement of the reservation is
 * handled by the engine's try/catch, which runs on every rejection path, so a
 * caller that abandons the wait cannot leak a reservation.
 */
function raceInvocation<T>(
  promise: Promise<T>,
  options?: InvokeOptions,
): Promise<T> {
  if (!options) return promise;
  if (options.timeoutMs === undefined && !options.signal) return promise;

  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      action();
    };

    const onAbort = () =>
      finish(() =>
        reject(new InvocationAbortedError("PROVIDER_CANCELLED", "invocation cancelled by the caller")),
      );

    if (options.signal) {
      if (options.signal.aborted) {
        reject(new InvocationAbortedError("PROVIDER_CANCELLED", "invocation cancelled by the caller"));
        return;
      }
      options.signal.addEventListener("abort", onAbort);
    }
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(
        () =>
          finish(() =>
            reject(
              new InvocationAbortedError(
                "PROVIDER_TIMEOUT",
                `invocation exceeded the ${options.timeoutMs}ms timeout`,
              ),
            ),
      ),
        options.timeoutMs,
      );
    }

    promise.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e)),
    );
  });
}
