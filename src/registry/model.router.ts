/**
 * Deterministic model router.
 *
 * Resolution is a pure function of (role, policy, budget, registry state) with
 * no LLM involvement and no network access. Rules:
 *
 * 1. MAIN_CODER is never resolvable — it is a fixed binding owned by the
 *    OpenCode session, never a routing decision.
 * 2. FREE_ONLY: consider only pricing === "free". If none qualifies, fail with
 *    FREE_UNAVAILABLE. Never fall back to paid silently.
 * 3. PREFERRED_FREE: try free first. If a free candidate satisfies the
 *    capability requirements it wins. Otherwise selecting a paid model is a
 *    free -> paid fallback, which is never silent: it throws
 *    PAID_FALLBACK_NOT_APPROVED unless a recorded approval for that exact model
 *    already exists.
 * 4. UNKNOWN_COST is treated as premium and is blocked unless an approval for
 *    that exact model id is on record.
 * 5. Budget: every paid/unknown call reserves against the ledger; a reservation
 *    that would exceed the budget throws BUDGET_EXCEEDED.
 */
import type { CostPolicy, RouterDecision } from "./cost-policy.ts";
import { CostPolicyError, isEffectivelyFree } from "./cost-policy.ts";
import type { ModelDefinition, ModelRegistry } from "./model.registry.ts";
import type { ModelRole } from "./roles.ts";
import { RoleNotRoutableError, getRoleDefinition } from "./roles.ts";
import type { ApprovalStore } from "./approvals.ts";
import type { BudgetLedger } from "./budget.ts";
import { stubFor } from "./stub.ts";

export interface RouterOptions {
  readonly policy?: CostPolicy;
  readonly registry: ModelRegistry;
  readonly approvals: ApprovalStore;
  readonly budget: BudgetLedger;
}

export interface ResolveRequest {
  readonly role: ModelRole;
  readonly imageInput?: boolean;
  readonly structuredJson?: boolean;
}

function capabilityMismatch(m: ModelDefinition, req: ResolveRequest): string | null {
  if (req.imageInput && !m.modalities.input.includes("image"))
    return "missing image input modality";
  if (req.structuredJson && !m.capabilities.structuredJson)
    return "missing structured-json capability";
  if (!m.enabled) return "disabled";
  if (!m.availability) return "unavailable";
  return null;
}

function estimateCostUsd(m: ModelDefinition): number {
  if (isEffectivelyFree(m.pricing)) return 0;
  const inCost = m.cost?.inputPer1M ?? 0;
  const outCost = m.cost?.outputPer1M ?? 0;
  if (inCost === 0 && outCost === 0) return Number.NaN; // unknown cost
  return (inCost + outCost) / 1_000_000; // conservative 1k+1k token estimate
}

export class ModelRouter {
  private readonly opts: RouterOptions;
  constructor(opts: RouterOptions) {
    this.opts = opts;
  }

  resolve(req: ResolveRequest): RouterDecision {
    const role = req.role;
    if (role === "MAIN_CODER") throw new RoleNotRoutableError(role);

    const roleDef = getRoleDefinition(role);
    const policy = this.opts.policy ?? roleDef.defaultPolicy;
    const candidates = this.opts.registry.candidatesFor(role);
    const alternatives: { model: string; rejectedBecause: string }[] = [];

    // Stubs are the last-resort fallback: they only win when no real model
    // qualifies, so a real paid model is never displaced by a canned stub.
    const real = candidates.filter((m) => m.provider !== "stub");

    if (real.length === 0) {
      return this.stubDecision(role, alternatives, "no candidates registered for role");
    }

    // Capability filter first, deterministically.
    const capable = real.filter((m) => {
      const reason = capabilityMismatch(m, req);
      if (reason) {
        alternatives.push({ model: m.id, rejectedBecause: reason });
        return false;
      }
      return true;
    });

    if (capable.length === 0) {
      return this.stubDecision(role, alternatives, "no candidate satisfied capability requirements");
    }

    const free = capable.filter((m) => isEffectivelyFree(m.pricing));
    const paid = capable.filter((m) => !isEffectivelyFree(m.pricing));

    if (policy === "FREE_ONLY") {
      if (free.length === 0) {
        for (const m of paid)
          alternatives.push({ model: m.id, rejectedBecause: "paid under FREE_ONLY policy" });
        throw new CostPolicyError(
          `No free model available for role ${role}; refusing paid fallback`,
          "FREE_UNAVAILABLE",
        );
      }
      return this.pickFree(free, alternatives);
    }

    if (policy === "PREFERRED_FREE") {
      if (free.length > 0) return this.pickFree(free, alternatives);
      // No free candidate: a paid pick is a free -> paid fallback.
      return this.requestPaidApproval(role, paid, alternatives, policy);
    }

    // BALANCED / PREMIUM_ALLOWED: free still preferred when present.
    if (free.length > 0) return this.pickFree(free, alternatives);
    return this.requestPaidApproval(role, paid, alternatives, policy);
  }

  private pickFree(
    free: readonly ModelDefinition[],
    alternatives: { model: string; rejectedBecause: string }[],
  ): RouterDecision {
    const chosen = [...free].sort((a, b) => b.priority - a.priority)[0] as ModelDefinition;
    for (const m of free) if (m !== chosen) alternatives.push({ model: m.id, rejectedBecause: "lower priority among free" });
    return {
      model: { providerId: chosen.provider, modelId: chosen.id.split("/")[1] as string },
      basis: "policy",
      costEstimateUsd: 0,
      requiresApproval: false,
      alternativesConsidered: alternatives,
    };
  }

  private requestPaidApproval(
    role: ModelRole,
    paid: readonly ModelDefinition[],
    alternatives: { model: string; rejectedBecause: string }[],
    policy: CostPolicy,
  ): RouterDecision {
    const sorted = [...paid].sort((a, b) => {
      const ac = estimateCostUsd(a);
      const bc = estimateCostUsd(b);
      // Prefer known-cost over unknown-cost, then cheaper.
      if (Number.isNaN(ac) && !Number.isNaN(bc)) return 1;
      if (!Number.isNaN(ac) && Number.isNaN(bc)) return -1;
      return ac - bc;
    });
    const chosen = sorted[0];
    if (!chosen) return this.stubDecision(role, alternatives, "no paid candidate either");

    const cost = estimateCostUsd(chosen);
    const unknown = Number.isNaN(cost);
    if (unknown) {
      // UNKNOWN_COST: block unless an approval exists for this exact model.
      if (!this.opts.approvals.isApproved(chosen.id)) {
        throw new CostPolicyError(
          `Model ${chosen.id} has unknown pricing for role ${role}; explicit approval required`,
          "UNKNOWN_COST_BLOCKED",
        );
      }
    }

    if (!this.opts.approvals.isApproved(chosen.id)) {
      // PREFERRED_FREE is a free -> paid fallback, which is never silent.
      if (policy === "PREFERRED_FREE") {
        throw new CostPolicyError(
          `No free model available for role ${role}; paid fallback ${chosen.id} is not approved`,
          "PAID_FALLBACK_NOT_APPROVED",
        );
      }
      // BALANCED / PREMIUM_ALLOWED: paid is allowed by policy, so the decision
      // records that approval is required. No budget is reserved yet: a
      // decision is not a call. The ledger is only touched once the choice is
      // actually going to be used.
      return {
        model: { providerId: chosen.provider, modelId: chosen.id.split("/")[1] as string },
        basis: "explicit-approval",
        costEstimateUsd: unknown ? Number.NaN : cost,
        requiresApproval: true,
        alternativesConsidered: alternatives,
      };
    }

    // Approved: reserve budget before the call is made.
    const reserved = unknown ? 0 : cost;
    if (!this.opts.budget.reserve(reserved)) {
      throw new CostPolicyError(
        `Spend budget exceeded when selecting ${chosen.id} for role ${role}`,
        "BUDGET_EXCEEDED",
      );
    }

    return {
      model: { providerId: chosen.provider, modelId: chosen.id.split("/")[1] as string },
      basis: "explicit-approval",
      costEstimateUsd: unknown ? Number.NaN : cost,
      requiresApproval: false,
      alternativesConsidered: alternatives,
    };
  }

  private stubDecision(
    role: ModelRole,
    alternatives: { model: string; rejectedBecause: string }[],
    reason: string,
  ): RouterDecision {
    const def = getRoleDefinition(role);
    const fallback = def.fallback;
    if (fallback && fallback !== role) {
      const fb = this.opts.registry.get(stubFor(fallback));
      if (fb) {
        return {
          model: { providerId: fb.provider, modelId: fb.id.split("/")[1] as string },
          basis: "stub",
          costEstimateUsd: 0,
          requiresApproval: false,
          alternativesConsidered: [...alternatives, { model: reason, rejectedBecause: "stub fallback" }],
        };
      }
    }
    return {
      model: { providerId: "stub", modelId: stubFor(role) },
      basis: "stub",
      costEstimateUsd: 0,
      requiresApproval: false,
      alternativesConsidered: [...alternatives, { model: reason, rejectedBecause: "stub fallback" }],
    };
  }
}
