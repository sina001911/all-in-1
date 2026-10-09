/**
 * Specialist request/response contract.
 *
 * Specialists produce structured analysis only. The request type deliberately
 * has NO tool field: there is no capability surface by which a specialist can
 * touch the filesystem, call tools, or spend money. Interpretation, decisions,
 * and edits are Atria's alone.
 */
import type { ModelRole } from "../registry/roles.ts";

export interface SpecialistRequest {
  readonly role: ModelRole;
  readonly prompt: string;
  readonly inputs: ReadonlyArray<
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "image"; readonly artifactId: string }
  >;
  readonly outputSchema: object;
  /** Opt-in streaming on the engine invocation; buffered result contract stays. */
  readonly streaming?: boolean;
}

export type SpecialistResponse =
  | { readonly ok: true; readonly structured: unknown; readonly accounting?: SpecialistAccounting }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly retryable: boolean;
      };
      /**
       * Present when the engine settled an invocation before the response failed
       * (e.g. structured-output validation): the call still cost something, and
       * accounting must not be silently dropped.
       */
      readonly accounting?: SpecialistAccounting;
    };

/**
 * What one specialist invocation actually consumed (D25).
 *
 * Every number traces to the engine's `ExecutionOutcome`: `committedUsd` is the
 * settled cost the budget ledger already recorded, and `latencyMs` is the
 * adapter's own measurement. Token counts are OPTIONAL and present ONLY when the
 * provider emitted a usage frame during a streamed invocation — they are never
 * estimated, never defaulted, and never invented.
 */
export interface SpecialistAccounting {
  /** The catalogue model id, `provider/model`. */
  readonly modelId: string;
  /** The adapter that served the invocation. */
  readonly adapterId: string;
  /** The capability the role routed onto. */
  readonly capability: string;
  /** Actual spend committed to the budget ledger, in USD. */
  readonly committedUsd: number;
  readonly latencyMs: number;
  /** Provider-reported prompt tokens; absent when the provider reported none. */
  readonly promptTokens?: number;
  /** Provider-reported completion tokens; absent when the provider reported none. */
  readonly completionTokens?: number;
}

/** Compile-time guarantee that no specialist request can ever carry tools. */
export type NoToolField = SpecialistRequest extends { tools: unknown } ? never : SpecialistRequest;
