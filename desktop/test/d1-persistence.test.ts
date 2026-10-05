/**
 * D1 persistence tests.
 *
 * Proves the store layer survives a restart, that existing in-memory behaviour
 * is untouched, and that the file stores refuse to escape their directory.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileRunStore,
  MemoryRunStore,
} from "../src/persistence/run-store.ts";
import { FileUsageStore, MemoryUsageStore } from "../src/persistence/usage-store.ts";
import { FileSettingsStore, MemorySettingsStore } from "../src/persistence/settings-store.ts";
import { FileLogStore, MemoryLogStore } from "../src/persistence/log-store.ts";
import { JsonFileStore, JsonlAppendStore } from "../src/persistence/json-store.ts";
import { PersistentApprovalStore } from "../src/persistence/persistent-approval-store.ts";
import type { PersistedApprovals } from "../src/persistence/persistent-approval-store.ts";
import { PersistentBudgetLedger } from "../src/persistence/persistent-budget-ledger.ts";
import type { PersistedBudget } from "../src/persistence/persistent-budget-ledger.ts";
import { resolveDataPaths } from "../src/persistence/paths.ts";
import type { RunRecord } from "../src/persistence/types.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-d1-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("run store", () => {
  const sample: RunRecord = {
    id: "run-1",
    mode: "INSPECT",
    subject: "x",
    startedAt: 1000,
    status: "completed",
    ok: true,
    iterations: 1,
    pausedForHuman: false,
    escalated: false,
  };

  it("survives a restart with the file-backed store", () => {
    const first = new FileRunStore(new JsonFileStore(dir, "runs.json"));
    first.record(sample);
    first.save();
    const reopened = new FileRunStore(new JsonFileStore(dir, "runs.json"));
    expect(reopened.list()).toEqual([sample]);
  });

  it("lists newest first", () => {
    const store = new FileRunStore(new JsonFileStore(dir, "runs.json"));
    store.record({ ...sample, id: "old", startedAt: 1000 });
    store.record({ ...sample, id: "new", startedAt: 2000 });
    expect(store.list().map((r) => r.id)).toEqual(["new", "old"]);
  });

  it("updates an existing run in place", () => {
    const store = new MemoryRunStore();
    store.record(sample);
    store.update("run-1", { status: "failed", ok: false });
    expect(store.get("run-1")?.status).toBe("failed");
  });

  it("ignores an update to an unknown run", () => {
    const store = new MemoryRunStore();
    store.update("nope", { status: "failed" });
    expect(store.list()).toHaveLength(0);
  });
});

describe("usage store", () => {
  it("totals cost and tokens across restarts", () => {
    const first = new FileUsageStore(new JsonFileStore(dir, "usage.json"));
    first.record({
      id: "u1",
      runId: "r1",
      ts: 1,
      modelId: "local/deterministic",
      capability: "CODING",
      adapterId: "local",
      promptTokens: 10,
      completionTokens: 5,
      costUsd: 0,
      latencyMs: 3,
      outcome: "ok",
    });
    first.save();
    const reopened = new FileUsageStore(new JsonFileStore(dir, "usage.json"));
    expect(reopened.totals()).toEqual({ invocations: 1, totalCostUsd: 0, totalTokens: 15 });
  });

  it("computes totals in memory identically", () => {
    const store = new MemoryUsageStore();
    store.record({
      id: "u1",
      runId: null,
      ts: 1,
      modelId: "m",
      capability: "CODING",
      adapterId: "local",
      costUsd: 1.5,
      latencyMs: 1,
      outcome: "ok",
    });
    expect(store.totals()).toEqual({ invocations: 1, totalCostUsd: 1.5, totalTokens: 0 });
  });
});

describe("settings store", () => {
  it("persists and re-reads a patch", () => {
    const first = new FileSettingsStore(new JsonFileStore(dir, "settings.json"));
    first.patch({ theme: "dark", workspaceRoots: ["D:\\proj"] });
    const reopened = new FileSettingsStore(new JsonFileStore(dir, "settings.json"));
    expect(reopened.get()).toEqual({
      workspaceRoots: ["D:\\proj"],
      theme: "dark",
      defaultMode: "INSPECT",
    });
  });

  it("drops unknown keys, so no frozen field can be injected", () => {
    const store = new MemorySettingsStore();
    // A caller cannot smuggle a frozen field through settings: the sanitizer
    // only copies known keys, so an unknown key is silently dropped.
    const patched = store.patch({
      theme: "light",
      spendBudgetUsd: 1000,
    } as Partial<Record<string, unknown>>);
    expect(patched.theme).toBe("light");
    expect(patched).not.toHaveProperty("spendBudgetUsd");
  });

  it("resets to defaults", () => {
    const store = new FileSettingsStore(new JsonFileStore(dir, "settings.json"));
    store.patch({ theme: "dark" });
    store.reset();
    expect(store.get().theme).toBe("system");
  });
});

describe("log store", () => {
  it("appends and re-reads records across restarts", () => {
    const file = join(dir, "logs.jsonl");
    const first = new FileLogStore(new JsonlAppendStore(dir, "logs.jsonl"));
    first.append({ ts: 1, level: "info", msg: "hello", runId: "run-1" });
    const reopened = new FileLogStore(new JsonlAppendStore(dir, "logs.jsonl"));
    expect(reopened.list()).toEqual([{ ts: 1, level: "info", msg: "hello", runId: "run-1" }]);
  });

  it("filters by a since timestamp", () => {
    const store = new FileLogStore(new JsonlAppendStore(dir, "logs.jsonl"));
    store.append({ ts: 100, level: "info", msg: "old" });
    store.append({ ts: 200, level: "info", msg: "new" });
    expect(store.list(150).map((r) => r.msg)).toEqual(["new"]);
  });

  it("drops fields whose names look like secrets", () => {
    const store = new MemoryLogStore();
    store.append({ ts: 1, level: "info", msg: "m", fields: { apiKey: "abc", model: "x" } });
    expect(store.list()[0]?.fields).toEqual({ model: "x" });
  });

  it("survives a malformed line without losing earlier entries", () => {
    const store = new FileLogStore(new JsonlAppendStore(dir, "logs.jsonl"));
    store.append({ ts: 1, level: "info", msg: "good" });
    // Corrupt the tail with a partial write, then re-open.
    writeFileSync(join(dir, "logs.jsonl"), "NOT-JSON\n", { flag: "a" });
    const reopened = new FileLogStore(new JsonlAppendStore(dir, "logs.jsonl"));
    expect(reopened.list().map((r) => r.msg)).toContain("good");
  });
});

describe("persistent core stores", () => {
  it("restores approvals across restart", () => {
    const file = new JsonFileStore<PersistedApprovals>(dir, "approvals.json");
    const first = new PersistentApprovalStore(undefined, file);
    first.grant({ modelId: "openrouter/coding", scope: "session", grantedAt: 5 });
    const reopened = new PersistentApprovalStore(
      undefined,
      new JsonFileStore<PersistedApprovals>(dir, "approvals.json"),
    );
    expect(reopened.isApproved("openrouter/coding")).toBe(true);
    expect(reopened.get("openrouter/coding")?.scope).toBe("session");
  });

  it("persists a revocation", () => {
    const file = new JsonFileStore<PersistedApprovals>(dir, "approvals.json");
    const first = new PersistentApprovalStore(undefined, file);
    first.grant({ modelId: "m", scope: "run", grantedAt: 1 });
    first.revoke("m");
    expect(new PersistentApprovalStore(undefined, file).isApproved("m")).toBe(false);
  });

  it("restores reserved and spent budget across restart", () => {
    const file = new JsonFileStore<PersistedBudget>(dir, "budget.json");
    const first = new PersistentBudgetLedger(10, undefined, file);
    expect(first.reserve(4)).toBe(true);
    first.commit(2);
    expect(first.snapshot()).toEqual({ budgetUsd: 10, reservedUsd: 2, spentUsd: 2 });

    const reopened = new PersistentBudgetLedger(
      10,
      undefined,
      new JsonFileStore<PersistedBudget>(dir, "budget.json"),
    );
    expect(reopened.snapshot()).toEqual({ budgetUsd: 10, reservedUsd: 2, spentUsd: 2 });
    // The restored ledger still enforces the budget ceiling.
    expect(reopened.reserve(100)).toBe(false);
    expect(reopened.remaining()).toBe(6);
  });

  it("releases a reservation and persists the release", () => {
    const file = new JsonFileStore<PersistedBudget>(dir, "budget.json");
    const first = new PersistentBudgetLedger(10, undefined, file);
    first.reserve(5);
    first.release(5);
    expect(new PersistentBudgetLedger(10, undefined, file).remaining()).toBe(10);
  });

  it("keeps the in-memory default stack behaviour identical", () => {
    // Plain core classes are still constructible with no persistence wiring.
    const plain = new PersistentBudgetLedger(0);
    expect(plain.snapshot()).toEqual({ budgetUsd: 0, reservedUsd: 0, spentUsd: 0 });
    expect(plain.reserve(1)).toBe(false); // frozen budget 0
  });
});

describe("store path safety", () => {
  it("resolves all data paths inside the base directory", () => {
    const paths = resolveDataPaths(dir);
    for (const p of Object.values(paths)) {
      expect(p.startsWith(dir)).toBe(true);
    }
  });

  it("refuses a file path that would escape its directory", () => {
    expect(() => new JsonFileStore(dir, "../escape.json")).toThrow(/escapes/);
  });

  it("writes atomically via a temp rename, leaving no temp file behind", () => {
    const store = new JsonFileStore(dir, "state.json");
    store.write({ a: 1 });
    expect(existsSync(join(dir, "state.json"))).toBe(true);
    expect(existsSync(join(dir, "state.json.tmp"))).toBe(false);
    expect(readFileSync(join(dir, "state.json"), "utf8")).toContain('"a": 1');
  });
});
