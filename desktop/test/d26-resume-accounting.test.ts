/**
 * D26: correct resume semantics and honest zero ledgers.
 *
 * Two confirmed defects are pinned here:
 *
 *   A. Resuming a paused multi-step run used to rebuild the workflow loop from
 *      scratch, so it re-ran the FIRST step (never progressing past it) and
 *      appended a duplicate `UsageRecord` with the same id on every resume —
 *      inflating reported cost and, with a paid provider, double-charging the
 *      budget ledger. The resume point is now derived from the persisted run
 *      record, so only the un-settled steps run.
 *   B. A run that settled no invocation used to write a phantom record with
 *      `modelId: "unsettled"`, reporting 1 invocation and a bogus model row for
 *      a run that invoked nothing. Such a run now writes no record and reports a
 *      genuine zero ledger, while its error stays on the run record.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvocationPortal } from "../../src/execution/engine.ts";
import type { BudgetLedger } from "../../src/registry/budget.ts";
import { buildDesktopStack, type DesktopStack } from "../src/desktop-stack.ts";
import { DesktopFacade } from "../src/facade.ts";
import { MemoryCredentialProvider } from "../src/credentials/memory-credential-provider.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-d26-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A stub engine that mirrors the real engine's settle phase (committing the
 * actual cost to the budget ledger) and echoes the capability it was asked for,
 * so a test can see WHICH step actually ran.
 */
function paidEngine(opts: {
  readonly costUsd?: number;
  readonly getBudget?: () => BudgetLedger;
}): InvocationPortal {
  return {
    invoke: async (request: unknown) => {
      const capability = (request as { capability?: string } | undefined)?.capability ?? "FAST_TASK";
      const committed = Math.max(0, opts.costUsd ?? 0.01);
      opts.getBudget?.().commit(committed);
      return {
        decision: { ok: true, model: { provider: "stub", modelId: "m" }, costEstimateUsd: 0, requiresApproval: false },
        adapterId: "acme",
        result: {
          providerId: "stub",
          modelId: "acme/pro",
          capability,
          ok: true,
          text: "done",
          structured: { findings: [] },
          costUsd: committed,
          latencyMs: 5,
        },
        committedUsd: committed,
      } as never;
    },
  };
}

const STEPS = ["FAST_TASK", "CODE_REVIEWER", "DEEP_REASONING"] as const;

describe("resume semantics (auto: false)", () => {
  it("runs one step, pauses, then continues only from the next step", async () => {
    const s = buildDesktopStack({
      baseDir: dir,
      credentials: new MemoryCredentialProvider(),
      overrides: { engine: paidEngine({}) },
    });
    const f = new DesktopFacade(s);

    const first = await f.runDiagnostic({ mode: "INSPECT", subject: "r", steps: [...STEPS], runId: "r-1" });
    expect(first.pausedForHuman).toBe(true);
    expect(first.iterations).toBe(1);
    expect(f.listUsage().filter((u) => u.runId === "r-1").map((u) => u.capability)).toEqual(["FAST_TASK"]);

    const second = await f.runDiagnostic({ mode: "INSPECT", subject: "r", steps: [...STEPS], runId: "r-1" });
    expect(second.pausedForHuman).toBe(true);
    expect(second.iterations).toBe(2);
    // Only the second step ran — the first was not repeated.
    expect(f.listUsage().filter((u) => u.runId === "r-1").map((u) => u.capability)).toEqual([
      "FAST_TASK",
      "CODE_REVIEW",
    ]);

    const third = await f.runDiagnostic({ mode: "INSPECT", subject: "r", steps: [...STEPS], runId: "r-1" });
    expect(third.ok).toBe(true);
    expect(third.pausedForHuman).toBe(false);
    expect(third.iterations).toBe(3);
    expect(f.listUsage().filter((u) => u.runId === "r-1").map((u) => u.capability)).toEqual([
      "FAST_TASK",
      "CODE_REVIEW",
      "DEEP_REASONING",
    ]);
  });

  it("never re-charges a settled step: usage ids are unique and invocations match settled steps", async () => {
    const s = buildDesktopStack({
      baseDir: dir,
      credentials: new MemoryCredentialProvider(),
      overrides: { engine: paidEngine({}) },
    });
    const f = new DesktopFacade(s);

    for (let i = 0; i < STEPS.length; i += 1) {
      await f.runDiagnostic({ mode: "INSPECT", subject: "r", steps: [...STEPS], runId: "r-2" });
    }
    const records = f.listUsage().filter((u) => u.runId === "r-2");
    expect(records).toHaveLength(3);
    // Distinct, run-global ids — no collision between the resume calls.
    expect(new Set(records.map((u) => u.id).sort()).size).toBe(3);
    expect(records.map((u) => u.id).sort()).toEqual(["usage-r-2-0", "usage-r-2-1", "usage-r-2-2"]);
    const summary = f.getRunUsage("r-2");
    expect(summary?.invocations).toBe(3);
    expect(summary?.costUsd).toBe(0.03);
    expect(summary?.models).toHaveLength(1);
    expect(summary?.models[0]?.invocations).toBe(3);
  });

  it("keeps usage totals and the budget ledger agreed across the resume sequence", async () => {
    let ledger: BudgetLedger | undefined;
    const s = buildDesktopStack({
      baseDir: dir,
      credentials: new MemoryCredentialProvider(),
      overrides: { engine: paidEngine({ costUsd: 0.02, getBudget: () => ledger as BudgetLedger }) },
    });
    ledger = s.budget;
    const f = new DesktopFacade(s);

    await f.runDiagnostic({ mode: "INSPECT", subject: "r", steps: [...STEPS], runId: "r-3" });
    expect(s.budget.snapshot().spentUsd).toBe(0.02);
    expect(f.getUsageTotals().totalCostUsd).toBe(0.02);

    await f.runDiagnostic({ mode: "INSPECT", subject: "r", steps: [...STEPS], runId: "r-3" });
    await f.runDiagnostic({ mode: "INSPECT", subject: "r", steps: [...STEPS], runId: "r-3" });

    // Three steps total, each $0.02, charged exactly once each.
    expect(s.budget.snapshot().spentUsd).toBe(0.06);
    expect(f.getUsageTotals().totalCostUsd).toBe(0.06);
    expect(f.getRunUsage("r-3")?.costUsd).toBe(0.06);
  });

  it("derives the resume point from the persisted run record, surviving a restart", async () => {
    // First session: one step, then pause and persist.
    const s1 = buildDesktopStack({
      baseDir: dir,
      credentials: new MemoryCredentialProvider(),
      overrides: { engine: paidEngine({}) },
    });
    const f1 = new DesktopFacade(s1);
    await f1.runDiagnostic({ mode: "INSPECT", subject: "r", steps: [...STEPS], runId: "r-4" });
    expect(f1.getRun("r-4")?.iterations).toBe(1);

    // Second session: a fresh stack (re-hydrated from disk) and a fresh engine.
    let secondSessionCalls = 0;
    const s2 = buildDesktopStack({
      baseDir: dir,
      credentials: new MemoryCredentialProvider(),
      overrides: {
        engine: {
          invoke: async (request) => {
            secondSessionCalls += 1;
            return paidEngine({}).invoke(request);
          },
        },
      },
    });
    const f2 = new DesktopFacade(s2);
    const resumed = await f2.runDiagnostic({ mode: "INSPECT", subject: "r", steps: [...STEPS], runId: "r-4" });

    // Only ONE new step ran in the second session — the settled one was not repeated.
    expect(secondSessionCalls).toBe(1);
    expect(resumed.iterations).toBe(2);
    const records = f2.listUsage().filter((u) => u.runId === "r-4").map((u) => u.capability);
    expect(records).toEqual(["FAST_TASK", "CODE_REVIEW"]);
  });

  it("uses the persisted step sequence on resume, so a caller cannot redefine order mid-run", async () => {
    const s = buildDesktopStack({
      baseDir: dir,
      credentials: new MemoryCredentialProvider(),
      overrides: { engine: paidEngine({}) },
    });
    const f = new DesktopFacade(s);
    await f.runDiagnostic({ mode: "INSPECT", subject: "r", steps: [...STEPS], runId: "r-5" });

    // The caller now sends a DIFFERENT (shorter) step list for the same run.
    const resumed = await f.runDiagnostic({ mode: "INSPECT", subject: "r", steps: ["FAST_TASK"], runId: "r-5" });
    expect(resumed.ok).toBe(true);
    // The run continued with its own second step, not by re-running FAST_TASK.
    expect(f.listUsage().filter((u) => u.runId === "r-5").map((u) => u.capability)).toEqual([
      "FAST_TASK",
      "CODE_REVIEW",
    ]);
    expect(f.getRun("r-5")?.steps).toEqual([...STEPS]);
  });

  it("re-runs a completed run from scratch rather than treating it as a resume", async () => {
    const s = buildDesktopStack({
      baseDir: dir,
      credentials: new MemoryCredentialProvider(),
      overrides: { engine: paidEngine({}) },
    });
    const f = new DesktopFacade(s);
    // A single-step run completes without pausing.
    await f.runDiagnostic({ mode: "INSPECT", subject: "r", steps: ["FAST_TASK"], runId: "r-6" });
    expect(f.getRun("r-6")?.status).toBe("completed");

    // Re-invoking the same completed runId starts over: one fresh record, and the
    // run record's startedAt/iterations are reset, not continued.
    const again = await f.runDiagnostic({ mode: "INSPECT", subject: "r", steps: ["FAST_TASK"], runId: "r-6" });
    expect(again.iterations).toBe(1);
    const records = f.listUsage().filter((u) => u.runId === "r-6");
    expect(records).toHaveLength(2);
    expect(f.getRun("r-6")?.iterations).toBe(1);
  });
});

describe("runs that settle no invocation", () => {
  function stack(engine?: InvocationPortal): DesktopStack {
    return buildDesktopStack({
      baseDir: dir,
      credentials: new MemoryCredentialProvider(),
      overrides: engine ? { engine } : undefined,
    });
  }

  it("writes no usage record and reports a genuine zero ledger (mode violation)", async () => {
    const f = new DesktopFacade(stack());
    const r = await f.runDiagnostic({ mode: "INSPECT", subject: "mv", plan: true, runId: "z-1" });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("MODE_VIOLATION");

    expect(f.listUsage().filter((u) => u.runId === "z-1")).toHaveLength(0);
    const summary = f.getRunUsage("z-1");
    expect(summary).toBeDefined();
    expect(summary?.invocations).toBe(0);
    expect(summary?.failed).toBe(0);
    expect(summary?.costUsd).toBe(0);
    expect(summary?.promptTokens).toBe(0);
    expect(summary?.completionTokens).toBe(0);
    expect(summary?.models).toEqual([]);
    // The error is not hidden: it stays on the run record itself.
    const run = f.getRun("z-1");
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("MODE_VIOLATION");
  });

  it("writes no usage record when every step fails before the engine (unknown role)", async () => {
    const f = new DesktopFacade(stack());
    const r = await f.runDiagnostic({
      mode: "INSPECT",
      subject: "bad",
      steps: ["IMAGE_GENERATOR", "IMAGE_GENERATOR"],
      runId: "z-2",
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("SPECIALIST_NOT_FOUND");

    expect(f.listUsage().filter((u) => u.runId === "z-2")).toHaveLength(0);
    const summary = f.getRunUsage("z-2");
    expect(summary?.invocations).toBe(0);
    expect(summary?.models).toEqual([]);
    // No phantom model row is invented.
    expect(f.getUsageTotals().invocations).toBe(0);
    expect(f.getUsageTotals().totalCostUsd).toBe(0);
  });

  it("leaves the global totals untouched by unaccounted runs", async () => {
    const s = stack(paidEngine({ costUsd: 0.05 }));
    const f = new DesktopFacade(s);
    await f.runDiagnostic({ mode: "INSPECT", subject: "paid", runId: "z-3" });
    expect(f.getUsageTotals()).toEqual({ invocations: 1, totalCostUsd: 0.05, totalTokens: 0 });

    // A subsequent pre-engine failure adds nothing to the totals.
    await f.runDiagnostic({ mode: "INSPECT", subject: "mv", plan: true, runId: "z-4" });
    expect(f.getUsageTotals()).toEqual({ invocations: 1, totalCostUsd: 0.05, totalTokens: 0 });
  });
});
