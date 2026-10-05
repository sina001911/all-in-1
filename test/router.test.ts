/**
 * Router suite: deterministic resolution; MAIN_CODER is unroutable; FREE_ONLY
 * never falls back to paid; unknown pricing is blocked.
 */
import { describe, expect, it } from "vitest";
import { ModelRouter } from "../src/registry/model.router.ts";
import { ModelRegistry } from "../src/registry/model.registry.ts";
import { ApprovalStore } from "../src/registry/approvals.ts";
import { BudgetLedger } from "../src/registry/budget.ts";
import { CostPolicyError } from "../src/registry/cost-policy.ts";
import type { CostPolicy } from "../src/registry/cost-policy.ts";
import { registerStubs } from "../src/registry/stub.ts";
import type { ModelDefinition } from "../src/registry/model.registry.ts";

function harness(policy?: CostPolicy) {
  const registry = new ModelRegistry();
  registerStubs(registry);
  return {
    registry,
    router: new ModelRouter({
      registry,
      approvals: new ApprovalStore(),
      budget: new BudgetLedger(0),
      policy,
    }),
  };
}

function addFree(registry: ModelRegistry, id: string, priority = 100): void {
  const def: ModelDefinition = {
    id,
    provider: id.split("/")[0] as string,
    roles: ["VISION"],
    pricing: "free",
    modalities: { input: ["text", "image"], output: ["text"] },
    capabilities: { structuredJson: true, tools: false, context: 200000, output: 65536 },
    availability: true,
    priority,
    enabled: true,
  };
  registry.register(def);
}

function addPaid(registry: ModelRegistry, id: string, pricing: "premium" | "unknown"): void {
  const def: ModelDefinition = {
    id,
    provider: id.split("/")[0] as string,
    roles: ["VISION"],
    pricing,
    modalities: { input: ["text", "image"], output: ["text"] },
    capabilities: { structuredJson: true, tools: false, context: 200000, output: 65536 },
    availability: true,
    priority: 500,
    enabled: true,
    ...(pricing === "premium" ? { cost: { inputPer1M: 1, outputPer1M: 2 } } : {}),
  };
  registry.register(def);
}

describe("model router", () => {
  it("refuses to route MAIN_CODER", () => {
    const { router } = harness();
    expect(() => router.resolve({ role: "MAIN_CODER" })).toThrowError(/Role not routable/);
  });

  it("resolves deterministically to the highest-priority free model", () => {
    const { registry, router } = harness("FREE_ONLY");
    addFree(registry, "openrouter/free", 100);
    addFree(registry, "other/free2", 50);
    const a = router.resolve({ role: "VISION" });
    const b = router.resolve({ role: "VISION" });
    expect(a.model.modelId).toBe("free");
    expect(b).toEqual(a); // deterministic
  });

  it("falls back to a stub when no candidate satisfies capabilities", () => {
    const { router } = harness("FREE_ONLY");
    const decision = router.resolve({ role: "VISION", structuredJson: true });
    expect(decision.basis).toBe("stub");
    expect(decision.requiresApproval).toBe(false);
  });

  it("never silently falls back from free to paid under FREE_ONLY", () => {
    const { registry, router } = harness("FREE_ONLY");
    addPaid(registry, "paid/premium", "premium");
    expect(() => router.resolve({ role: "VISION" })).toThrowError(CostPolicyError);
  });

  it("under PREFERRED_FREE, refuses an unapproved free -> paid fallback", () => {
    const approvals = new ApprovalStore();
    const registry = new ModelRegistry();
    registerStubs(registry);
    addPaid(registry, "paid/premium", "premium");
    const router = new ModelRouter({
      registry,
      approvals,
      budget: new BudgetLedger(0),
      policy: "PREFERRED_FREE",
    });
    try {
      router.resolve({ role: "VISION" });
      expect.fail("expected CostPolicyError");
    } catch (e) {
      expect(e).toBeInstanceOf(CostPolicyError);
      expect((e as CostPolicyError).code).toBe("PAID_FALLBACK_NOT_APPROVED");
    }
  });

  it("under PREFERRED_FREE, an approved paid model is usable", () => {
    const approvals = new ApprovalStore();
    approvals.grant({ modelId: "paid/premium", scope: "run", grantedAt: 0 });
    const registry = new ModelRegistry();
    registerStubs(registry);
    addPaid(registry, "paid/premium", "premium");
    const router = new ModelRouter({
      registry,
      approvals,
      budget: new BudgetLedger(1),
      policy: "PREFERRED_FREE",
    });
    const decision = router.resolve({ role: "VISION" });
    expect(decision.requiresApproval).toBe(false);
    expect(decision.basis).toBe("explicit-approval");
  });

  it("under PREMIUM_ALLOWED, unapproved paid use requests approval instead of throwing", () => {
    const registry = new ModelRegistry();
    registerStubs(registry);
    addPaid(registry, "paid/premium", "premium");
    const router = new ModelRouter({
      registry,
      approvals: new ApprovalStore(),
      budget: new BudgetLedger(0),
      policy: "PREMIUM_ALLOWED",
    });
    const decision = router.resolve({ role: "VISION" });
    expect(decision.requiresApproval).toBe(true);
    expect(decision.basis).toBe("explicit-approval");
  });

  it("blocks unknown pricing without an explicit approval", () => {
    const approvals = new ApprovalStore();
    const registry = new ModelRegistry();
    registerStubs(registry);
    addPaid(registry, "unknown/mystery", "unknown");
    const router = new ModelRouter({
      registry,
      approvals,
      budget: new BudgetLedger(0),
      policy: "PREMIUM_ALLOWED",
    });
    expect(() => router.resolve({ role: "VISION" })).toThrowError(/unknown pricing/i);
  });

  it("respects the spend budget of zero even when a model is approved", () => {
    const approvals = new ApprovalStore();
    approvals.grant({ modelId: "paid/premium", scope: "run", grantedAt: 0 });
    const registry = new ModelRegistry();
    registerStubs(registry);
    addPaid(registry, "paid/premium", "premium");
    const router = new ModelRouter({
      registry,
      approvals,
      budget: new BudgetLedger(0),
      policy: "BALANCED",
    });
    // An approval exists, but spendBudgetUsd = 0 still blocks the paid call.
    expect(() => router.resolve({ role: "VISION" })).toThrowError(/Spend budget exceeded/);
  });
});
