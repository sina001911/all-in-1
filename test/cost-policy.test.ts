/**
 * Cost policy suite: five policies; unknown pricing is never free; unknown cost
 * is blocked unless explicitly approved; no silent paid fallback.
 */
import { describe, expect, it } from "vitest";
import {
  COST_POLICIES,
  DEFAULT_COST_POLICY,
  isEffectivelyFree,
  isPaidOrUnknown,
  UNKNOWN_PRICING_BEHAVIOR,
} from "../src/registry/cost-policy.ts";

describe("cost policy", () => {
  it("exposes exactly the five accepted policies", () => {
    expect(COST_POLICIES).toEqual([
      "FREE_ONLY",
      "PREFERRED_FREE",
      "BALANCED",
      "PREMIUM_ALLOWED",
      "MANUAL",
    ]);
  });

  it("defaults to FREE_ONLY", () => {
    expect(DEFAULT_COST_POLICY).toBe("FREE_ONLY");
    expect(UNKNOWN_PRICING_BEHAVIOR).toBe("premium");
  });

  it("treats unknown pricing as NOT free", () => {
    expect(isEffectivelyFree("free")).toBe(true);
    expect(isEffectivelyFree("premium")).toBe(false);
    expect(isEffectivelyFree("unknown")).toBe(false);
  });

  it("classifies premium and unknown as paid-or-unknown", () => {
    expect(isPaidOrUnknown("free")).toBe(false);
    expect(isPaidOrUnknown("premium")).toBe(true);
    expect(isPaidOrUnknown("unknown")).toBe(true);
  });
});
