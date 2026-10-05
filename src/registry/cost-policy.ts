/**
 * Cost policy + pricing primitives.
 *
 * Frozen defaults (see docs/frozen-defaults.md):
 * - FREE_ONLY is the default policy.
 * - UNKNOWN_COST is blocked by default (treated as premium, never free).
 * - No silent free -> paid fallback.
 */

export const COST_POLICIES = [
  "FREE_ONLY",
  "PREFERRED_FREE",
  "BALANCED",
  "PREMIUM_ALLOWED",
  "MANUAL",
] as const;
export type CostPolicy = (typeof COST_POLICIES)[number];

export const PRICING = ["free", "premium", "unknown"] as const;
export type Pricing = (typeof PRICING)[number];

export const DEFAULT_COST_POLICY: CostPolicy = "FREE_ONLY";
export const UNKNOWN_PRICING_BEHAVIOR: "premium" = "premium";

/** Router decisions are deterministic and fully explainable. */
export interface RouterDecision {
  readonly model: {
    readonly providerId: string;
    readonly modelId: string;
  };
  readonly basis: "policy" | "explicit-approval" | "stub";
  readonly costEstimateUsd: number;
  readonly requiresApproval: boolean;
  readonly alternativesConsidered: ReadonlyArray<{
    readonly model: string;
    readonly rejectedBecause: string;
  }>;
}

export class CostPolicyError extends Error {
  readonly code:
    | "FREE_UNAVAILABLE"
    | "PAID_FALLBACK_NOT_APPROVED"
    | "UNKNOWN_COST_BLOCKED"
    | "BUDGET_EXCEEDED";
  constructor(message: string, code: CostPolicyError["code"]) {
    super(message);
    this.name = "CostPolicyError";
    this.code = code;
  }
}

/** Unknown pricing is NEVER free. */
export function isEffectivelyFree(pricing: Pricing): boolean {
  return pricing === "free";
}

/** Unknown pricing must be surfaced and blocked unless explicitly approved. */
export function isPaidOrUnknown(pricing: Pricing): boolean {
  return pricing !== "free";
}
