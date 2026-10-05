/**
 * D1 cancellation tests.
 *
 * The core already implements cancellation end-to-end; D1 only adds a per-run
 * AbortController hub. These tests prove the hub feeds the existing mechanism
 * and — the security-critical property — that aborting releases the budget
 * reservation, through the real engine, with the release *persisted*.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CancellationHub } from "../src/cancellation.ts";
import { PersistentBudgetLedger } from "../src/persistence/persistent-budget-ledger.ts";
import type { PersistedBudget } from "../src/persistence/persistent-budget-ledger.ts";
import { JsonFileStore } from "../src/persistence/json-store.ts";
import { ExecutionEngine } from "../../src/execution/engine.ts";
import { AdapterRegistry } from "../../src/execution/adapter-registry.ts";
import { BaseProviderAdapter } from "../../src/providers/types.ts";
import type { ProviderInvokeRequest } from "../../src/providers/types.ts";
import type { ProviderInvokeResult } from "../../src/execution/types.ts";
import { ModelCatalog } from "../../src/models/catalog.ts";
import { registerLocalModels } from "../../src/execution/local-adapter.ts";
import { CapabilityRegistry } from "../../src/capabilities/registry.ts";
import { registerBaselineCapabilities } from "../../src/capabilities/capabilities.ts";
import { PriorityChains } from "../../src/models/priorities.ts";
import { ApprovalStore } from "../../src/registry/approvals.ts";
import type { ModelDescriptor } from "../../src/models/types.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-cancel-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * An adapter whose invocation never settles on its own. The engine's
 * `raceInvocation` races it against the abort signal/timeout and settles the
 * call from outside, so this is exactly the shape needed to observe
 * mid-invocation cancellation.
 */
class HangingAdapter extends BaseProviderAdapter {
  constructor() {
    super({
      id: "hanging",
      displayName: "Hanging",
      protocol: "local",
      locality: "local",
      apiKeyEnv: null,
      endpoint: null,
      capabilities: ["CODING"],
      availableWithoutCredentials: true,
    });
  }
  override async invoke(_request: ProviderInvokeRequest): Promise<ProviderInvokeResult> {
    return new Promise<ProviderInvokeResult>(() => {
      // Deliberately never resolves nor rejects. Only the engine's race
      // against the caller's abort signal / timeout settles this call.
    });
  }
}

function buildEngine(budget: PersistentBudgetLedger, approvals: ApprovalStore): ExecutionEngine {
  const catalog = new ModelCatalog();
  registerLocalModels(catalog);
  const priced: ModelDescriptor = {
    id: "hanging/hanging",
    provider: "hanging",
    modelId: "hanging",
    displayName: "Hanging Priced",
    capabilities: ["CODING"],
    inputModalities: ["TEXT"],
    outputModalities: ["TEXT"],
    contextLimit: 8_000,
    outputLimit: 1_000,
    tools: false,
    structuredOutput: false,
    streaming: false,
    pricing: {
      costClass: "PAID",
      inputPer1M: 1_000_000,
      outputPer1M: 1_000_000,
      notes: "test fixture",
    },
    available: true,
    locality: "remote",
    status: "active",
    providerAdapter: "hanging",
    priority: 10,
    enabled: true,
  };
  catalog.register(priced);
  const capabilities = new CapabilityRegistry();
  registerBaselineCapabilities(capabilities);
  const adapters = new AdapterRegistry();
  adapters.register(new HangingAdapter());
  return new ExecutionEngine({
    catalog,
    capabilities,
    chains: new PriorityChains(catalog),
    approvals,
    budget,
    adapters,
    policy: "PREMIUM_ALLOWED",
  });
}

describe("cancellation hub", () => {
  it("hands the same signal for a repeated run id", () => {
    const hub = new CancellationHub();
    const a = hub.signalFor("r1");
    const b = hub.signalFor("r1");
    expect(a).toBe(b);
    expect(hub.isCancelled("r1")).toBe(false);
  });

  it("aborts the run and reports cancellation", () => {
    const hub = new CancellationHub();
    const signal = hub.signalFor("r1");
    expect(hub.cancel("r1")).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(hub.isCancelled("r1")).toBe(true);
  });

  it("reports false when cancelling an unknown run", () => {
    expect(new CancellationHub().cancel("nope")).toBe(false);
  });

  it("releases a finished run so its controller can be collected", () => {
    const hub = new CancellationHub();
    hub.signalFor("r1");
    hub.release("r1");
    expect(hub.cancel("r1")).toBe(false);
  });

  it("aborts every live run on cancelAll", () => {
    const hub = new CancellationHub();
    const s1 = hub.signalFor("r1");
    const s2 = hub.signalFor("r2");
    hub.cancelAll();
    expect(s1.aborted).toBe(true);
    expect(s2.aborted).toBe(true);
  });
});

describe("cancellation releases the budget reservation", () => {
  it("releases on abort with PROVIDER_CANCELLED and returns the ledger to its start", async () => {
    const file: JsonFileStore<PersistedBudget> = new JsonFileStore(dir, "budget.json");
    const budget = new PersistentBudgetLedger(5, undefined, file);
    const approvals = new ApprovalStore();
    approvals.grant({ modelId: "hanging/hanging", scope: "session", grantedAt: 1 });
    const engine = buildEngine(budget, approvals);

    const hub = new CancellationHub();
    const signal = hub.signalFor("run-x");

    const invocation = engine.invoke(
      { capability: "CODING", inputs: [{ kind: "text", text: "block" }] },
      { signal },
    );

    // Let the call reach the adapter and reserve before aborting.
    await new Promise((r) => setTimeout(r, 60));
    expect(budget.snapshot().reservedUsd).toBe(2);

    hub.cancel("run-x");

    await expect(invocation).rejects.toThrow(/cancelled by the caller/);
    expect(budget.snapshot()).toEqual({ budgetUsd: 5, reservedUsd: 0, spentUsd: 0 });
    expect(hub.isCancelled("run-x")).toBe(true);
  });

  it("persists the release so it survives a restart", async () => {
    const file = new JsonFileStore<PersistedBudget>(dir, "budget.json");
    const budget = new PersistentBudgetLedger(5, undefined, file);
    const approvals = new ApprovalStore();
    approvals.grant({ modelId: "hanging/hanging", scope: "session", grantedAt: 1 });
    const engine = buildEngine(budget, approvals);

    const controller = new AbortController();
    const invocation = engine.invoke(
      { capability: "CODING", inputs: [{ kind: "text", text: "block" }] },
      { signal: controller.signal },
    );
    await new Promise((r) => setTimeout(r, 60));
    controller.abort();
    await expect(invocation).rejects.toThrow();

    const reopened = new PersistentBudgetLedger(5, undefined, new JsonFileStore(dir, "budget.json"));
    expect(reopened.snapshot()).toEqual({ budgetUsd: 5, reservedUsd: 0, spentUsd: 0 });
  });

  it("commits and releases nothing on a timed-out call", async () => {
    const budget = new PersistentBudgetLedger(5);
    const approvals = new ApprovalStore();
    approvals.grant({ modelId: "hanging/hanging", scope: "session", grantedAt: 1 });
    const engine = buildEngine(budget, approvals);

    await expect(
      engine.invoke(
        { capability: "CODING", inputs: [{ kind: "text", text: "block" }] },
        { timeoutMs: 40 },
      ),
    ).rejects.toThrow(/timeout/);

    expect(budget.snapshot()).toEqual({ budgetUsd: 5, reservedUsd: 0, spentUsd: 0 });
  });
});
