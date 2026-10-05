/**
 * Capability system primitives (P3).
 *
 * The capability layer is the extensible vocabulary by which models are
 * described and selected. It is deliberately decoupled from the frozen P1
 * role/registry layer: capability ids are plain strings, so a capability that
 * does not exist yet can still be registered, matched, and routed without
 * rewriting the router.
 *
 * Cost vocabulary. The P3 spec describes cost in its own terms:
 *
 *   cost classes : FREE | PAID | UNKNOWN_COST
 *   policies    : FREE_ONLY | ASK_BEFORE_PAID | PAID_ALLOWED | BALANCED | PREMIUM_ALLOWED
 *
 * The frozen P0/P1 layer already owns a test-pinned policy list
 * (`COST_POLICIES`) and pricing taxonomy (`PRICING`), and those contracts are
 * NOT modified. Instead this layer defines its own vocabulary and maps onto
 * the frozen one, so frozen behavior is preserved byte-for-byte while the
 * architecture supports the fuller taxonomy:
 *
 *   FREE          -> pricing "free"
 *   PAID          -> pricing "premium"
 *   UNKNOWN_COST  -> pricing "unknown"   (frozen rule: unknown is never free)
 *
 *   FREE_ONLY       -> FREE_ONLY          (frozen default)
 *   ASK_BEFORE_PAID -> PREFERRED_FREE     (free first; paid needs approval)
 *   PAID_ALLOWED    -> PREMIUM_ALLOWED
 *   BALANCED        -> BALANCED
 *   PREMIUM_ALLOWED -> PREMIUM_ALLOWED
 */

import type { CostPolicy, Pricing } from "../registry/cost-policy.ts";

/** Input/output modalities a model can consume or produce. */
export const MODALITIES = ["TEXT", "IMAGE", "VIDEO", "AUDIO"] as const;
export type Modality = (typeof MODALITIES)[number];

/**
 * Cost classification. `UNKNOWN_COST` is distinct from `PAID`: it means the
 * price has not been verified from provider metadata. Per the frozen defaults
 * unknown pricing is treated as premium and is blocked unless explicitly
 * approved — it is never silently assumed free.
 */
export const COST_CLASSES = ["FREE", "PAID", "UNKNOWN_COST"] as const;
export type CostClass = (typeof COST_CLASSES)[number];

/**
 * Capability-layer cost policies. These are the policies the Model & Capability
 * layer reasons in; `toRouterPolicy` projects them onto the frozen policy set.
 */
export const CAPABILITY_COST_POLICIES = [
  "FREE_ONLY",
  "ASK_BEFORE_PAID",
  "PAID_ALLOWED",
  "BALANCED",
  "PREMIUM_ALLOWED",
] as const;
export type CapabilityCostPolicy = (typeof CAPABILITY_COST_POLICIES)[number];

/** Frozen default: FREE_ONLY, matching DEFAULT_COST_POLICY. */
export const DEFAULT_CAPABILITY_COST_POLICY: CapabilityCostPolicy = "FREE_ONLY";

/** A capability's family, used for grouping and media gating. */
export const CAPABILITY_CATEGORIES = [
  "text-generation",
  "reasoning",
  "perception",
  "image-generation",
  "video-generation",
  "audio-generation",
  "embedding",
  "utility",
] as const;
export type CapabilityCategory = (typeof CAPABILITY_CATEGORIES)[number];

/**
 * Capability descriptor. `requiresInput`/`requiresOutput` are the modality
 * requirements a model MUST satisfy to be considered compatible; they are
 * derived from the capability's nature, not from any one provider.
 *
 * `mediaGated` marks capabilities that produce or edit media. The frozen
 * default `media.enabled = false` blocks these unconditionally.
 */
export interface CapabilityDescriptor {
  readonly id: string;
  readonly category: CapabilityCategory | (string & {});
  readonly description: string;
  readonly requiresInput: readonly Modality[];
  readonly requiresOutput: readonly Modality[];
  readonly mediaGated?: boolean;
}

export function toPricing(costClass: CostClass): Pricing {
  switch (costClass) {
    case "FREE":
      return "free";
    case "PAID":
      return "premium";
    case "UNKNOWN_COST":
      return "unknown";
  }
}

export function toCostClass(pricing: Pricing): CostClass {
  switch (pricing) {
    case "free":
      return "FREE";
    case "premium":
      return "PAID";
    case "unknown":
      return "UNKNOWN_COST";
  }
}

export function toRouterPolicy(policy: CapabilityCostPolicy): CostPolicy {
  switch (policy) {
    case "FREE_ONLY":
      return "FREE_ONLY";
    case "ASK_BEFORE_PAID":
      return "PREFERRED_FREE";
    case "PAID_ALLOWED":
      return "PREMIUM_ALLOWED";
    case "BALANCED":
      return "BALANCED";
    case "PREMIUM_ALLOWED":
      return "PREMIUM_ALLOWED";
  }
}

/**
 * Whether a policy permits paid cost at all (subject to approval + budget).
 * FREE_ONLY permits none; everything else may consider paid models, but never
 * silently — approval is always required before a paid model can execute.
 */
export function policyAllowsPaid(policy: CapabilityCostPolicy): boolean {
  return policy !== "FREE_ONLY";
}

/** Whether the policy prefers free models first (every policy except pure paid). */
export function policyPrefersFree(policy: CapabilityCostPolicy): boolean {
  return policy === "FREE_ONLY" || policy === "ASK_BEFORE_PAID" || policy === "BALANCED";
}
