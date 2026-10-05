/**
 * Dependency-free structured-output validation (P5).
 *
 * A deliberately MINIMAL subset of JSON Schema — enough to pin a specialist's
 * output contract without pulling a validation library into a package that must
 * keep ZERO runtime dependencies. Supported keywords:
 *
 *   type              "object" | "array" | "string" | "number" | "boolean" | "null"
 *   required          string[]                        (object)
 *   properties        { [k]: Schema }                 (object)
 *   additionalProperties  false                       (object, opt-in strictness)
 *   items             Schema                          (array)
 *
 * Everything else is ignored rather than fatal, so a richer schema degrades to
 * a looser check instead of rejecting a valid response. An unreadable schema is
 * a typed `SCHEMA_INVALID` failure, reported before any call is made.
 *
 * The validator is total: it never throws for a *value* problem, it returns a
 * structured failure instead, so callers can route validation results the same
 * way they route provider failures.
 */
import { AllInOneError } from "../errors.ts";

export type SchemaType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null";

export interface Schema {
  readonly type?: SchemaType | readonly SchemaType[];
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly additionalProperties?: boolean;
  readonly items?: Schema;
  readonly description?: string;
}

export interface ValidationFailure {
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly failures: readonly ValidationFailure[];
}

export class SchemaInvalidError extends AllInOneError {
  constructor(message: string) {
    super(message, "SCHEMA_INVALID", "config", { retryable: false });
    this.name = "SchemaInvalidError";
  }
}

/** Compile-time-ish sanity check on a schema before it is ever used. */
export function assertSchemaUsable(schema: unknown): asserts schema is Schema {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new SchemaInvalidError("outputSchema must be a schema object");
  }
  const s = schema as Schema;
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    for (const t of types) {
      if (!SCHEMA_TYPES.includes(t)) {
        throw new SchemaInvalidError(`outputSchema declares an unsupported type: ${String(t)}`);
      }
    }
  }
  if (s.properties !== undefined) {
    if (typeof s.properties !== "object" || s.properties === null || Array.isArray(s.properties)) {
      throw new SchemaInvalidError("outputSchema.properties must be an object");
    }
    for (const [key, sub] of Object.entries(s.properties)) {
      try {
        assertSchemaUsable(sub);
      } catch (e) {
        throw new SchemaInvalidError(`outputSchema.properties["${key}"] is invalid: ${(e as Error).message}`);
      }
    }
  }
  if (s.items !== undefined) {
    try {
      assertSchemaUsable(s.items);
    } catch (e) {
      throw new SchemaInvalidError(`outputSchema.items is invalid: ${(e as Error).message}`);
    }
  }
  if (s.required !== undefined && !Array.isArray(s.required)) {
    throw new SchemaInvalidError("outputSchema.required must be an array");
  }
}

const SCHEMA_TYPES: readonly string[] = [
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
];

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, type: SchemaType): boolean {
  const actual = typeOf(value);
  if (type === "integer") return actual === "number" && Number.isInteger(value);
  return actual === type;
}

export function validateStructured(value: unknown, schema: Schema): ValidationResult {
  const failures: ValidationFailure[] = [];
  validateAt(value, schema, "$root", failures);
  return { ok: failures.length === 0, failures };
}

function validateAt(
  value: unknown,
  schema: Schema,
  path: string,
  failures: ValidationFailure[],
): void {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      failures.push({
        path,
        message: `expected type ${types.join(" | ")}, got ${typeOf(value)}`,
      });
      return; // a type mismatch makes deeper checking meaningless
    }
  }

  if (typeOf(value) === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in obj)) {
          failures.push({ path: `${path}.${key}`, message: "required property is missing" });
        }
      }
    }
    if (schema.properties) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in obj) validateAt(obj[key], sub, `${path}.${key}`, failures);
      }
    }
    if (
      schema.additionalProperties === false &&
      schema.properties !== undefined
    ) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) {
          failures.push({
            path: `${path}.${key}`,
            message: "additional property is not allowed",
          });
        }
      }
    }
  }

  if (typeOf(value) === "array" && schema.items !== undefined) {
    const arr = value as unknown[];
    for (let i = 0; i < arr.length; i++) {
      validateAt(arr[i], schema.items, `${path}[${i}]`, failures);
    }
  }
}
