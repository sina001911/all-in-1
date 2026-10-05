/**
 * Specialist layer public surface (P5).
 *
 * Structured analysis only: JSON in, validated JSON out, and never a tool.
 * Every specialist runs through the P4 execution engine via the P3 bridge, so
 * no policy, approval, egress, secret, or budget gate is bypassed.
 */
export { SpecialistRunner } from "./runner.ts";
export type { SpecialistRunnerOptions } from "./runner.ts";
export { SpecialistRegistry, registerBaselineSpecialists } from "./registry.ts";
export type { SpecialistDescriptor } from "./registry.ts";
export { buildSpecialistStack } from "./stack.ts";
export type { SpecialistStack } from "./stack.ts";
export {
  validateStructured,
  assertSchemaUsable,
  SchemaInvalidError,
} from "./validator.ts";
export type { Schema, SchemaType, ValidationResult, ValidationFailure } from "./validator.ts";
export type { SpecialistRequest, SpecialistResponse, NoToolField } from "./types.ts";
