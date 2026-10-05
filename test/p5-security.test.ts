/**
 * P5 security regression suite.
 *
 * P5 added a specialist and workflow layer on top of the frozen P1–P4 machinery.
 * These tests pin the invariants that the addition must not weaken: the stack
 * stays inert by default, media stays gated, no credential is requested, no file
 * can be written, and autonomy stays opt-in and bounded.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSpecialistStack } from "../src/specialists/stack.ts";
import { buildExecutionStack } from "../src/execution/stack.ts";
import { WorkflowLoop } from "../src/workflow/index.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir))) {
    const full = join(ROOT, dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTs(join(dir, entry)));
    } else if (entry.endsWith(".ts") && !entry.endsWith("test-fixtures.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("the default stack stays inert", () => {
  it("registers only the deterministic local adapter", () => {
    const { stack } = buildSpecialistStack();
    const ids = stack.adapters.list().map((a) => a.id);
    expect(ids).toEqual(["local"]);
  });

  it("registers only the deterministic local models", () => {
    const { stack } = buildSpecialistStack();
    const ids = stack.catalog.list().map((m) => m.id).sort();
    expect(ids).toEqual(["local/deterministic", "local/vision"]);
  });

  it("holds a deny-all egress policy with no allowlisted host", () => {
    const { stack } = buildSpecialistStack();
    expect(stack.egress.kind).toBe("deny-all");
    expect(stack.egress.allowlist).toEqual([]);
  });

  it("starts with a zero budget", () => {
    const { stack } = buildSpecialistStack();
    expect(stack.budget.snapshot()).toEqual({
      budgetUsd: 0,
      reservedUsd: 0,
      spentUsd: 0,
    });
  });

  it("requests no credential from the environment", () => {
    const { stack } = buildSpecialistStack();
    for (const adapter of stack.adapters.list()) {
      // The only default adapter needs no key at all, ever.
      expect(adapter.apiKeyEnv).toBe(null);
      expect(adapter.locality).toBe("local");
      expect(adapter.availableWithoutCredentials).toBe(true);
    }
  });

  it("applies FREE_ONLY selection by default", () => {
    const stack = buildExecutionStack();
    expect(stack.catalog.list().every((m) => m.enabled)).toBe(true);
    // No remote/foreign provider object is registered anywhere in the stack.
    for (const adapter of stack.adapters.list()) {
      expect(adapter.locality).toBe("local");
    }
  });
});

describe("media generation stays gated", () => {
  it("registers no specialist for generation roles", async () => {
    const { runner } = buildSpecialistStack();
    const generation = [
      "IMAGE_GENERATOR",
      "IMAGE_EDITOR",
      "VIDEO_GENERATOR",
      "VIDEO_EDITOR",
    ] as const;
    for (const role of generation) {
      const response = await runner.run({
        role,
        prompt: "x",
        inputs: [],
        outputSchema: {},
      });
      expect(response.ok).toBe(false);
      expect((response as { error: { code: string } }).error.code).toBe(
        "SPECIALIST_NOT_FOUND",
      );
    }
  });

  it("registers no specialist for media-QA roles either", async () => {
    const { runner } = buildSpecialistStack();
    const response = await runner.run({
      role: "MEDIA_QA",
      prompt: "x",
      inputs: [],
      outputSchema: {},
    });
    expect(response.ok).toBe(false);
    expect((response as { error: { code: string } }).error.code).toBe(
      "SPECIALIST_NOT_FOUND",
    );
  });
});

describe("no file-writing capability exists in the P5 layer", () => {
  // Structural: if a module cannot import a filesystem API, it cannot write a
  // file. The only writer in the product is the OpenCode tool binding (P6).
  const P5_DIRS = ["src/specialists", "src/workflow", "src/observability"];

  it("imports no node:fs / fs / fs-promises module", () => {
    const files = P5_DIRS.flatMap((d) => listTs(d)).concat(
      join(ROOT, "src/execution/stack.ts"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      expect(src).not.toMatch(/from\s+["']node:fs/);
      expect(src).not.toMatch(/from\s+["']fs["']/);
      expect(src).not.toMatch(/from\s+["']fs\/promises["']/);
      expect(src).not.toMatch(/require\(["']fs["']\)/);
      expect(src).not.toMatch(/writeFile|writeFileSync|appendFile/);
    }
  });

  it("the workflow result contract carries no path, diff, or edit field", async () => {
    const { runner } = buildSpecialistStack();
    const loop = new WorkflowLoop({
      runner,
      request: {
        mode: "BUILD",
        steps: [
          { role: "CODE_REVIEWER", prompt: "x", inputs: [], outputSchema: {} },
        ],
      },
    });
    const result = await loop.run();
    const forbidden = ["path", "diff", "edit", "write", "changes", "files", "patch"];
    for (const key of Object.keys(result)) {
      expect(forbidden).not.toContain(key);
    }
  });
});

describe("autonomy stays opt-in and bounded", () => {
  it("is not autonomous by default", async () => {
    const { runner } = buildSpecialistStack();
    const loop = new WorkflowLoop({
      runner,
      request: {
        mode: "BUILD",
        steps: [
          { role: "FAST_TASK", prompt: "x", inputs: [], outputSchema: {} },
          { role: "FAST_TASK", prompt: "x", inputs: [], outputSchema: {} },
        ],
      },
    });
    const result = await loop.run();
    expect(result.auto).toBe(false);
    expect(result.pausedForHuman).toBe(true);
    expect(result.iterations).toBe(1);
  });

  it("caps autonomy at five iterations however it is requested", async () => {
    const { runner } = buildSpecialistStack();
    for (const max of [6, 10, 100]) {
      const loop = new WorkflowLoop({
        runner,
        request: {
          mode: "BUILD",
          steps: Array.from({ length: 20 }, () => ({
            role: "FAST_TASK" as const,
            prompt: "x",
            inputs: [],
            outputSchema: {},
          })),
          auto: { auto: true, maxIterations: max },
        },
      });
      const result = await loop.run();
      expect(result.iterations).toBe(5);
      expect(result.ok).toBe(false);
    }
  });
});
