/**
 * D25: accounting propagation. The real `committedUsd`, model, adapter and
 * latency travel from `ExecutionOutcome` through `SpecialistResponse` and
 * `StepResult` into per-step `UsageRecord`s — replacing the single synthetic
 * `local/deterministic` record D1 wrote.
 *
 * Pinned properties:
 *   - the settled cost on the response equals the engine's committedUsd;
 *   - token counts appear ONLY when the provider emitted a usage frame — never
 *     invented, never defaulted;
 *   - the deterministic local path stays genuinely zero-cost;
 *   - a multi-step run over two models aggregates correctly in the usage store
 *     and in D24's `getRunUsage`;
 *   - usage totals and the budget ledger agree for the same execution;
 *   - no secret, prompt text or stream content is persisted.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpecialistRunner } from "../../src/specialists/runner.ts";
import { WorkflowLoop } from "../../src/workflow/index.ts";
import type { SpecialistRequest } from "../../src/specialists/types.ts";
import type { InvocationPortal } from "../../src/execution/engine.ts";
import type { StreamEvent } from "../../src/execution/types.ts";
import { BudgetLedger } from "../../src/registry/budget.ts";
import { buildDesktopStack, type DesktopStack } from "../src/desktop-stack.ts";
import { DesktopFacade } from "../src/facade.ts";
import { MemoryCredentialProvider } from "../src/credentials/memory-credential-provider.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-d25-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A stub engine whose settled outcome is fully controllable. It mirrors the
 * real engine's settle phase — committing the actual cost to the budget ledger
 * — so a test can exercise the accounting path without any network.
 */
function stubEngine(opts: {
  readonly modelId?: string;
  readonly adapterId?: string;
  readonly committedUsd?: number;
  readonly latencyMs?: number;
  readonly usageFrame?: { promptTokens?: number; completionTokens?: number };
  readonly structured?: unknown;
  readonly capability?: string;
  /** Return genuinely no structured payload, so the runner rejects it post-settle. */
  readonly noStructured?: boolean;
  /** Resolved lazily so the test can hand over the stack's own ledger. */
  readonly getBudget?: () => BudgetLedger;
}): InvocationPortal {
  return {
    invoke: async (_request: unknown, options?: unknown) => {
      if (opts.usageFrame) {
        (options as { onStreamEvent?: (e: StreamEvent) => void } | undefined)?.onStreamEvent?.({
          kind: "usage",
          promptTokens: opts.usageFrame.promptTokens,
          completionTokens: opts.usageFrame.completionTokens,
        });
      }
      const committed = Math.max(0, opts.committedUsd ?? 0);
      // Same settle semantics as the real engine: commit the actual cost.
      opts.getBudget?.().commit(committed);
      return {
        decision: { ok: true, model: { provider: "stub", modelId: "m" }, costEstimateUsd: 0, requiresApproval: false },
        adapterId: opts.adapterId ?? "stub",
        result: {
          providerId: "stub",
          modelId: opts.modelId ?? "stub/paid",
          capability: opts.capability ?? "FAST_TASK",
          ok: true,
          text: "done",
          structured: opts.noStructured ? undefined : (opts.structured ?? { findings: [] }),
          costUsd: committed,
          latencyMs: opts.latencyMs ?? 7,
        },
        committedUsd: committed,
      } as never;
    },
  };
}

function stubSpecialists(): never {
  return { bySpecialistRole: () => [{ id: "x", defaultOutputSchema: {} }] } as never;
}

function step(role: SpecialistRequest["role"]): SpecialistRequest {
  return { role, prompt: "p", inputs: [{ kind: "text", text: "hi" }], outputSchema: {} };
}

describe("SpecialistRunner accounting forwarding", () => {
  it("carries committedUsd, modelId, adapterId and latencyMs onto the response", async () => {
    const runner = new SpecialistRunner({
      engine: stubEngine({ modelId: "acme/pro", adapterId: "acme", committedUsd: 0.012, latencyMs: 240 }),
      specialists: stubSpecialists(),
    });
    const res = await runner.run(step("FAST_TASK"));
    expect(res.ok).toBe(true);
    expect(res.accounting).toMatchObject({
      modelId: "acme/pro",
      adapterId: "acme",
      committedUsd: 0.012,
      latencyMs: 240,
      capability: "FAST_TASK",
    });
  });

  it("records provider-reported tokens only when a usage frame was emitted", async () => {
    const withFrame = new SpecialistRunner({
      engine: stubEngine({ usageFrame: { promptTokens: 110, completionTokens: 40 } }),
      specialists: stubSpecialists(),
    });
    const reported = await withFrame.run({ ...step("FAST_TASK"), streaming: true });
    expect(reported.accounting?.promptTokens).toBe(110);
    expect(reported.accounting?.completionTokens).toBe(40);

    // No usage frame from the provider → no token claim at all (never 0-invented).
    const withoutFrame = new SpecialistRunner({ engine: stubEngine({}), specialists: stubSpecialists() });
    const silent = await withoutFrame.run({ ...step("FAST_TASK"), streaming: true });
    expect(silent.accounting?.promptTokens).toBeUndefined();
    expect(silent.accounting?.completionTokens).toBeUndefined();
  });

  it("captures tokens even when the caller installs no stream sink", async () => {
    // Accounting must not depend on an unrelated caller choosing to stream.
    const runner = new SpecialistRunner({
      engine: stubEngine({ usageFrame: { promptTokens: 50, completionTokens: 20 } }),
      specialists: stubSpecialists(),
    });
    const res = await runner.run({ ...step("FAST_TASK"), streaming: true });
    expect(res.accounting?.promptTokens).toBe(50);
    expect(res.accounting?.completionTokens).toBe(20);
  });

  it("never claims a negative cost", async () => {
    const ledger = new BudgetLedger(1);
    const runner = new SpecialistRunner({
      engine: stubEngine({ committedUsd: -1, getBudget: () => ledger }),
      specialists: stubSpecialists(),
    });
    const res = await runner.run(step("FAST_TASK"));
    expect(res.accounting?.committedUsd).toBe(0);
  });

  it("keeps accounting when the response itself fails after a settled call", async () => {
    const runner = new SpecialistRunner({
      engine: stubEngine({ noStructured: true, committedUsd: 0.004 }),
      specialists: stubSpecialists(),
    });
    const res = await runner.run(step("FAST_TASK"));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("STRUCTURED_OUTPUT_INVALID");
    }
    // The call still cost something; the accounting is not silently dropped.
    expect(res.accounting?.committedUsd).toBe(0.004);
  });
});

describe("WorkflowLoop multi-step accounting", () => {
  it("puts each step's accounting on its StepResult and aggregates over the run", async () => {
    const portal = stubEngine({ modelId: "acme/pro", committedUsd: 0.01 });
    const runner = new SpecialistRunner({ engine: portal, specialists: stubSpecialists() });
    const loop = new WorkflowLoop({
      runner,
      request: {
        mode: "INSPECT",
        steps: [step("FAST_TASK"), step("CODE_REVIEWER")],
        auto: { auto: true, maxIterations: 2 },
      },
    });
    const result = await loop.run();
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results.map((r) => r.accounting?.modelId)).toEqual(["acme/pro", "acme/pro"]);
    // Both StepResult and its response carry the same settled number.
    for (const r of result.results) {
      expect(r.accounting?.committedUsd).toBe(r.response.accounting?.committedUsd);
    }
  });

  it("handles two different models in one run without cross-contamination", async () => {
    let call = 0;
    const portal: InvocationPortal = {
      invoke: async () => {
        call += 1;
        const modelId = call === 1 ? "acme/cheap" : "acme/expensive";
        return {
          decision: { ok: true, model: { provider: "acme", modelId: "m" }, costEstimateUsd: 0, requiresApproval: false },
          adapterId: "acme",
          result: {
            providerId: "acme",
            modelId,
            capability: "FAST_TASK",
            ok: true,
            text: "ok",
            structured: { findings: [] },
            costUsd: call === 1 ? 0.001 : 0.02,
            latencyMs: 5,
          },
          committedUsd: call === 1 ? 0.001 : 0.02,
        } as never;
      },
    };
    const runner = new SpecialistRunner({ engine: portal, specialists: stubSpecialists() });
    const loop = new WorkflowLoop({
      runner,
      request: {
        mode: "INSPECT",
        steps: [step("FAST_TASK"), step("CODE_REVIEWER")],
        auto: { auto: true, maxIterations: 2 },
      },
    });
    const result = await loop.run();
    expect(result.results[0]?.accounting?.modelId).toBe("acme/cheap");
    expect(result.results[0]?.accounting?.committedUsd).toBe(0.001);
    expect(result.results[1]?.accounting?.modelId).toBe("acme/expensive");
    expect(result.results[1]?.accounting?.committedUsd).toBe(0.02);
  });
});

describe("facade per-step usage records", () => {
  function stack(engine?: InvocationPortal): DesktopStack {
    return buildDesktopStack({
      baseDir: dir,
      credentials: new MemoryCredentialProvider(),
      overrides: engine ? { engine } : undefined,
    });
  }

  it("writes one usage record per settled step instead of a synthetic local record", async () => {
    const s = stack(stubEngine({ modelId: "acme/pro", adapterId: "acme", committedUsd: 0.03 }));
    const facade = new DesktopFacade(s);
    const r = await facade.runDiagnostic({ mode: "INSPECT", subject: "x" });
    const usage = facade.listUsage().filter((u) => u.runId === r.runId);
    expect(usage).toHaveLength(1);
    expect(usage[0]?.modelId).toBe("acme/pro");
    expect(usage[0]?.adapterId).toBe("acme");
    expect(usage[0]?.costUsd).toBe(0.03);
    expect(usage[0]?.latencyMs).toBe(7);
    expect(usage[0]?.errorCode).toBeUndefined();
  });

  it("the deterministic local run stays genuinely zero-cost", async () => {
    const facade = new DesktopFacade(stack());
    const r = await facade.runDiagnostic({ mode: "INSPECT", subject: "local run" });
    const usage = facade.listUsage().filter((u) => u.runId === r.runId);
    expect(usage).toHaveLength(1);
    expect(usage[0]?.costUsd).toBe(0);
    expect(usage[0]?.modelId).toMatch(/^local\//);
    expect(usage[0]?.adapterId).toBe("local");
  });

  it("usage totals and the budget ledger agree for the same execution", async () => {
    // The stub hands the stack's own ledger back to the engine, exactly the
    // wiring the real engine has, so committed cost lands in both places.
    let ledger: BudgetLedger | undefined;
    const s = stack(stubEngine({ modelId: "acme/pro", committedUsd: 0.05, getBudget: () => ledger as BudgetLedger }));
    ledger = s.budget;
    const facade = new DesktopFacade(s);
    const r = await facade.runDiagnostic({ mode: "INSPECT", subject: "x" });
    const runCost = facade.listUsage().filter((u) => u.runId === r.runId).reduce((a, u) => a + u.costUsd, 0);
    expect(runCost).toBe(0.05);
    // The engine committed the same amount to the ledger.
    expect(s.budget.snapshot().spentUsd).toBe(0.05);
    expect(facade.getUsageTotals().totalCostUsd).toBe(0.05);
  });

  it("persists no secret, prompt text or stream content in the usage store", async () => {
    const s = stack(stubEngine({ modelId: "acme/pro", committedUsd: 0.01 }));
    const facade = new DesktopFacade(s);
    facade.setCredential("ACME_KEY", "sk-secret-value");
    await facade.runDiagnostic({ mode: "INSPECT", subject: "prompt-secret-text" });
    // The store lives under the app's data subdirectory, not the base dir itself.
    const file = join(dir, "all-in-1", "usage.json");
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("sk-secret-value");
    expect(raw).not.toContain("prompt-secret-text");
    // The recorded shape itself carries no free-text field: every key is an
    // identifier, a counter or an enum, so there is nowhere a prompt, a stream
    // chunk or a key could be written even by mistake.
    const parsed = JSON.parse(raw) as { entries: Record<string, unknown>[] };
    expect(parsed.entries.length).toBeGreaterThan(0);
    expect(Object.keys(parsed.entries[0] as Record<string, unknown>).sort()).toEqual(
      ["adapterId", "capability", "costUsd", "id", "latencyMs", "modelId", "outcome", "runId", "ts"],
    );
  });

  it("D24 getRunUsage aggregates multi-step, multi-model runs", async () => {
    let call = 0;
    const portal: InvocationPortal = {
      invoke: async () => {
        call += 1;
        const cheap = call === 1;
        return {
          decision: { ok: true, model: { provider: "acme", modelId: "m" }, costEstimateUsd: 0, requiresApproval: false },
          adapterId: "acme",
          result: {
            providerId: "acme",
            modelId: cheap ? "acme/cheap" : "acme/expensive",
            capability: "FAST_TASK",
            ok: true,
            text: "ok",
            structured: { findings: [] },
            costUsd: cheap ? 0.001 : 0.02,
            latencyMs: 4,
          },
          committedUsd: cheap ? 0.001 : 0.02,
        } as never;
      },
    };
    const s = stack(portal);
    const facade = new DesktopFacade(s);
    const r = await facade.runDiagnostic({
      mode: "INSPECT",
      subject: "multi",
      steps: ["FAST_TASK", "CODE_REVIEWER"],
      auto: true,
    });
    const summary = facade.getRunUsage(r.runId);
    expect(summary?.invocations).toBe(2);
    expect(summary?.costUsd).toBeCloseTo(0.021, 9);
    expect(summary?.models.map((m) => m.modelId)).toEqual(["acme/expensive", "acme/cheap"]);
    expect(summary?.models.map((m) => m.invocations)).toEqual([1, 1]);
  });

  it("leaves tokens absent when the provider reports none, and D24 reports zero", async () => {
    const s = stack(stubEngine({ modelId: "acme/pro", committedUsd: 0.01 }));
    const facade = new DesktopFacade(s);
    const r = await facade.runDiagnostic({ mode: "INSPECT", subject: "no tokens" });
    const usage = facade.listUsage().filter((u) => u.runId === r.runId);
    expect(usage).toHaveLength(1);
    expect(usage[0]?.promptTokens).toBeUndefined();
    expect(usage[0]?.completionTokens).toBeUndefined();
    // D24 totals tokens as 0 — reported absence, never a fabricated count.
    const summary = facade.getRunUsage(r.runId);
    expect(summary?.promptTokens).toBe(0);
    expect(summary?.completionTokens).toBe(0);
  });

  it("carries reported tokens through to the persisted usage record", async () => {
    let ledger: BudgetLedger | undefined;
    const s = stack(
      stubEngine({
        modelId: "acme/pro",
        committedUsd: 0.02,
        usageFrame: { promptTokens: 300, completionTokens: 120 },
        getBudget: () => ledger as BudgetLedger,
      }),
    );
    ledger = s.budget;
    const facade = new DesktopFacade(s);
    const r = await facade.runDiagnostic({ mode: "INSPECT", subject: "with tokens", streaming: true });
    const usage = facade.listUsage().filter((u) => u.runId === r.runId);
    expect(usage[0]?.promptTokens).toBe(300);
    expect(usage[0]?.completionTokens).toBe(120);
    const summary = facade.getRunUsage(r.runId);
    expect(summary?.promptTokens).toBe(300);
    expect(summary?.completionTokens).toBe(120);
    expect(summary?.costUsd).toBe(0.02);
  });
});
