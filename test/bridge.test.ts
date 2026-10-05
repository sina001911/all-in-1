/**
 * Router <-> selector bridge suite (P4).
 *
 * The bridge is the ONLY place that translates between the frozen role-based
 * vocabulary and the capability-based one, so the frozen layer stays intact.
 * Pinned: every role maps to exactly one capability, and a router decision is
 * carried over losslessly enough to drive capability-based execution.
 */
import { describe, expect, it } from "vitest";
import {
  bridgeRouterDecision,
  capabilityForRole,
  selectionRequestFromRole,
} from "../src/registry/bridge.ts";
import type { RouterDecision } from "../src/registry/cost-policy.ts";

describe("capabilityForRole", () => {
  it("maps every text role to a capability", () => {
    expect(capabilityForRole("MAIN_CODER")).toBe("CODING");
    expect(capabilityForRole("CODING_ASSISTANT")).toBe("CODING");
    expect(capabilityForRole("DEEP_REASONING")).toBe("DEEP_REASONING");
    expect(capabilityForRole("CODE_REVIEWER")).toBe("CODE_REVIEW");
    expect(capabilityForRole("FAST_TASK")).toBe("FAST_TASK");
  });

  it("maps every vision role to the screenshot-analysis capability", () => {
    expect(capabilityForRole("VISION")).toBe("SCREENSHOT_ANALYSIS");
    expect(capabilityForRole("VISUAL_QA")).toBe("SCREENSHOT_ANALYSIS");
  });

  it("never returns an empty capability", () => {
    expect(capabilityForRole("MODEL_ROUTER").length).toBeGreaterThan(0);
    expect(capabilityForRole("IMAGE_GENERATOR").length).toBeGreaterThan(0);
  });
});

describe("selectionRequestFromRole", () => {
  it("builds a request on the role's capability", () => {
    const req = selectionRequestFromRole("CODE_REVIEWER");
    expect(req.capability).toBe("CODE_REVIEW");
    expect(req.preference).toBeUndefined();
  });

  it("applies overrides without losing the capability", () => {
    const req = selectionRequestFromRole("FAST_TASK", {
      tools: true,
      minContext: 8000,
    });
    expect(req.capability).toBe("FAST_TASK");
    expect(req.tools).toBe(true);
    expect(req.minContext).toBe(8000);
  });
});

describe("bridgeRouterDecision", () => {
  const router: RouterDecision = {
    model: { providerId: "atria", modelId: "s1" },
    basis: "policy",
    costEstimateUsd: 0,
    requiresApproval: false,
    alternativesConsidered: [
      { model: "openrouter/paid", rejectedBecause: "paid under FREE_ONLY" },
    ],
  };

  it("carries the selected model into a SelectionDecision", () => {
    const decision = bridgeRouterDecision(router, "CODING");
    expect(decision.ok).toBe(true);
    expect(decision.model).toEqual({ provider: "atria", modelId: "s1" });
    expect(decision.capability).toBe("CODING");
    expect(decision.requiresApproval).toBe(false);
  });

  it("maps the router basis onto a selection basis", () => {
    expect(bridgeRouterDecision(router, "CODING").basis).toBe("default-priority");
    expect(
      bridgeRouterDecision({ ...router, basis: "explicit-approval" }, "CODING").basis,
    ).toBe("preference");
    expect(bridgeRouterDecision({ ...router, basis: "stub" }, "CODING").basis).toBe("none");
  });

  it("records the router's own alternatives as a trace", () => {
    const decision = bridgeRouterDecision(router, "CODING");
    expect(decision.trace).toHaveLength(1);
    const entry = decision.trace[0];
    expect(entry?.status).toBe("selected");
    expect(entry?.checks).toEqual([
      {
        check: "router-policy",
        pass: false,
        detail: "openrouter/paid: paid under FREE_ONLY",
      },
    ]);
  });

  it("preserves the cost estimate", () => {
    const decision = bridgeRouterDecision(
      { ...router, costEstimateUsd: 0.012 },
      "CODING",
    );
    expect(decision.costEstimateUsd).toBeCloseTo(0.012);
  });
});
