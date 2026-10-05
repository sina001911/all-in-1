/**
 * Router ↔ selector bridge (P4).
 *
 * The frozen P1 layer routes by ROLE (`ModelRouter` → `RouterDecision`); the
 * P3/P4 capability layer routes by CAPABILITY (`select()` →
 * `SelectionDecision`). Neither is wrong and P4 must not modify either. This
 * module is the only place that translates between the two vocabularies, so:
 *
 *   - the frozen role/policy machinery stays byte-for-byte intact,
 *   - the capability layer finally has a live consumer,
 *   - vision (role-based) can drive capability-based execution unchanged.
 *
 * The bridge is lossy in one direction only: a `SelectionDecision` carries a
 * full trace, while a `RouterDecision` carries only `alternativesConsidered`.
 * Bridging router→selector therefore synthesises a single-entry trace from the
 * router's own explanation, rather than inventing checks the router never ran.
 */
import type { RouterDecision } from "../registry/cost-policy.ts";
import type { ModelRole } from "../registry/roles.ts";
import type {
  ModelRef,
  SelectionBasis,
  SelectionDecision,
  SelectionRequest,
  TraceEntry,
} from "../models/types.ts";

/**
 * Map a role onto the capability the selector should route on. Derived from
 * `ROLE_DEFINITIONS` descriptions, not invented: each role's declared purpose
 * names exactly one capability family.
 */
export function capabilityForRole(role: ModelRole): string {
  switch (role) {
    case "VISION":
      return "SCREENSHOT_ANALYSIS";
    case "VISUAL_QA":
      return "SCREENSHOT_ANALYSIS";
    case "CODE_REVIEWER":
      return "CODE_REVIEW";
    case "DEEP_REASONING":
      return "DEEP_REASONING";
    case "CODING_ASSISTANT":
      return "CODING";
    case "FAST_TASK":
      return "FAST_TASK";
    case "MODEL_ROUTER":
      return "FAST_TASK";
    default:
      return "CODING";
  }
}

export function selectionRequestFromRole(
  role: ModelRole,
  overrides: Partial<SelectionRequest> = {},
): SelectionRequest {
  return {
    capability: capabilityForRole(role),
    inputModalities: overrides.inputModalities,
    outputModalities: overrides.outputModalities,
    tools: overrides.tools,
    structuredOutput: overrides.structuredOutput,
    streaming: overrides.streaming,
    minContext: overrides.minContext,
    preference: overrides.preference,
    excludeModelIds: overrides.excludeModelIds,
  };
}

export function bridgeRouterDecision(
  decision: RouterDecision,
  capability: string,
): SelectionDecision {
  const model: ModelRef = {
    provider: decision.model.providerId,
    modelId: decision.model.modelId,
  };
  const trace: TraceEntry[] = [
    {
      modelId: `${model.provider}/${model.modelId}`,
      provider: model.provider,
      status: "selected",
      reason: `delegated to the frozen role router (basis: ${decision.basis})`,
      checks: decision.alternativesConsidered.map((a) => ({
        check: "router-policy",
        pass: false,
        detail: `${a.model}: ${a.rejectedBecause}`,
      })),
    },
  ];
  const basis: SelectionBasis = mapBasis(decision.basis);
  return {
    ok: true,
    mode: "auto",
    capability,
    model,
    basis,
    costClass: null,
    costEstimateUsd: decision.costEstimateUsd,
    requiresApproval: decision.requiresApproval,
    trace,
    warnings: [],
  };
}

function mapBasis(basis: RouterDecision["basis"]): SelectionBasis {
  switch (basis) {
    case "policy":
      return "default-priority";
    case "explicit-approval":
      return "preference";
    case "stub":
      return "none";
  }
}
