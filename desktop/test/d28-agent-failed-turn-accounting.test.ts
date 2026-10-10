/**
 * D28: a settled turn is accounted even when the gateway reported it as failed
 * or empty.
 *
 * The confirmed defect: the execution engine commits a turn's cost to the budget
 * ledger on ANY resolve — including a result the provider returned as failed, or
 * a result that came back with neither text nor tool calls. The agent loop
 * captured the accounting only AFTER its ok/empty gate, so such a turn charged
 * the ledger and was then dropped before a UsageRecord was written. The usage
 * totals silently excluded spend the ledger had already charged, and the two
 * disagreed — exactly the invariant D27 existed to hold, on a path D27 did not
 * cover. The workflow path had always recorded these as `outcome: "failed"`.
 *
 * What is pinned here:
 *
 *   - a turn the provider resolved as failed still settles its accounting, and
 *     the usage record carries the cost and `outcome: "failed"`;
 *   - a turn that resolved empty does the same;
 *   - the usage totals and the budget ledger agree in both cases;
 *   - a turn that succeeded is still labelled `outcome: "ok"` — the new label
 *     follows the gateway's verdict, it does not flip every record.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvocationPortal } from "../../src/execution/engine.ts";
import type { BudgetLedger } from "../../src/registry/budget.ts";
import { buildDesktopStack } from "../src/desktop-stack.ts";
import { DesktopFacade } from "../src/facade.ts";
import { MemoryCredentialProvider } from "../src/credentials/memory-credential-provider.ts";

let dir: string;
let project: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-d28-"));
  project = mkdtempSync(join(tmpdir(), "aio-d28-proj-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

/**
 * A stub engine that mirrors the real engine's settle phase — committing the
 * actual cost to the budget ledger on resolve, whatever the provider's verdict —
 * and then RESOLVES rather than throwing. This is the case the two shipped
 * adapters never produce (they throw on failure), so the accounting path it
 * exercises was unreachable before D28.
 */
function resolvingEngine(opts: {
  readonly ok: boolean;
  readonly text: string;
  readonly toolCalls?: unknown[];
  readonly costUsd: number;
  readonly getBudget: () => BudgetLedger;
}): InvocationPortal {
  return {
    invoke: async () => {
      opts.getBudget().commit(opts.costUsd);
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
          ok: opts.ok,
          text: opts.text,
          toolCalls: opts.toolCalls,
          costUsd: opts.costUsd,
          latencyMs: 4,
        },
        committedUsd: opts.costUsd,
      } as never;
    },
  };
}

describe("a settled agent turn the gateway reported as failed is still accounted", () => {
  it("records the cost and labels the usage record failed when the provider resolved ok:false", async () => {
    let ledger: BudgetLedger | undefined;
    const s = buildDesktopStack({
      baseDir: dir,
      credentials: new MemoryCredentialProvider(),
      overrides: {
        agentEngine: resolvingEngine({
          ok: false,
          text: "",
          costUsd: 0.03,
          getBudget: () => ledger as BudgetLedger,
        }),
      },
    });
    s.settingsStore.patch({ workspaceRoots: [project] });
    ledger = s.budget;
    const f = new DesktopFacade(s);

    const r = await f.runAgent({ runId: "f-1", prompt: "anything", mode: "INSPECT" });

    // The run failed, and the failure is not hidden.
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("PROVIDER_CALL_FAILED");
    // ...but the invocation settled and charged, so its accounting survived.
    expect(r.accounting).toHaveLength(1);
    expect(r.accounting?.[0]).toMatchObject({ turn: 0, committedUsd: 0.03, failed: true });

    const records = f.listUsage().filter((u) => u.runId === "f-1");
    expect(records.map((u) => u.id)).toEqual(["usage-f-1-0"]);
    expect(records[0].costUsd).toBe(0.03);
    expect(records[0].outcome).toBe("failed");

    const summary = f.getRunUsage("f-1");
    expect(summary?.invocations).toBe(1);
    expect(summary?.costUsd).toBe(0.03);
    expect(summary?.failed).toBe(1);

    // The whole point: what the ledger was charged and what the store reports
    // are the same number.
    expect(f.getUsageTotals().totalCostUsd).toBe(s.budget.snapshot().spentUsd);

    const run = f.getRun("f-1");
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("PROVIDER_CALL_FAILED");
  });

  it("records the cost when a turn resolves ok but empty", async () => {
    let ledger: BudgetLedger | undefined;
    const s = buildDesktopStack({
      baseDir: dir,
      credentials: new MemoryCredentialProvider(),
      overrides: {
        agentEngine: resolvingEngine({
          ok: true,
          text: "",
          costUsd: 0.02,
          getBudget: () => ledger as BudgetLedger,
        }),
      },
    });
    s.settingsStore.patch({ workspaceRoots: [project] });
    ledger = s.budget;
    const f = new DesktopFacade(s);

    const r = await f.runAgent({ runId: "f-2", prompt: "anything", mode: "INSPECT" });

    expect(r.ok).toBe(false);
    expect(r.error?.message).toBe("the model returned an empty turn");
    expect(r.accounting?.[0]).toMatchObject({ turn: 0, committedUsd: 0.02, failed: true });

    const records = f.listUsage().filter((u) => u.runId === "f-2");
    expect(records).toHaveLength(1);
    expect(records[0].costUsd).toBe(0.02);
    expect(records[0].outcome).toBe("failed");

    expect(f.getUsageTotals().totalCostUsd).toBe(s.budget.snapshot().spentUsd);
  });

  it("still labels a settled turn that succeeded ok", async () => {
    let ledger: BudgetLedger | undefined;
    const s = buildDesktopStack({
      baseDir: dir,
      credentials: new MemoryCredentialProvider(),
      overrides: {
        agentEngine: resolvingEngine({
          ok: true,
          text: "here is the answer",
          costUsd: 0.01,
          getBudget: () => ledger as BudgetLedger,
        }),
      },
    });
    s.settingsStore.patch({ workspaceRoots: [project] });
    ledger = s.budget;
    const f = new DesktopFacade(s);

    const r = await f.runAgent({ runId: "f-3", prompt: "anything", mode: "INSPECT" });

    expect(r.ok).toBe(true);
    expect(r.accounting?.[0]).toMatchObject({ turn: 0, committedUsd: 0.01, failed: false });

    const records = f.listUsage().filter((u) => u.runId === "f-3");
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("ok");

    const summary = f.getRunUsage("f-3");
    expect(summary?.failed).toBe(0);
    expect(f.getUsageTotals().totalCostUsd).toBe(s.budget.snapshot().spentUsd);
  });
});
