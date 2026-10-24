/**
 * Collaborate contracts (D34) — the real, configurable multi-model
 * orchestration.
 *
 * Collaborate is the primary objective of the desktop milestone. It is NOT a
 * fixed three-step diagnostic: the human picks every participant, the strategy
 * (parallel / sequential / debate), and an optional synthesis model. Each
 * participant is an independent, fully-gated specialist run. The outputs are
 * reconciled for disagreements and, when a synthesis model is named, combined
 * into one answer with provenance.
 *
 * Security invariants this module protects by construction:
 *   - No participant can carry a tool surface. `SpecialistRequest` has no
 *     `tools` field, and nothing here adds one.
 *   - `MAIN_CODER` is router-immutable: a participant may select it only when
 *     it is a registered, routable binding; otherwise the run fails with
 *     `RoleNotRoutableError` — it is never a silent fallback or default.
 *   - Every participant runs through the specialist runner, hence the P4
 *     engine, hence every one of the seven gates.
 */
import type { ModelRole } from "../registry/roles.ts";
import type { SafetyMode } from "../safety/guard.ts";
import type { SpecialistAccounting } from "../specialists/types.ts";

/** One configured participant. The human names the model and its assignment. */
export interface CollaborateParticipant {
  /** Stable within the run; seeds the per-participant stream key. */
  readonly id: string;
  readonly provider: string;
  readonly modelId: string;
  /** The role the participant answers under. Routed via the P3 bridge. */
  readonly role: ModelRole;
  /** What this participant is asked to do, specific to it. */
  readonly task: string;
  /** Opt-in streaming for this participant; inherits the run default. */
  readonly streaming?: boolean;
}

export type CollaborateStrategy = "parallel" | "sequential" | "debate";

export interface CollaborateRequest {
  /** The original task every participant works on. */
  readonly task: string;
  /** Two or more; one participant is not a collaboration. */
  readonly participants: ReadonlyArray<CollaborateParticipant>;
  readonly strategy: CollaborateStrategy;
  /**
   * Optional synthesis model. When named, a `DEEP_REASONING` specialist run
   * combines the participant outputs and resolves disagreements. Absent: the
   * result is the concatenated participant answers, never a hidden fallback.
   */
  readonly synthesis?: { readonly provider: string; readonly modelId: string };
  readonly mode: SafetyMode;
  /** Explicit autonomous opt-in; bounded exactly as a workflow is. */
  readonly auto?: boolean;
  readonly timeoutMs?: number;
  /** Prime every participant for the streaming engine path. */
  readonly streaming?: boolean;
  /** Optional caller-supplied run id; generated when absent. */
  readonly runId?: string;
  readonly signal?: AbortSignal;
}

/** One participant's settled outcome. */
export interface CollaborateParticipantResult {
  readonly participant: CollaborateParticipant;
  readonly ok: boolean;
  /** The validated structured output, or `null` when the run produced none. */
  readonly structured: unknown;
  /** The natural-language form of the participant's answer. */
  readonly text: string;
  /** The catalogue model id that ACTUALLY executed (may differ from the ask). */
  readonly modelId: string;
  readonly accounting?: SpecialistAccounting;
  readonly error?: { readonly code: string; readonly message: string; readonly retryable: boolean };
}

/** A field two participants disagree on. */
export interface Disagreement {
  /** The two participant ids, in the order they were given. */
  readonly between: [string, string];
  readonly field: string;
  readonly a: string;
  readonly b: string;
  readonly resolution?: "a" | "b" | "merged" | "unresolved";
}

/** The synthesis answer, with per-participant provenance. */
export interface CollaborateSynthesis {
  readonly text: string;
  readonly modelId: string;
  /** Which participant each part of the synthesis drew on. */
  readonly provenance: ReadonlyArray<{ readonly participantId: string; readonly excerpt: string }>;
}

export interface CollaborateResult {
  readonly ok: boolean;
  readonly runId: string;
  readonly strategy: CollaborateStrategy;
  readonly participants: ReadonlyArray<CollaborateParticipantResult>;
  readonly synthesis?: CollaborateSynthesis;
  readonly disagreements?: ReadonlyArray<Disagreement>;
  readonly error?: { readonly code: string; readonly message: string; readonly retryable: boolean };
}
