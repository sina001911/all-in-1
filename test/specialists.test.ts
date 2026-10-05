/**
 * Specialist layer suite (P5): registry, dependency-free schema validation,
 * and the runner that routes a specialist through the P4 engine via the P3
 * bridge.
 *
 * Pinned properties:
 * - a specialist never carries a tool surface (compile-time AND runtime);
 * - an unknown role is SPECIALIST_NOT_FOUND, never a crash;
 * - structured output is validated before it reaches a consumer;
 * - every engine failure is surfaced as an ok:false response with the typed
 *   code, so callers route it the same way they route provider failures.
 */
import { describe, expect, it } from "vitest";
import {
  SpecialistRegistry,
  SpecialistRunner,
  registerBaselineSpecialists,
  validateStructured,
  assertSchemaUsable,
  SchemaInvalidError,
} from "../src/specialists/index.ts";
import { buildCatalogFixture } from "../src/execution/test-fixtures.ts";
import { ExecutionEngine } from "../src/execution/engine.ts";
import { LocalAdapter } from "../src/execution/local-adapter.ts";
import { AdapterRegistry } from "../src/execution/adapter-registry.ts";
import { ApprovalStore } from "../src/registry/approvals.ts";
import { BudgetLedger } from "../src/registry/budget.ts";
import { registerLocalModels } from "../src/execution/local-adapter.ts";

function runnerFor(budgetUsd = 0): SpecialistRunner {
  const fixture = buildCatalogFixture([]);
  registerLocalModels(fixture.catalog);
  const adapters = new AdapterRegistry();
  adapters.register(new LocalAdapter());
  const engine = new ExecutionEngine({
    catalog: fixture.catalog,
    capabilities: fixture.capabilities,
    chains: fixture.chains,
    approvals: new ApprovalStore(),
    budget: new BudgetLedger(budgetUsd),
    adapters,
  });
  const specialists = new SpecialistRegistry();
  registerBaselineSpecialists(specialists);
  return new SpecialistRunner({ engine, specialists });
}

describe("specialist registry", () => {
  it("registers and looks up specialists", () => {
    const reg = new SpecialistRegistry();
    registerBaselineSpecialists(reg);
    expect(reg.get("code-review")?.role).toBe("CODE_REVIEWER");
    expect(reg.bySpecialistRole("VISION").map((s) => s.id)).toContain("screenshot-analysis");
    expect(reg.list().length).toBeGreaterThan(0);
  });

  it("rejects a duplicate id", () => {
    const reg = new SpecialistRegistry();
    reg.register({ id: "x", role: "FAST_TASK", description: "" });
    expect(() => reg.register({ id: "x", role: "FAST_TASK", description: "" })).toThrow(
      /already registered/,
    );
  });

  it("returns an empty list for an unregistered role", () => {
    const reg = new SpecialistRegistry();
    expect(reg.bySpecialistRole("MEDIA_QA")).toEqual([]);
  });
});

describe("schema validator", () => {
  it("accepts a value matching the schema", () => {
    const schema = {
      type: "object" as const,
      properties: { summary: { type: "string" as const } },
      required: ["summary"],
    };
    expect(validateStructured({ summary: "ok" }, schema).ok).toBe(true);
  });

  it("reports a wrong type", () => {
    const schema = { type: "string" as const };
    const verdict = validateStructured(42, schema);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]?.message).toContain("expected type string");
  });

  it("reports a missing required property", () => {
    const schema = {
      type: "object" as const,
      required: ["summary"],
    };
    const verdict = validateStructured({}, schema);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]?.path).toBe("$root.summary");
  });

  it("reports an additional property when strict", () => {
    const schema = {
      type: "object" as const,
      properties: { a: { type: "string" as const } },
      additionalProperties: false,
    };
    expect(validateStructured({ a: "x" }, schema).ok).toBe(true);
    const verdict = validateStructured({ a: "x", b: "extra" }, schema);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]?.path).toBe("$root.b");
  });

  it("validates arrays through items", () => {
    const schema = {
      type: "array" as const,
      items: { type: "integer" as const },
    };
    expect(validateStructured([1, 2, 3], schema).ok).toBe(true);
    const verdict = validateStructured([1, "two"], schema);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]?.path).toBe("$root[1]");
  });

  it("validates nested objects", () => {
    const schema = {
      type: "object" as const,
      properties: {
        meta: {
          type: "object" as const,
          properties: { version: { type: "integer" as const } },
          required: ["version"],
        },
      },
      required: ["meta"],
    };
    expect(validateStructured({ meta: { version: 1 } }, schema).ok).toBe(true);
    const verdict = validateStructured({ meta: {} }, schema);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]?.path).toBe("$root.meta.version");
  });

  it("accepts a union of types", () => {
    const schema = { type: ["string", "null"] as readonly ("string" | "null")[] };
    expect(validateStructured("x", schema).ok).toBe(true);
    expect(validateStructured(null, schema).ok).toBe(true);
    expect(validateStructured(1, schema).ok).toBe(false);
  });

  it("treats integer strictly", () => {
    const schema = { type: "integer" as const };
    expect(validateStructured(1, schema).ok).toBe(true);
    expect(validateStructured(1.5, schema).ok).toBe(false);
  });

  it("ignores unsupported keywords rather than failing", () => {
    const schema = { type: "object" as const, minLength: 3, pattern: "^a" };
    expect(validateStructured({ anything: true }, schema).ok).toBe(true);
  });

  it("rejects an unusable schema", () => {
    expect(() => assertSchemaUsable({ type: "nonsense" })).toThrow(SchemaInvalidError);
    expect(() => assertSchemaUsable({ properties: "nope" })).toThrow(/properties/);
    expect(() => assertSchemaUsable(42)).toThrow(/must be a schema object/);
  });
});

describe("specialist runner", () => {
  it("runs a registered specialist through the engine and validates the output", async () => {
    const runner = runnerFor();
    const response = await runner.run({
      role: "CODE_REVIEWER",
      prompt: "review this",
      inputs: [{ kind: "text", text: "function add(a,b)" }],
      outputSchema: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      },
    });
    expect(response.ok).toBe(true);
    expect((response as { structured: { summary: string } }).structured.summary).toContain(
      "function add(a,b)",
    );
  });

  it("routes the role onto a capability via the bridge", async () => {
    const runner = runnerFor();
    const response = await runner.run({
      role: "VISION",
      prompt: "describe",
      inputs: [{ kind: "image", artifactId: "shot-1" }],
      outputSchema: { type: "object", properties: { summary: { type: "string" } } },
    });
    expect(response.ok).toBe(true);
  });

  it("refuses a request that smuggles a tool surface", async () => {
    const runner = runnerFor();
    const request = {
      role: "FAST_TASK",
      prompt: "x",
      inputs: [],
      outputSchema: {},
      tools: ["write"],
    } as unknown as Parameters<SpecialistRunner["run"]>[0];
    const response = await runner.run(request);
    expect(response.ok).toBe(false);
    expect((response as { error: { code: string } }).error.code).toBe("TOOLS_FORBIDDEN");
  });

  it("reports SPECIALIST_NOT_FOUND for an unregistered role", async () => {
    const runner = runnerFor();
    const response = await runner.run({
      role: "MEDIA_QA",
      prompt: "x",
      inputs: [],
      outputSchema: {},
    });
    expect(response.ok).toBe(false);
    expect((response as { error: { code: string } }).error.code).toBe("SPECIALIST_NOT_FOUND");
  });

  it("fails on structured output that does not match the schema", async () => {
    const runner = runnerFor();
    const response = await runner.run({
      role: "FAST_TASK",
      prompt: "x",
      inputs: [{ kind: "text", text: "hi" }],
      outputSchema: { type: "object", required: ["doesNotExist"] },
    });
    expect(response.ok).toBe(false);
    const err = (response as { error: { code: string; message: string } }).error;
    expect(err.code).toBe("STRUCTURED_OUTPUT_INVALID");
    expect(err.message).toContain("doesNotExist");
  });
});
