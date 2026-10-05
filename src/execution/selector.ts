/**
 * Capability selector (P4).
 *
 * This is the `selection.ts` that `models/catalog.ts` references but that P3
 * never shipped: it turns a `SelectionRequest` into an explainable
 * `SelectionDecision` carrying a full `TraceEntry[]` — every candidate
 * considered, every check run, and the exact reason it was accepted or
 * rejected.
 *
 * Deterministic and side-effect free. It never opens a connection, never
 * reserves budget, and never reads a credential. Cost is *classified* here
 * (using the frozen policy vocabulary via `toPricing`), but the budget ledger
 * is touched only by the execution engine, at invoke time.
 *
 * Ordering honours `PriorityChains`: a user override is a *preference, not an
 * authorization* — a chain entry that fails a check is skipped and recorded,
 * never forced.
 */
import type { ModelCatalog } from "../models/catalog.ts";
import type { ModelDescriptor } from "../models/types.ts";
import type { ModelRef, SelectionBasis, SelectionDecision, SelectionRequest, TraceEntry } from "../models/types.ts";
import type { CapabilityRegistry } from "../capabilities/registry.ts";
import type { PriorityChains } from "../models/priorities.ts";
import type { ApprovalStore } from "../registry/approvals.ts";
import type { CostClass } from "../capabilities/types.ts";
import { toPricing } from "../capabilities/types.ts";
import type { CostPolicy, Pricing } from "../registry/cost-policy.ts";
import { isEffectivelyFree } from "../registry/cost-policy.ts";
import { toRouterPolicy } from "../capabilities/types.ts";
import type { CapabilityCostPolicy } from "../capabilities/types.ts";
import { policyAllowsPaid } from "../capabilities/types.ts";

/** Lifecycle statuses the selector will auto-pick, mirroring the catalogue. */
const SELECTABLE_STATUS: readonly string[] = ["active", "beta"];

function describeOperational(model: ModelDescriptor): string {
  if (!model.enabled) return "disabled";
  if (!model.available) return "not available";
  if (model.fixed) return "fixed (not auto-selectable)";
  if (!SELECTABLE_STATUS.includes(model.status)) return `status ${model.status}`;
  return "enabled, available, selectable";
}

export interface SelectorOptions {
  readonly catalog: ModelCatalog;
  readonly capabilities: CapabilityRegistry;
  readonly chains: PriorityChains;
  readonly approvals: ApprovalStore;
  /**
   * Cost policy. Accepts the capability-layer vocabulary and projects it onto
   * the frozen policy set via `toRouterPolicy`, so frozen behaviour is
   * preserved byte-for-byte.
   */
  readonly policy?: CapabilityCostPolicy | CostPolicy;
}

export interface CheckContext {
  readonly request: SelectionRequest;
  readonly requiresInput: readonly string[];
  readonly requiresOutput: readonly string[];
}

/** A single named pass/fail verdict on one candidate. */
export interface SelectorCheck {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

function projectPolicy(policy: SelectorOptions["policy"]): CostPolicy {
  if (!policy) return "FREE_ONLY";
  if (typeof policy === "string") {
    // Already a frozen router policy.
    if (policy === "FREE_ONLY" || policy === "PREFERRED_FREE" || policy === "BALANCED" || policy === "PREMIUM_ALLOWED" || policy === "MANUAL") {
      return policy;
    }
    return toRouterPolicy(policy as CapabilityCostPolicy);
  }
  return "FREE_ONLY";
}

function classifyCost(model: ModelDescriptor): { pricing: Pricing; costClass: CostClass } {
  return { pricing: toPricing(model.pricing.costClass), costClass: model.pricing.costClass };
}

function estimateUsd(model: ModelDescriptor): number {
  const { pricing } = classifyCost(model);
  if (isEffectivelyFree(pricing)) return 0;
  const inCost = model.pricing.inputPer1M ?? 0;
  const outCost = model.pricing.outputPer1M ?? 0;
  if (inCost === 0 && outCost === 0) return Number.NaN; // unknown cost
  return (inCost + outCost) / 1_000_000; // conservative 1k+1k token estimate
}

function modalityCheck(
  name: string,
  required: readonly string[],
  declared: readonly string[],
): SelectorCheck {
  const missing = required.filter((m) => !declared.includes(m));
  if (missing.length === 0) {
    return { name, pass: true, detail: `declares ${required.join(", ") || "(none required)"}` };
  }
  return { name, pass: false, detail: `missing ${missing.join(", ")}` };
}

function needsApprovalFor(model: ModelDescriptor, approvals: ApprovalStore): boolean {
  const free = isEffectivelyFree(toPricing(model.pricing.costClass));
  return !free && !approvals.isApproved(model.id);
}

function runChecks(model: ModelDescriptor, ctx: CheckContext, policy: CostPolicy, approvals: ApprovalStore): SelectorCheck[] {
  const checks: SelectorCheck[] = [];
  checks.push({
    name: "operational",
    pass: model.enabled && model.available && !model.fixed && SELECTABLE_STATUS.includes(model.status),
    detail: describeOperational(model),
  });
  checks.push({
    name: "capability",
    pass: model.capabilities.includes(ctx.request.capability),
    detail: model.capabilities.includes(ctx.request.capability)
      ? `declares ${ctx.request.capability}`
      : `does not declare ${ctx.request.capability}`,
  });
  checks.push(modalityCheck("input-modality", ctx.requiresInput, model.inputModalities));
  checks.push(modalityCheck("output-modality", ctx.requiresOutput, model.outputModalities));

  if (ctx.request.tools) {
    checks.push({
      name: "tools",
      pass: model.tools,
      detail: model.tools ? "tool calling available" : "no tool calling",
    });
  }
  if (ctx.request.structuredOutput) {
    checks.push({
      name: "structured-output",
      pass: model.structuredOutput,
      detail: model.structuredOutput ? "structured JSON available" : "no structured JSON",
    });
  }
  if (ctx.request.streaming) {
    checks.push({
      name: "streaming",
      pass: model.streaming,
      detail: model.streaming ? "streaming available" : "no streaming",
    });
  }
  if (ctx.request.minContext !== undefined) {
    const ok = model.contextLimit >= ctx.request.minContext;
    checks.push({
      name: "min-context",
      pass: ok,
      detail: ok
        ? `${model.contextLimit} >= ${ctx.request.minContext}`
        : `${model.contextLimit} < ${ctx.request.minContext}`,
    });
  }

  const { pricing } = classifyCost(model);
  const free = isEffectivelyFree(pricing);
  if (free) {
    checks.push({ name: "cost", pass: true, detail: "free — permitted under every policy" });
  } else if (!policyAllowsPaid(toCapabilityLayerPolicy(policy))) {
    checks.push({
      name: "cost",
      pass: false,
      detail: `${pricing} is not permitted under ${policy} (paid or unknown blocked)`,
    });
  } else {
    // The policy permits paid cost, so the model is *selectable*; approval is
    // enforced by the execution engine at invoke time. Selection explains what
    // is required, it does not silently spend.
    const approved = approvals.isApproved(model.id);
    checks.push({
      name: "cost",
      pass: true,
      detail: pricing === "unknown"
        ? `unknown pricing treated as premium under ${policy}; approval ${approved ? "granted" : "required"} for ${model.id}`
        : `premium permitted under ${policy}; approval ${approved ? "granted" : "required"} for ${model.id}`,
    });
  }
  return checks;
}

function toCapabilityLayerPolicy(policy: CostPolicy): CapabilityCostPolicy {
  switch (policy) {
    case "FREE_ONLY":
      return "FREE_ONLY";
    case "PREFERRED_FREE":
      return "ASK_BEFORE_PAID";
    case "BALANCED":
      return "BALANCED";
    case "PREMIUM_ALLOWED":
    case "MANUAL":
      return "PREMIUM_ALLOWED";
  }
}

function makeTrace(model: ModelDescriptor, checks: SelectorCheck[], selected: boolean, reason: string): TraceEntry {
  return {
    modelId: model.id,
    provider: model.provider,
    status: selected ? "selected" : "rejected",
    reason,
    checks: checks.map((c) => ({ check: c.name, pass: c.pass, detail: c.detail })),
  };
}

function pickFirstPassing(
  candidates: readonly ModelDescriptor[],
  ctx: CheckContext,
  policy: CostPolicy,
  approvals: ApprovalStore,
): { model: ModelDescriptor; trace: TraceEntry[]; approvalsNeeded: boolean } {
  const trace: TraceEntry[] = [];
  let approvalsNeeded = false;
  for (const model of candidates) {
    const checks = runChecks(model, ctx, policy, approvals);
    const failed = checks.filter((c) => !c.pass);
    if (failed.length === 0) {
      const needsApproval = needsApprovalFor(model, approvals);
      if (needsApproval) approvalsNeeded = true;
      trace.push(makeTrace(model, checks, true, "all checks passed"));
      return { model, trace, approvalsNeeded };
    }
    trace.push(makeTrace(model, checks, false, failed.map((c) => c.name).join(", ")));
  }
  return { model: null as unknown as ModelDescriptor, trace, approvalsNeeded };
}

export function select(req: SelectionRequest, opts: SelectorOptions): SelectionDecision {
  const policy = projectPolicy(opts.policy);
  const capReqs = opts.capabilities.requirements(req.capability);
  const ctx: CheckContext = {
    request: req,
    requiresInput: [...new Set([...capReqs.requiresInput, ...(req.inputModalities ?? [])])],
    requiresOutput: [...new Set([...capReqs.requiresOutput, ...(req.outputModalities ?? [])])],
  };

  const trace: TraceEntry[] = [];
  const warnings: string[] = [];
  if (capReqs.mediaGated) {
    warnings.push(
      `capability ${req.capability} is media-gated and blocked while media.enabled = false`,
    );
  }

  // Ordered candidates: the user chain (preference) or the catalogue default.
  const chain = opts.chains.get(req.capability);
  const candidates = chain
    .map((id) => opts.catalog.get(id))
    .filter((m): m is ModelDescriptor => m !== undefined);

  if (candidates.length === 0) {
    return {
      ok: false,
      mode: "auto",
      capability: req.capability,
      model: null,
      basis: "none",
      costClass: null,
      costEstimateUsd: Number.NaN,
      requiresApproval: false,
      trace,
      warnings: [...warnings, "no candidates registered for this capability"],
    };
  }

  // Honour an explicit preference first: it must still pass every check.
  if (req.preference) {
    const prefId = `${req.preference.provider}/${req.preference.modelId}`;
    const preferred = candidates.find((m) => m.id === prefId);
    if (preferred) {
      const checks = runChecks(preferred, ctx, policy, opts.approvals);
      if (checks.every((c) => c.pass)) {
        const needsApproval = needsApprovalFor(preferred, opts.approvals);
        trace.push(makeTrace(preferred, checks, true, "explicit preference passed all checks"));
        return decision(preferred, "preference", needsApproval, trace, warnings, req.capability);
      }
      trace.push(
        makeTrace(preferred, checks, false, "explicit preference rejected; falling back to chain"),
      );
      warnings.push(`explicit preference ${prefId} did not qualify; chain order used instead`);
    } else {
      warnings.push(`explicit preference ${prefId} is not a candidate; chain order used instead`);
    }
  }

  const first = pickFirstPassing(candidates, ctx, policy, opts.approvals);
  trace.push(...first.trace);
  if (first.model) {
    const basis: SelectionBasis = opts.chains.hasOverride(req.capability)
      ? "priority-chain"
      : "default-priority";
    return decision(first.model, basis, first.approvalsNeeded, trace, warnings, req.capability);
  }

  // Declared fallback chain, if the selected model's provider left one.
  // Walk the catalogue's `fallback` pointers from the chain head.
  const head = candidates[0];
  const seen = new Set<string>(candidates.map((m) => m.id));
  let cursor: ModelDescriptor | undefined = head;
  let depth = 0;
  while (cursor && cursor.fallback && !seen.has(cursor.fallback) && depth < 16) {
    const next = opts.catalog.get(cursor.fallback);
    if (!next) break;
    seen.add(next.id);
    depth += 1;
    const checks = runChecks(next, ctx, policy, opts.approvals);
    if (checks.every((c) => c.pass)) {
      const needsApproval = needsApprovalFor(next, opts.approvals);
      trace.push(makeTrace(next, checks, true, `declared fallback (depth ${depth}) passed`));
      return decision(next, "fallback", needsApproval, trace, warnings, req.capability);
    }
    trace.push(makeTrace(next, checks, false, `declared fallback (depth ${depth}) rejected`));
    cursor = next;
  }

  return {
    ok: false,
    mode: "auto",
    capability: req.capability,
    model: null,
    basis: "none",
    costClass: null,
    costEstimateUsd: Number.NaN,
    requiresApproval: false,
    trace,
    warnings: [...warnings, "no candidate passed every check"],
  };
}

function decision(
  model: ModelDescriptor,
  basis: SelectionBasis,
  requiresApproval: boolean,
  trace: TraceEntry[],
  warnings: string[],
  capability: string,
): SelectionDecision {
  const { costClass } = classifyCost(model);
  const estimate = estimateUsd(model);
  const modelRef: ModelRef = { provider: model.provider, modelId: model.modelId };
  return {
    ok: true,
    mode: "auto",
    capability,
    model: modelRef,
    basis,
    costClass,
    costEstimateUsd: estimate,
    requiresApproval,
    trace,
    warnings,
  };
}
