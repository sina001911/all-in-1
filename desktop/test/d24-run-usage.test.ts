/**
 * D24: per-run accounting. The Runs view can finally show what a run cost and
 * how many tokens it consumed — derived from the usage store the engine
 * already writes, never invented, and exposed through one new read-only
 * channel on the enumerated IPC boundary.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDesktopStack, type DesktopStack } from "../src/desktop-stack.ts";
import { DesktopFacade } from "../src/facade.ts";
import { MemoryCredentialProvider } from "../src/credentials/memory-credential-provider.ts";
import { IPC_CHANNELS } from "../src/ipc-channels.ts";
import type { UsageRecord } from "../src/persistence/types.ts";

const SRC = join(process.cwd(), "desktop", "src");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-d24-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function stack(): DesktopStack {
  return buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() });
}

function facade(): DesktopFacade {
  return new DesktopFacade(stack());
}

function usage(runId: string | null, modelId: string, over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: over.id ?? `u-${Math.random().toString(36).slice(2, 8)}`,
    runId,
    ts: over.ts ?? Date.now(),
    modelId,
    capability: over.capability ?? "code-review",
    adapterId: over.adapterId ?? "local",
    promptTokens: over.promptTokens,
    completionTokens: over.completionTokens,
    costUsd: over.costUsd ?? 0,
    latencyMs: over.latencyMs ?? 1,
    outcome: over.outcome ?? "ok",
    errorCode: over.errorCode,
  };
}

describe("facade: per-run accounting", () => {
  it("aggregates cost, tokens, failures and a per-model breakdown for one run", () => {
    const s = stack();
    const f = new DesktopFacade(s);
    s.usageStore.record(usage("run-a", "local/one", { promptTokens: 100, completionTokens: 40, costUsd: 0.001 }));
    s.usageStore.record(usage("run-a", "local/two", { promptTokens: 10, completionTokens: 5, costUsd: 0.004 }));
    s.usageStore.record(usage("run-a", "local/one", { outcome: "failed", errorCode: "PROVIDER_CALL_FAILED" }));
    s.usageStore.record(usage("run-b", "local/one", { costUsd: 9 }));

    const a = f.getRunUsage("run-a");
    expect(a?.invocations).toBe(3);
    expect(a?.costUsd).toBeCloseTo(0.005, 9);
    expect(a?.promptTokens).toBe(110);
    expect(a?.completionTokens).toBe(45);
    expect(a?.failed).toBe(1);
    expect(a?.models).toHaveLength(2);
    // Most expensive model first, then a stable name order.
    expect(a?.models.map((m) => m.modelId)).toEqual(["local/two", "local/one"]);
    expect(a?.models[0]?.invocations).toBe(1);
    expect(a?.models[1]?.invocations).toBe(2);

    const b = f.getRunUsage("run-b");
    expect(b?.costUsd).toBe(9);
    expect(b?.models.map((m) => m.modelId)).toEqual(["local/one"]);
  });

  it("reports an honest zero ledger for a recorded run that burned nothing", async () => {
    const f = facade();
    const r = await f.runDiagnostic({ mode: "INSPECT", subject: "free offline run" });
    const summary = f.getRunUsage(r.runId);
    expect(summary).toBeDefined();
    // The deterministic local adapter is genuinely zero-cost.
    expect(summary?.costUsd).toBe(0);
    expect(summary?.invocations).toBeGreaterThan(0);
  });

  it("reports undefined for a run nobody recorded and nothing billed", () => {
    expect(facade().getRunUsage("never-heard-of-it")).toBeUndefined();
    expect(facade().getRunUsage("")).toBeUndefined();
  });

  it("never attributes unattributed usage to a run", () => {
    const s = stack();
    const f = new DesktopFacade(s);
    s.usageStore.record(usage(null, "local/one", { costUsd: 0.5 }));
    expect(f.getRunUsage("run-a")).toBeUndefined();
    expect(f.listRunUsage()).toEqual([]);
  });

  it("lists every recorded run in run order and keeps spend whose run is gone", () => {
    const s = stack();
    const f = new DesktopFacade(s);
    s.runStore.record({
      id: "run-old",
      mode: "INSPECT",
      subject: "first",
      startedAt: 1000,
      finishedAt: 1100,
      status: "completed",
      ok: true,
      iterations: 1,
      pausedForHuman: false,
      escalated: false,
    });
    s.runStore.record({
      id: "run-new",
      mode: "SUGGEST",
      subject: "second",
      startedAt: 2000,
      finishedAt: 2100,
      status: "completed",
      ok: true,
      iterations: 1,
      pausedForHuman: false,
      escalated: false,
    });
    s.usageStore.record(usage("run-old", "local/one", { costUsd: 0.25 }));
    s.usageStore.record(usage("run-new", "local/one", { costUsd: 0.5 }));

    const summaries = f.listRunUsage();
    // run-store order is newest first.
    expect(summaries.map((s2) => s2.runId)).toEqual(["run-new", "run-old"]);
    expect(summaries[0]?.costUsd).toBe(0.5);

    // Deleting the run records cannot hide what they cost: the usage store is
    // the source of truth, and the map keeps its insertion order.
    s.runStore.clear();
    const after = f.listRunUsage();
    expect(after.map((s2) => s2.runId)).toEqual(["run-old", "run-new"]);
    expect(after[0]?.costUsd).toBe(0.25);
    expect(after[1]?.costUsd).toBe(0.5);
  });

  it("treats non-finite token counts and costs as zero instead of poisoning the sum", () => {
    const s = stack();
    const f = new DesktopFacade(s);
    s.usageStore.record(usage("run-a", "local/one", { promptTokens: 50, costUsd: Number.NaN }));
    s.usageStore.record(usage("run-a", "local/one", { completionTokens: 25 }));
    const a = f.getRunUsage("run-a");
    expect(a?.costUsd).toBe(0);
    expect(a?.promptTokens).toBe(50);
    expect(a?.completionTokens).toBe(25);
  });

  it("is read-only: no store gains a record, no file appears", () => {
    const s = stack();
    const f = new DesktopFacade(s);
    s.usageStore.record(usage("run-a", "local/one", { costUsd: 0.1 }));
    const before = readdirSync(dir).sort();
    const beforeUsage = s.usageStore.list().length;
    const beforeRuns = s.runStore.list().length;

    f.getRunUsage("run-a");
    f.listRunUsage();

    expect(readdirSync(dir).sort()).toEqual(before);
    expect(s.usageStore.list()).toHaveLength(beforeUsage);
    expect(s.runStore.list()).toHaveLength(beforeRuns);
  });

  it("carries no credential value into the ledger", () => {
    const s = stack();
    const f = new DesktopFacade(s);
    f.setCredential("OPENROUTER_API_KEY", "sk-secret-value");
    s.usageStore.record(usage("run-a", "local/one", { costUsd: 0.1 }));
    expect(JSON.stringify(f.listRunUsage())).not.toContain("sk-secret-value");
    expect(JSON.stringify(f.getRunUsage("run-a"))).not.toContain("sk-secret-value");
  });
});

describe("D24 boundary: one new read-only channel, wired end to end", () => {
  it("is enumerated exactly once in the channel list", () => {
    const channels = [...IPC_CHANNELS];
    expect(channels.filter((c) => c === "all-in-1:run:usage")).toHaveLength(1);
  });

  it("is registered by main with a string-arg guard", () => {
    const main = readFileSync(join(SRC, "main.ts"), "utf8");
    expect(main).toContain('"all-in-1:run:usage"');
    expect(main).toContain("facade.getRunUsage");
    expect(main).toContain("facade.listRunUsage");
  });

  it("is exposed by the preload with no value-bearing method added", () => {
    const preload = readFileSync(join(SRC, "preload.cjs"), "utf8");
    expect(preload).toContain("getRunUsage");
    // The preload still exposes exactly one bridge object.
    expect((preload.match(/exposeInMainWorld/g) ?? []).length).toBe(1);
  });

  it("reaches the renderer through the bridge and formats cost honestly", () => {
    const renderer = readFileSync(join(SRC, "renderer", "renderer.js"), "utf8");
    expect(renderer).toContain("api.getRunUsage");
    expect(renderer).toContain("function formatUsd");
    expect(renderer).toContain('"Cost"');
    expect(renderer).toContain("Accounting");
    // No new capability leaked into the page.
    expect(renderer).not.toMatch(/ipcRenderer/);
    expect(renderer).not.toMatch(/require\(/);
  });
});
