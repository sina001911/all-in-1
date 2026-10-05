/**
 * Specialist runner (P5).
 *
 * The first implementation of the specialist layer declared in P1's
 * `specialists/types.ts`. It turns a `SpecialistRequest` into a
 * `SpecialistResponse` by:
 *
 *   1. refusing any request that carries a tool surface (the NoToolField
 *      guarantee is compile-time; this is its runtime enforcement);
 *   2. mapping the request's ROLE onto a capability through the existing P3
 *      bridge — specialists never bypass routing;
 *   3. executing through the P4 `ExecutionEngine` and ONLY through it, so every
 *      policy, approval, egress, secret-resolution, and budget gate applies
 *      unchanged;
 *   4. validating the structured output against the declared schema before it
 *      is handed back, so downstream consumers never see an unvalidated shape.
 *
 * The runner performs no network call of its own, reads no credential, and
 * never writes a file.
 */
import type { SpecialistRequest, SpecialistResponse } from "./types.ts";
import type { SpecialistRegistry } from "./registry.ts";
import type { InvocationPortal, InvokeOptions } from "../execution/engine.ts";
import type { SelectionRequest } from "../models/types.ts";
import { capabilityForRole } from "../registry/bridge.ts";
import { AllInOneError } from "../errors.ts";
import { assertSchemaUsable, validateStructured, type Schema } from "./validator.ts";

export interface SpecialistRunnerOptions {
  readonly engine: InvocationPortal;
  readonly specialists: SpecialistRegistry;
}

export class SpecialistRunner {
  private readonly opts: SpecialistRunnerOptions;

  constructor(opts: SpecialistRunnerOptions) {
    this.opts = opts;
  }
  async run(
    request: SpecialistRequest,
    options?: InvokeOptions,
  ): Promise<SpecialistResponse> {
    // 1. Runtime enforcement of the no-tool guarantee. The request type has no
    // `tools` field by construction; a caller that smuggles one in through a
    // cast is refused here rather than honoured.
    if ("tools" in request) {
      return failure(
        "TOOLS_FORBIDDEN",
        "A specialist request cannot carry a tool surface; specialists analyze only",
        false,
      );
    }

    // 2. The specialist must be registered for the request's role.
    const known = this.opts.specialists.bySpecialistRole(request.role);
    if (known.length === 0) {
      return failure(
        "SPECIALIST_NOT_FOUND",
        `No specialist is registered for role ${request.role}`,
        false,
      );
    }

    // 3. Route the role onto a capability and execute through the engine.
    const capability = capabilityForRole(request.role);
    const selection: SelectionRequest = {
      capability,
      inputs: request.inputs,
      structuredOutput: true,
    };

    let outcome;
    try {
      outcome = await this.opts.engine.invoke(selection, options);
    } catch (e) {
      const err = e as AllInOneError;
      return failure(
        err.code ?? "PROVIDER_CALL_FAILED",
        err.message,
        err.retryable ?? false,
      );
    }

    // 4. Validate the structured output before it reaches a consumer.
    const schema = (request.outputSchema ?? known[0]?.defaultOutputSchema) as Schema | undefined;
    if (schema) {
      assertSchemaUsable(schema);
      const value = outcome.result.structured;
      if (value === undefined || value === null) {
        return failure(
          "STRUCTURED_OUTPUT_INVALID",
          `${outcome.adapterId} returned no structured output to validate`,
          false,
        );
      }
      const verdict = validateStructured(value, schema);
      if (!verdict.ok) {
        return failure(
          "STRUCTURED_OUTPUT_INVALID",
          `Structured output failed the declared schema: ${describe(verdict.failures)}`,
          false,
        );
      }
      return { ok: true, structured: value };
    }

    // No schema declared: pass through, but never as an unvalidated claim that
    // a contract was met.
    return { ok: true, structured: outcome.result.structured ?? null };
  }
}

function failure(code: string, message: string, retryable: boolean): SpecialistResponse {
  return { ok: false, error: { code, message, retryable } };
}

function describe(failures: readonly { path: string; message: string }[]): string {
  return failures.map((f) => `${f.path}: ${f.message}`).join("; ");
}
