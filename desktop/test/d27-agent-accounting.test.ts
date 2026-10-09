/**
 * D27: agent runs are accounted and visible.
 *
 * The confirmed defect: the agent path invoked the execution engine —
 * committing real spend to the budget ledger — but recorded neither a
 * RunRecord nor a UsageRecord. An agent run was absent from the Runs view, the
 * usage totals silently excluded spend the ledger had already charged, and the
 * two could disagree. The workflow path had been accounted since D24/D26; the
 * agent path never was.
 *
 * What is pinned here:
 *
 *   - a run records itself, and one usage record per turn it actually settled;
 *   - the cost in the accounting is the same number the ledger was charged;
 *   - a paused run continued later accounts only for its later turns;
 *   - a run that settled nothing reports a genuine zero ledger, and the error
 *     that stopped it stays on the run record;
 *   - a cancelled run records the cancellation and accounts only for the turns
 *     that had already settled.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvocationPortal } from "../../src/execution/engine.ts";
import type { BudgetLedger } from "../../src/registry/budget.ts";
import type { ToolCall } from "../../src/agent/index.ts";
import { AllInOneError, type ErrorCode } from "../../src/errors.ts";
import { buildDesktopStack, type DesktopStack } from "../src/desktop-stack.ts";
import { DesktopFacade } from "../src/facade.ts";
import { MemoryCredentialProvider } from "../src/credentials/memory-credential-provider.ts";

let dir: string;
let project: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-d27-"));
  project = mkdtempSync(join(tmpdir(), "aio-d27-proj-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function realStack(): DesktopFacade {
  const s = buildDesktopStack({
    baseDir: dir,
    credentials: new MemoryCredentialProvider(),
  });
  s.settingsStore.patch({ workspaceRoots: [project] });
  return new DesktopFacade(s);
}

/** A prompt that makes the deterministic local model emit these tool calls. */
function withToolCalls(calls: ToolCall[], body = "on it"): string {
  const block = JSON.stringify(calls, null, 2);
  return `${body}\n\n\`\`\`tool-calls\n${block}\n\`\`\``;
}

/**
 * A stub engine that mirrors the real engine's settle phase (committing the
 * actual cost to the budget ledger) and plays a two-turn agent conversation:
 * the first turn asks for a tool, the second answers in plain text.
 */
function paidAgentEngine(opts: {
  readonly costUsd?: number;
  readonly getBudget: () => BudgetLedger;
}): InvocationPortal {
  let calls = 0;
  return {
    invoke: async () => {
      calls += 1;
      const committed = Math.max(0, opts.costUsd ?? 0.02);
      opts.getBudget().commit(committed);
      const first = calls === 1;
      return {
        decision: {
          ok: true,
          model: { provider: "stub", modelId: "agent" },
          costEstimateUsd: 0,
          requiresApproval: false,
        },
        adapterId: "acme",
        result: {
          providerId: "stub",
          modelId: "acme/agent",
          capability: "CODING",
          ok: true,
          text: first ? "" : "done",
          toolCalls: first
            ? [
                {
                  id: "c1",
                  toolName: "files.read",
                  input: { path: join(project, "a.txt") },
                  justification: "reading the file the user asked about",
                },
              ]
            : undefined,
          costUsd: committed,
          latencyMs: 5,
        },
        committedUsd: committed,
      } as never;
    },
  };
}

/** An engine that refuses before any model is reached. */
function failingEngine(code: ErrorCode = "SELECTION_FAILED"): InvocationPortal {
  return {
    invoke: async () => {
      throw new AllInOneError("no model is selectable for this capability", code, "config", {
        retryable: false,
      });
    },
  };
}

describe("an agent run on the real stack is accounted", () => {
  it("records the run and one zero-cost usage record per settled turn", async () => {
    const f = realStack();
    writeFileSync(join(project, "a.txt"), "the answer is 42");

    const prompt = withToolCalls(
      [{ id: "1", toolName: "files.read", input: { path: join(project, "a.txt") } }],
      "read the file",
    );
    const first = await f.runAgent({ runId: "a-1", prompt, mode: "INSPECT" });
    // A non-auto run pauses after a turn that asked for a tool.
    expect(first.pausedForHuman).toBe(true);
    expect(first.accounting).toHaveLength(1);
    expect(first.accounting?.[0]).toMatchObject({
      turn: 0,
      modelId: "local/agent",
      committedUsd: 0,
    });

    const second = await f.runAgent({
      runId: "a-1",
      prompt: "answer in plain text, call no tools",
      mode: "INSPECT",
    });
    expect(second.ok).toBe(true);
    expect(second.turns).toBe(2);
    // Only the turn this call settled is reported, at its absolute index.
    expect(second.accounting?.map((a) => a.turn)).toEqual([1]);

    const run = f.getRun("a-1");
    expect(run).toMatchObject({
      kind: "agent",
      mode: "INSPECT",
      status: "completed",
      ok: true,
      iterations: 2,
      pausedForHuman: false,
    });
    // The run is labelled by the prompt it opened with, not the steering prompt.
    expect(run?.subject.endsWith("…")).toBe(true);
    expect(prompt.startsWith(run!.subject.slice(0, -1))).toBe(true);
    expect(run?.subject.length).toBeLessThanOrEqual(160);
    expect(run?.deliverable).toBe(second.text);

    const records = f.listUsage().filter((u) => u.runId === "a-1");
    expect(records.map((u) => u.id).sort()).toEqual(["usage-a-1-0", "usage-a-1-1"]);
    expect(records.every((u) => u.modelId === "local/agent")).toBe(true);
    // The local model is genuinely zero-cost, and it reports no usage frame:
    // absent tokens mean unreported, never zero-invented.
    expect(records.every((u) => u.costUsd === 0)).toBe(true);
    expect(records.every((u) => u.promptTokens === undefined && u.completionTokens === undefined)).toBe(true);

    const summary = f.getRunUsage("a-1");
    expect(summary?.invocations).toBe(2);
    expect(summary?.costUsd).toBe(0);
    expect(summary?.models).toHaveLength(1);
    expect(summary?.models[0]).toMatchObject({ modelId: "local/agent", invocations: 2 });
    // The run is no longer invisible: it counts towards the totals.
    expect(f.getUsageTotals().invocations).toBe(2);
  });

  it("bounds the subject it persists", async () => {
    const f = realStack();
    const long = "x".repeat(500);
    await f.runAgent({ runId: "a-2", prompt: long, mode: "INSPECT" });
    const run = f.getRun("a-2");
    expect(run?.subject.length).toBeLessThanOrEqual(160);
    expect(run?.subject.endsWith("…")).toBe(true);
    expect(long.startsWith(run!.subject.slice(0, -1))).toBe(true);
  });

  it("records a cancelled run and accounts only for the turns that settled", async () => {
    const f = realStack();
    writeFileSync(join(project, "a.txt"), "orig");
    const invocation = f.runAgent({
      runId: "a-3",
      prompt: withToolCalls(
        [{ id: "1", toolName: "files.write", input: { path: join(project, "a.txt"), content: "no" } }],
        "rewrite it",
      ),
      mode: "BUILD",
    });
    // Let the turn settle and the privileged call reach the human.
    await new Promise((r) => setTimeout(r, 60));
    expect(f.listPendingToolApprovals().length).toBeGreaterThan(0);
    expect(f.cancelRun("a-3")).toBe(true);
    const out = await invocation;
    expect(out.error?.code).toBe("AGENT_CANCELLED");

    const run = f.getRun("a-3");
    expect(run?.status).toBe("cancelled");
    expect(run?.ok).toBe(false);
    expect(run?.errorCode).toBe("AGENT_CANCELLED");
    // The one turn that settled is accounted; the un-run ones are not.
    const records = f.listUsage().filter((u) => u.runId === "a-3");
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe("usage-a-3-0");
  });
});

describe("agent accounting agrees with the budget ledger", () => {
  it("charges the ledger and the usage store the same amount, once per turn", async () => {
    let ledger: BudgetLedger | undefined;
    const s = buildDesktopStack({
      baseDir: dir,
      credentials: new MemoryCredentialProvider(),
      overrides: {
        agentEngine: paidAgentEngine({ costUsd: 0.02, getBudget: () => ledger as BudgetLedger }),
      },
    });
    s.settingsStore.patch({ workspaceRoots: [project] });
    ledger = s.budget;
    const f = new DesktopFacade(s);
    writeFileSync(join(project, "a.txt"), "content");

    const first = await f.runAgent({ runId: "p-1", prompt: "read the file", mode: "INSPECT" });
    expect(first.pausedForHuman).toBe(true);
    // The engine committed $0.02 to the ledger, and the accounting says so too.
    expect(s.budget.snapshot().spentUsd).toBe(0.02);
    expect(f.getUsageTotals().totalCostUsd).toBe(0.02);

    const second = await f.runAgent({ runId: "p-1", prompt: "now answer", mode: "INSPECT" });
    expect(second.ok).toBe(true);
    expect(second.turns).toBe(2);

    expect(s.budget.snapshot().spentUsd).toBe(0.04);
    expect(f.getUsageTotals().totalCostUsd).toBe(0.04);
    expect(f.getRunUsage("p-1")?.costUsd).toBe(0.04);

    const records = f.listUsage().filter((u) => u.runId === "p-1");
    // Distinct, run-global ids — the continuation did not re-record turn 0.
    expect(records.map((u) => u.id).sort()).toEqual(["usage-p-1-0", "usage-p-1-1"]);
    expect(records.map((u) => u.costUsd)).toEqual([0.02, 0.02]);
    expect(new Set(records.map((u) => u.id)).size).toBe(2);
  });

  it("keeps the run's start time and counts turns cumulatively across a continuation", async () => {
    let ledger: BudgetLedger | undefined;
    const s = buildDesktopStack({
      baseDir: dir,
      credentials: new MemoryCredentialProvider(),
      overrides: {
        agentEngine: paidAgentEngine({ costUsd: 0.01, getBudget: () => ledger as BudgetLedger }),
      },
    });
    s.settingsStore.patch({ workspaceRoots: [project] });
    ledger = s.budget;
    const f = new DesktopFacade(s);
    writeFileSync(join(project, "a.txt"), "content");

    await f.runAgent({ runId: "c-1", prompt: "read the file", mode: "INSPECT" });
    const startedAt = f.getRun("c-1")?.startedAt;
    expect(f.getRun("c-1")?.iterations).toBe(1);

    await f.runAgent({ runId: "c-1", prompt: "now answer", mode: "INSPECT" });
    expect(f.getRun("c-1")?.startedAt).toBe(startedAt);
    expect(f.getRun("c-1")?.iterations).toBe(2);
    // The run's model breakdown covers both turns, once each.
    expect(f.getRunUsage("c-1")?.models[0]?.invocations).toBe(2);
  });

  it("survives a restart of the stack: a paused record is not a resumable run", async () => {
    let ledger: BudgetLedger | undefined;
    const s1 = buildDesktopStack({
      baseDir: dir,
      credentials: new MemoryCredentialProvider(),
      overrides: {
        agentEngine: paidAgentEngine({ costUsd: 0.02, getBudget: () => ledger as BudgetLedger }),
      },
    });
    s1.settingsStore.patch({ workspaceRoots: [project] });
    ledger = s1.budget;
    const f1 = new DesktopFacade(s1);
    writeFileSync(join(project, "a.txt"), "content");
    await f1.runAgent({ runId: "s-1", prompt: "read the file", mode: "INSPECT" });
    expect(f1.getRun("s-1")?.pausedForHuman).toBe(true);

    // A fresh process: the run's conversation is gone, so this is a new start,
    // not a continuation.
    const s2 = buildDesktopStack({
      baseDir: dir,
      credentials: new MemoryCredentialProvider(),
      overrides: {
        agentEngine: paidAgentEngine({ costUsd: 0.02, getBudget: () => ledger as BudgetLedger }),
      },
    });
    s2.settingsStore.patch({ workspaceRoots: [project] });
    ledger = s2.budget;
    const f2 = new DesktopFacade(s2);
    const restarted = await f2.runAgent({ runId: "s-1", prompt: "answer", mode: "INSPECT" });
    expect(restarted.ok).toBe(true);
    const run = f2.getRun("s-1");
    expect(run?.iterations).toBe(1);
    // The re-invocation is a genuinely new turn: the ledger was charged again.
    expect(ledger.snapshot().spentUsd).toBe(0.04);
    expect(f2.getRunUsage("s-1")?.invocations).toBe(2);
  });
});

describe("agent runs that settle nothing", () => {
  it("writes no usage record and reports a genuine zero ledger", async () => {
    const s = buildDesktopStack({
      baseDir: dir,
      credentials: new MemoryCredentialProvider(),
      overrides: { agentEngine: failingEngine() },
    });
    const f = new DesktopFacade(s);
    const r = await f.runAgent({ runId: "z-1", prompt: "anything", mode: "INSPECT" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("SELECTION_FAILED");
    expect(r.accounting).toBeUndefined();

    expect(f.listUsage().filter((u) => u.runId === "z-1")).toHaveLength(0);
    const summary = f.getRunUsage("z-1");
    expect(summary).toBeDefined();
    expect(summary?.invocations).toBe(0);
    expect(summary?.failed).toBe(0);
    expect(summary?.costUsd).toBe(0);
    expect(summary?.models).toEqual([]);
    // The error is not hidden: it stays on the run record.
    const run = f.getRun("z-1");
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("SELECTION_FAILED");
  });

  it("leaves the ledger and the totals at zero", async () => {
    const s = buildDesktopStack({
      baseDir: dir,
      credentials: new MemoryCredentialProvider(),
      overrides: { agentEngine: failingEngine("BUDGET_EXCEEDED") },
    });
    const f = new DesktopFacade(s);
    await f.runAgent({ runId: "z-2", prompt: "anything", mode: "INSPECT" });
    expect(s.budget.snapshot().spentUsd).toBe(0);
    expect(f.getUsageTotals()).toEqual({ invocations: 0, totalCostUsd: 0, totalTokens: 0 });
  });
});
