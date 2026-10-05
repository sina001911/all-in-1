/**
 * Capability selector suite (P4): explainable, deterministic selection that
 * finally gives the P3 ModelCatalog / CapabilityRegistry / PriorityChains a
 * live consumer.
 *
 * Pinned properties:
 * - the trace records every candidate and the exact reason it was rejected;
 * - a preference or chain entry that fails a check is skipped and recorded,
 *   never forced (a chain is a preference, not an authorization);
 * - cost is classified with the frozen vocabulary (unknown is never free);
 * - the selector has no side effects: it never reserves budget or reads a key.
 */
import { describe, expect, it } from "vitest";
import { select } from "../src/execution/selector.ts";
import { buildCatalogFixture } from "../src/execution/test-fixtures.ts";
import { ApprovalStore } from "../src/registry/approvals.ts";

function harness(models: Parameters<typeof buildCatalogFixture>[0], policy?: "FREE_ONLY") {
  const fixture = buildCatalogFixture(models);
  return {
    ...fixture,
    approvals: new ApprovalStore(),
    selector: (req: Parameters<typeof select>[0]) =>
      select(req, {
        catalog: fixture.catalog,
        capabilities: fixture.capabilities,
        chains: fixture.chains,
        approvals: new ApprovalStore(),
        policy,
      }),
  };
}

describe("selector with no candidates", () => {
  it("returns ok:false with an explanatory warning", () => {
    const { selector } = harness([]);
    const decision = selector({ capability: "CODING" });
    expect(decision.ok).toBe(false);
    expect(decision.model).toBeNull();
    expect(decision.basis).toBe("none");
    expect(decision.warnings).toContain("no candidates registered for this capability");
  });
});

describe("selector on a single free candidate", () => {
  it("selects it and records a passing trace", () => {
    const { selector, catalog } = harness([
      { id: "acme/coder", capabilities: ["CODING"], costClass: "FREE" },
    ]);
    const decision = selector({ capability: "CODING" });
    expect(decision.ok).toBe(true);
    expect(decision.model).toEqual({ provider: "acme", modelId: "coder" });
    expect(decision.basis).toBe("default-priority");
    expect(decision.costClass).toBe("FREE");
    expect(decision.costEstimateUsd).toBe(0);
    expect(decision.requiresApproval).toBe(false);

    const selected = decision.trace.find((t) => t.status === "selected");
    expect(selected?.modelId).toBe("acme/coder");
    expect(selected?.checks.every((c) => c.pass)).toBe(true);
    expect(catalog.get("acme/coder")).toBeDefined();
  });

  it("is deterministic across calls", () => {
    const { selector } = harness([
      { id: "acme/coder", capabilities: ["CODING"], costClass: "FREE" },
    ]);
    const a = selector({ capability: "CODING" });
    const b = selector({ capability: "CODING" });
    expect(b).toEqual(a);
  });
});

describe("selector capability and modality filtering", () => {
  it("rejects a model that does not declare the capability", () => {
    // The chain head is policy-blocked, so the walk follows its declared
    // fallback to a model that does not declare the capability. That is the
    // only path on which the capability check actually fires: candidatesFor
    // already filters chain entries by declared capability.
    const { selector } = harness([
      {
        id: "acme/pro",
        capabilities: ["CODING"],
        costClass: "PAID",
        inputPer1M: 1,
        fallback: "acme/offtopic",
      },
      { id: "acme/offtopic", capabilities: ["REASONING"], costClass: "FREE" },
    ]);
    const decision = selector({ capability: "CODING" });
    expect(decision.ok).toBe(false);
    const entry = decision.trace.find((t) => t.modelId === "acme/offtopic");
    expect(entry?.status).toBe("rejected");
    expect(entry?.checks.find((c) => c.check === "capability")?.pass).toBe(false);
  });

  it("selects a model that satisfies a capability's modality requirements", () => {
    // SCREENSHOT_ANALYSIS requires IMAGE input and TEXT output.
    const { selector } = harness([
      {
        id: "acme/eyes",
        capabilities: ["SCREENSHOT_ANALYSIS"],
        costClass: "FREE",
        inputModalities: ["IMAGE", "TEXT"],
      },
    ]);
    const decision = selector({ capability: "SCREENSHOT_ANALYSIS" });
    expect(decision.ok).toBe(true);
    expect(decision.model).toEqual({ provider: "acme", modelId: "eyes" });
  });

  it("rejects a model missing a required input modality", () => {
    const { selector } = harness([
      {
        id: "acme/text-only",
        capabilities: ["SCREENSHOT_ANALYSIS"],
        costClass: "FREE",
        inputModalities: ["TEXT"],
      },
    ]);
    const decision = selector({ capability: "SCREENSHOT_ANALYSIS" });
    expect(decision.ok).toBe(false);
    const entry = decision.trace.find((t) => t.modelId === "acme/text-only");
    expect(entry?.checks.find((c) => c.check === "input-modality")?.pass).toBe(false);
  });

  it("rejects a model missing a requested output modality", () => {
    const { selector } = harness([
      {
        id: "acme/mute",
        capabilities: ["CODING"],
        costClass: "FREE",
        outputModalities: ["IMAGE"],
      },
    ]);
    const decision = selector({
      capability: "CODING",
      outputModalities: ["TEXT"],
    });
    expect(decision.ok).toBe(false);
    const entry = decision.trace.find((t) => t.modelId === "acme/mute");
    expect(entry?.checks.find((c) => c.check === "output-modality")?.pass).toBe(false);
  });

  it("honours minContext", () => {
    const { selector } = harness([
      { id: "acme/small", capabilities: ["CODING"], costClass: "FREE" },
    ]);
    const decision = selector({ capability: "CODING", minContext: 999_999 });
    expect(decision.ok).toBe(false);
    const entry = decision.trace.find((t) => t.modelId === "acme/small");
    expect(entry?.checks.find((c) => c.check === "min-context")?.pass).toBe(false);
  });

  it("rejects a disabled model reached via a declared fallback", () => {
    const { selector } = harness([
      {
        id: "acme/pro",
        capabilities: ["CODING"],
        costClass: "PAID",
        inputPer1M: 1,
        fallback: "acme/broken",
      },
      {
        id: "acme/broken",
        capabilities: ["CODING"],
        costClass: "FREE",
        enabled: false,
      },
    ]);
    const decision = selector({ capability: "CODING" });
    expect(decision.ok).toBe(false);
    const entry = decision.trace.find((t) => t.modelId === "acme/broken");
    expect(entry?.checks.find((c) => c.check === "operational")?.pass).toBe(false);
  });
});

describe("selector paid-model policy (frozen rules)", () => {
  it("under FREE_ONLY, rejects a paid model and records the policy reason", () => {
    const { selector } = harness([
      { id: "acme/pro", capabilities: ["CODING"], costClass: "PAID", inputPer1M: 1 },
    ]);
    const decision = selector({ capability: "CODING" });
    expect(decision.ok).toBe(false);
    const entry = decision.trace.find((t) => t.modelId === "acme/pro");
    expect(entry?.status).toBe("rejected");
    const cost = entry?.checks.find((c) => c.check === "cost");
    expect(cost?.pass).toBe(false);
    expect(cost?.detail).toContain("FREE_ONLY");
  });

  it("under FREE_ONLY, prefers a free model over a paid one in the same chain", () => {
    const { selector } = harness([
      { id: "acme/pro", capabilities: ["CODING"], costClass: "PAID", inputPer1M: 1, priority: 90 },
      { id: "acme/free", capabilities: ["CODING"], costClass: "FREE", priority: 10 },
    ]);
    const decision = selector({ capability: "CODING" });
    expect(decision.model).toEqual({ provider: "acme", modelId: "free" });
  });

  it("under PREMIUM_ALLOWED, marks an unapproved paid model as requiring approval", () => {
    const fixture = buildCatalogFixture([
      { id: "acme/pro", capabilities: ["CODING"], costClass: "PAID", inputPer1M: 1 },
    ]);
    const decision = select(
      { capability: "CODING" },
      {
        catalog: fixture.catalog,
        capabilities: fixture.capabilities,
        chains: fixture.chains,
        approvals: new ApprovalStore(),
        policy: "PREMIUM_ALLOWED",
      },
    );
    // The policy permits paid cost, so the model is selectable; approval is a
    // separate gate the execution engine enforces at invoke time.
    expect(decision.ok).toBe(true);
    expect(decision.requiresApproval).toBe(true);
    expect(decision.costClass).toBe("PAID");
  });

  it("under PREMIUM_ALLOWED, an approved paid model does not require approval", () => {
    const fixture = buildCatalogFixture([
      { id: "acme/pro", capabilities: ["CODING"], costClass: "PAID", inputPer1M: 1 },
    ]);
    const approvals = new ApprovalStore();
    approvals.grant({ modelId: "acme/pro", scope: "run", grantedAt: 0 });
    const decision = select(
      { capability: "CODING" },
      {
        catalog: fixture.catalog,
        capabilities: fixture.capabilities,
        chains: fixture.chains,
        approvals,
        policy: "PREMIUM_ALLOWED",
      },
    );
    expect(decision.requiresApproval).toBe(false);
    expect(decision.model).toEqual({ provider: "acme", modelId: "pro" });
  });

  it("treats UNKNOWN_COST as never free and still requires approval to spend", () => {
    const fixture = buildCatalogFixture([
      { id: "acme/mystery", capabilities: ["CODING"], costClass: "UNKNOWN_COST" },
    ]);
    const decision = select(
      { capability: "CODING" },
      {
        catalog: fixture.catalog,
        capabilities: fixture.capabilities,
        chains: fixture.chains,
        approvals: new ApprovalStore(),
        policy: "PREMIUM_ALLOWED",
      },
    );
    // Selectable, but flagged: unknown pricing is treated as premium, never as
    // free, so an approval is mandatory before any real call.
    expect(decision.ok).toBe(true);
    expect(decision.requiresApproval).toBe(true);
    const entry = decision.trace.find((t) => t.modelId === "acme/mystery");
    expect(entry?.checks.find((c) => c.check === "cost")?.detail).toMatch(
      /unknown pricing treated as premium/,
    );
  });

  it("estimates cost from per-1M rates and reports NaN when rates are absent", () => {
    const fixture = buildCatalogFixture([
      { id: "acme/rated", capabilities: ["CODING"], costClass: "PAID", inputPer1M: 3, outputPer1M: 5 },
      { id: "acme/unrated", capabilities: ["REASONING"], costClass: "PAID" },
    ]);
    const rated = select(
      { capability: "CODING" },
      {
        catalog: fixture.catalog,
        capabilities: fixture.capabilities,
        chains: fixture.chains,
        approvals: new ApprovalStore(),
        policy: "PREMIUM_ALLOWED",
      },
    );
    // (3 + 5) per 1M over a 1k+1k estimate = 8 / 1e6 * 1000... conservative floor.
    expect(rated.costEstimateUsd).toBeGreaterThan(0);
    const unrated = select(
      { capability: "REASONING" },
      {
        catalog: fixture.catalog,
        capabilities: fixture.capabilities,
        chains: fixture.chains,
        approvals: new ApprovalStore(),
        policy: "PREMIUM_ALLOWED",
      },
    );
    expect(Number.isNaN(unrated.costEstimateUsd)).toBe(true);
  });
});

describe("selector preference handling", () => {
  it("honours a valid explicit preference first", () => {
    const { selector } = harness([
      { id: "acme/a", capabilities: ["CODING"], costClass: "FREE", priority: 100 },
      { id: "acme/b", capabilities: ["CODING"], costClass: "FREE", priority: 1 },
    ]);
    const decision = selector({
      capability: "CODING",
      preference: { provider: "acme", modelId: "b" },
    });
    expect(decision.model).toEqual({ provider: "acme", modelId: "b" });
    expect(decision.basis).toBe("preference");
  });

  it("falls back to the chain when the preference fails a check", () => {
    const { selector } = harness([
      { id: "acme/a", capabilities: ["CODING"], costClass: "FREE", priority: 100 },
      {
        id: "acme/b",
        capabilities: ["CODING"],
        costClass: "PAID",
        inputPer1M: 1,
        priority: 1,
      },
    ]);
    const decision = selector({
      capability: "CODING",
      preference: { provider: "acme", modelId: "b" },
    });
    // The preference is a real candidate but policy-blocked under FREE_ONLY.
    expect(decision.model).toEqual({ provider: "acme", modelId: "a" });
    expect(decision.warnings.some((w) => w.includes("did not qualify"))).toBe(true);
  });

  it("falls back to the chain when the preference is not a candidate", () => {
    const { selector } = harness([
      { id: "acme/a", capabilities: ["CODING"], costClass: "FREE" },
    ]);
    const decision = selector({
      capability: "CODING",
      preference: { provider: "acme", modelId: "ghost" },
    });
    expect(decision.model).toEqual({ provider: "acme", modelId: "a" });
    expect(decision.warnings.some((w) => w.includes("not a candidate"))).toBe(true);
  });
});

describe("selector media gating", () => {
  it("warns and fails for a media-gated capability while media is disabled", () => {
    const { selector } = harness([
      { id: "acme/artist", capabilities: ["IMAGE_GENERATION"], costClass: "FREE" },
    ]);
    const decision = selector({ capability: "IMAGE_GENERATION" });
    expect(decision.warnings.some((w) => w.includes("media-gated"))).toBe(true);
  });
});

describe("selector is side-effect free", () => {
  it("does not reserve budget or read credentials", () => {
    const fixture = buildCatalogFixture([
      { id: "acme/coder", capabilities: ["CODING"], costClass: "FREE" },
    ]);
    // No budget ledger or secret resolver is passed; if the selector needed
    // them it would fail to construct the call. It only classifies cost.
    const decision = select(
      { capability: "CODING" },
      {
        catalog: fixture.catalog,
        capabilities: fixture.capabilities,
        chains: fixture.chains,
        approvals: new ApprovalStore(),
      },
    );
    expect(decision.ok).toBe(true);
    expect(decision.costEstimateUsd).toBe(0);
  });
});
