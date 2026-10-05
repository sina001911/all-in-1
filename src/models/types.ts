/**
 * Model & Capability layer — descriptor contract (P3).
 *
 * A `ModelDescriptor` is the complete, provider-agnostic description of one
 * model: what it can do, what it can consume and produce, its limits, its
 * cost, where it runs, and which adapter speaks to it. The application is
 * never hard-coded around a specific model; it is written against this
 * contract.
 *
 * Relationship to the frozen P1 layer: `ModelDefinition` (role-tagged) is the
 * frozen role registry and is untouched. This descriptor is the richer
 * capability-tagged catalogue that P3 routing uses. The two are bridged, not
 * merged: cost is still enforced through the frozen `Pricing` taxonomy via
 * `toPricing()`.
 */
import type { CostClass, Modality } from "../capabilities/types.ts";

export const MODEL_STATUS = ["active", "beta", "deprecated", "disabled"] as const;
export type ModelStatus = (typeof MODEL_STATUS)[number];

export const LOCALITIES = ["local", "remote"] as const;
export type Locality = (typeof LOCALITIES)[number];

/**
 * Pricing metadata. `costClass` is the P3 classification; the optional per-1M
 * rates are recorded ONLY from verified provider pricing metadata. Absent
 * rates on a `PAID`/`UNKNOWN_COST` model mean the cost cannot be estimated,
 * which the selector surfaces rather than guesses.
 */
export interface ModelPricing {
  readonly costClass: CostClass;
  readonly inputPer1M?: number;
  readonly outputPer1M?: number;
  /** Provenance note: how the cost class was determined. Never a secret. */
  readonly notes?: string;
}

/**
 * Registry key: `provider/model`. The model id is unique within its provider;
 * the composite key is globally unique in the catalogue.
 */
export interface ModelDescriptor {
  readonly id: string;
  readonly provider: string;
  readonly modelId: string;
  readonly displayName: string;

  /** Capability ids this model may serve. Extensible strings, not an enum. */
  readonly capabilities: readonly string[];
  readonly inputModalities: readonly Modality[];
  readonly outputModalities: readonly Modality[];

  readonly contextLimit: number;
  readonly outputLimit: number;
  readonly tools: boolean;
  readonly structuredOutput: boolean;
  readonly streaming: boolean;

  readonly pricing: ModelPricing;

  /** Operational availability (false = temporarily out of service). */
  readonly available: boolean;
  /** Local (user-owned) vs remote (hosted/API). */
  readonly locality: Locality;
  /** Lifecycle status. `disabled` and `deprecated` are never selected. */
  readonly status: ModelStatus;
  /** Adapter id that speaks this provider's protocol. */
  readonly providerAdapter: string;

  /** Default preference weight (higher = preferred). User chains override. */
  readonly priority: number;
  /** Next model id in this model's declared fallback order. */
  readonly fallback?: string;

  /** Off by default; a model must be enabled AND available to be selected. */
  readonly enabled: boolean;

  /**
   * Immutable binding. MAIN_CODER (Atria-Dawn-Preview) carries this flag and is
   * therefore invisible to selection, mirroring the frozen `fixed` rule.
   */
  readonly fixed?: boolean;

  readonly tags?: readonly string[];
}

export interface ModelRef {
  readonly provider: string;
  readonly modelId: string;
}

export function modelId(ref: ModelRef): string {
  return `${ref.provider}/${ref.modelId}`;
}

export interface CheckResult {
  readonly check: string;
  readonly pass: boolean;
  readonly detail: string;
}

export interface TraceEntry {
  readonly modelId: string;
  readonly provider: string;
  readonly status: "selected" | "rejected";
  readonly reason: string;
  readonly checks: readonly CheckResult[];
}

export type SelectionBasis =
  | "manual"
  | "preference"
  | "priority-chain"
  | "default-priority"
  | "fallback"
  | "none";

/**
 * Every routing decision is deterministic and explainable: the trace records
 * every candidate considered and exactly why it was accepted or rejected.
 *
 * `ok: false` means NO model may execute for this request. `requiresApproval`
 * is true when the decision names a paid model whose use needs a recorded
 * approval before it can execute — the caller grants it, then re-selects.
 */
export interface SelectionDecision {
  readonly ok: boolean;
  readonly mode: "manual" | "auto";
  readonly capability: string;
  readonly model: ModelRef | null;
  readonly basis: SelectionBasis;
  readonly costClass: CostClass | null;
  readonly costEstimateUsd: number;
  readonly requiresApproval: boolean;
  readonly trace: readonly TraceEntry[];
  readonly warnings: readonly string[];
}

export interface SelectionRequest {
  readonly capability: string;
  /** Required input modalities; merged with the capability's own requirements. */
  readonly inputModalities?: readonly Modality[];
  readonly outputModalities?: readonly Modality[];
  readonly tools?: boolean;
  readonly structuredOutput?: boolean;
  readonly streaming?: boolean;
  readonly minContext?: number;
  /** Explicit user/project preference, honoured first when valid. */
  readonly preference?: ModelRef;
  readonly excludeModelIds?: readonly string[];
  /**
   * Invocation inputs (P4). Optional so pure routing requests need no payload;
   * the execution engine forwards them to the adapter.
   */
  readonly inputs?: ReadonlyArray<
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "image"; readonly artifactId: string }
  >;
}

export interface ManualSelection extends ModelRef {
  readonly capability: string;
  readonly inputModalities?: readonly Modality[];
  readonly outputModalities?: readonly Modality[];
  readonly tools?: boolean;
  readonly structuredOutput?: boolean;
  readonly streaming?: boolean;
  readonly minContext?: number;
}
