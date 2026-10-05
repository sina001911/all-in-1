/**
 * Capability system suite (P3).
 *
 * The capability layer is the extensible vocabulary models are described and
 * selected with. Two properties are pinned here: an UNKNOWN capability id is
 * never an error (it simply carries no modality requirements), and the
 * capability cost vocabulary projects onto the frozen P0/P1 policy set without
 * modifying it.
 */
import { describe, expect, it } from "vitest";
import { CapabilityRegistry } from "../src/capabilities/registry.ts";
import {
  CAPABILITIES,
  MEDIA_GATED_CAPABILITIES,
  registerBaselineCapabilities,
} from "../src/capabilities/capabilities.ts";
import {
  CAPABILITY_CATEGORIES,
  CAPABILITY_COST_POLICIES,
  COST_CLASSES,
  DEFAULT_CAPABILITY_COST_POLICY,
  MODALITIES,
  policyAllowsPaid,
  policyPrefersFree,
  toCostClass,
  toPricing,
  toRouterPolicy,
} from "../src/capabilities/types.ts";
import { DEFAULT_COST_POLICY, isEffectivelyFree } from "../src/registry/cost-policy.ts";

describe("CapabilityRegistry", () => {
  it("registers and looks up a descriptor", () => {
    const reg = new CapabilityRegistry();
    reg.register({
      id: "WIDGET_ANALYSIS",
      category: "utility",
      description: "A custom capability",
      requiresInput: ["TEXT"],
      requiresOutput: ["TEXT"],
    });
    expect(reg.has("WIDGET_ANALYSIS")).toBe(true);
    expect(reg.get("WIDGET_ANALYSIS")?.description).toBe("A custom capability");
  });

  it("lists every registered capability", () => {
    const reg = new CapabilityRegistry();
    reg.register({
      id: "A",
      category: "utility",
      description: "a",
      requiresInput: [],
      requiresOutput: [],
    });
    reg.register({
      id: "B",
      category: "utility",
      description: "b",
      requiresInput: [],
      requiresOutput: [],
    });
    expect(reg.list().map((c) => c.id).sort()).toEqual(["A", "B"]);
  });

  it("rejects ids that are not UPPER_SNAKE_CASE", () => {
    const reg = new CapabilityRegistry();
    const bad = [
      "lowercase",
      "mixedCase",
      "1LEADING_DIGIT",
      "has-dash",
      "has space",
    ];
    for (const id of bad) {
      expect(() =>
        reg.register({ id, category: "utility", description: "x", requiresInput: [], requiresOutput: [] }),
      ).toThrow(/Invalid capability id/);
    }
  });

  it("rejects a duplicate id", () => {
    const reg = new CapabilityRegistry();
    reg.register({
      id: "DUP",
      category: "utility",
      description: "x",
      requiresInput: [],
      requiresOutput: [],
    });
    expect(() =>
      reg.register({ id: "DUP", category: "utility", description: "x", requiresInput: [], requiresOutput: [] }),
    ).toThrow(/already registered/);
  });

  it("exposes modality requirements for a known capability", () => {
    const reg = new CapabilityRegistry();
    reg.register({
      id: "VISION",
      category: "perception",
      description: "Image -> structured analysis.",
      requiresInput: ["IMAGE"],
      requiresOutput: ["TEXT"],
    });
    expect(reg.requirements("VISION")).toEqual({
      requiresInput: ["IMAGE"],
      requiresOutput: ["TEXT"],
      mediaGated: false,
    });
  });

  it("treats an unknown capability as requirement-free, not an error", () => {
    const reg = new CapabilityRegistry();
    expect(reg.requirements("SOMETHING_NEW")).toEqual({
      requiresInput: [],
      requiresOutput: [],
      mediaGated: false,
    });
    expect(reg.get("SOMETHING_NEW")).toBeUndefined();
  });

  it("flags media-gated capabilities", () => {
    const reg = new CapabilityRegistry();
    reg.register({
      id: "IMAGE_GENERATION",
      category: "image-generation",
      description: "Text -> image.",
      requiresInput: ["TEXT"],
      requiresOutput: ["IMAGE"],
      mediaGated: true,
    });
    expect(reg.requirements("IMAGE_GENERATION").mediaGated).toBe(true);
  });
});

describe("baseline capability catalogue", () => {
  it("registers every baseline capability", () => {
    const reg = new CapabilityRegistry();
    registerBaselineCapabilities(reg);
    expect(reg.list()).toHaveLength(CAPABILITIES.length);
    for (const capability of CAPABILITIES) expect(reg.has(capability.id)).toBe(true);
  });

  it("registers each capability exactly once", () => {
    const reg = new CapabilityRegistry();
    registerBaselineCapabilities(reg);
    const ids = reg.list().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("marks every capability id as UPPER_SNAKE_CASE", () => {
    for (const capability of CAPABILITIES) {
      expect(capability.id).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it("uses only baseline categories", () => {
    for (const capability of CAPABILITIES) {
      expect([...CAPABILITY_CATEGORIES]).toContain(capability.category);
    }
  });

  it("gates exactly the media-producing capabilities", () => {
    const expected = CAPABILITIES.filter((c) => "mediaGated" in c && c.mediaGated === true).map(
      (c) => c.id,
    );
    expect(MEDIA_GATED_CAPABILITIES.slice().sort()).toEqual(expected.slice().sort());
    // Perception capabilities analyse media; they do not produce it.
    expect(MEDIA_GATED_CAPABILITIES).not.toContain("VISION");
    expect(MEDIA_GATED_CAPABILITIES).not.toContain("SCREENSHOT_ANALYSIS");
    expect(MEDIA_GATED_CAPABILITIES).not.toContain("OCR");
    expect(MEDIA_GATED_CAPABILITIES).toContain("IMAGE_GENERATION");
    expect(MEDIA_GATED_CAPABILITIES).toContain("VIDEO_GENERATION");
  });
});

describe("cost vocabulary projection onto the frozen policy set", () => {
  it("maps every cost class to a frozen pricing value", () => {
    expect(toPricing("FREE")).toBe("free");
    expect(toPricing("PAID")).toBe("premium");
    expect(toPricing("UNKNOWN_COST")).toBe("unknown");
  });

  it("round-trips cost class through pricing", () => {
    for (const costClass of COST_CLASSES) expect(toCostClass(toPricing(costClass))).toBe(costClass);
  });

  it("maps every capability policy onto a frozen router policy", () => {
    const frozen = new Set(["FREE_ONLY", "PREFERRED_FREE", "BALANCED", "PREMIUM_ALLOWED", "MANUAL"]);
    expect(toRouterPolicy("FREE_ONLY")).toBe("FREE_ONLY");
    expect(toRouterPolicy("ASK_BEFORE_PAID")).toBe("PREFERRED_FREE");
    expect(toRouterPolicy("PAID_ALLOWED")).toBe("PREMIUM_ALLOWED");
    expect(toRouterPolicy("BALANCED")).toBe("BALANCED");
    expect(toRouterPolicy("PREMIUM_ALLOWED")).toBe("PREMIUM_ALLOWED");
    for (const policy of CAPABILITY_COST_POLICIES) {
      expect(frozen.has(toRouterPolicy(policy))).toBe(true);
    }
  });

  it("defaults to the frozen FREE_ONLY policy", () => {
    expect(DEFAULT_CAPABILITY_COST_POLICY).toBe("FREE_ONLY");
    expect(toRouterPolicy(DEFAULT_CAPABILITY_COST_POLICY)).toBe(DEFAULT_COST_POLICY);
  });

  it("treats unknown cost as never free, mirroring the frozen rule", () => {
    expect(toPricing("UNKNOWN_COST")).toBe("unknown");
    expect(toCostClass("unknown")).toBe("UNKNOWN_COST");
    // Frozen rule: unknown pricing is never silently assumed free.
    expect(isEffectivelyFree(toPricing("UNKNOWN_COST"))).toBe(false);
    expect(isEffectivelyFree(toPricing("FREE"))).toBe(true);
  });

  it("FREE_ONLY permits no paid models; every other policy may consider them", () => {
    expect(policyAllowsPaid("FREE_ONLY")).toBe(false);
    for (const policy of CAPABILITY_COST_POLICIES) {
      if (policy !== "FREE_ONLY") expect(policyAllowsPaid(policy)).toBe(true);
    }
  });

  it("prefers free first under FREE_ONLY, ASK_BEFORE_PAID and BALANCED", () => {
    expect(policyPrefersFree("FREE_ONLY")).toBe(true);
    expect(policyPrefersFree("ASK_BEFORE_PAID")).toBe(true);
    expect(policyPrefersFree("BALANCED")).toBe(true);
    expect(policyPrefersFree("PAID_ALLOWED")).toBe(false);
    expect(policyPrefersFree("PREMIUM_ALLOWED")).toBe(false);
  });

  it("declares the modality vocabulary without audio-less gaps", () => {
    expect([...MODALITIES].sort()).toEqual(["AUDIO", "IMAGE", "TEXT", "VIDEO"]);
  });
});
