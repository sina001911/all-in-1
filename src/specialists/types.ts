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
}

export type SpecialistResponse =
  | { readonly ok: true; readonly structured: unknown }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly retryable: boolean;
      };
    };

/** Compile-time guarantee that no specialist request can ever carry tools. */
export type NoToolField = SpecialistRequest extends { tools: unknown } ? never : SpecialistRequest;
