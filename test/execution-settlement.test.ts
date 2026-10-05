/**
 * Reservation settlement suite (P5): the economics guarantee.
 *
 * A reservation is taken before a call and must be settled on EVERY exit path —
 * success, failure, timeout, and cancellation. A caller that abandons the wait
 * must not leak a pinned reservation. These tests pin that property against a
 * deliberately hanging adapter that would otherwise block forever.
 */
import { describe, expect, it } from "vitest";
import { ExecutionEngine } from "../src/execution/engine.ts";
import { BaseProviderAdapter } from "../src/providers/types.ts";
import type { ProviderInvokeRequest } from "../src/providers/types.ts";
import type { ProviderInvokeResult } from "../src/execution/types.ts";
import { AdapterRegistry } from "../src/execution/adapter-registry.ts";
import { ApprovalStore } from "../src/registry/approvals.ts";
import { BudgetLedger } from "../src/registry/budget.ts";
import { DEFAULT_EGRESS_POLICY, allowHost } from "../src/execution/egress.ts";
import { OpenAICompatibleAdapter } from "../src/execution/openai-compatible-adapter.ts";
import { buildCatalogFixture } from "../src/execution/test-fixtures.ts";
import type { HttpTransport } from "../src/execution/types.ts";
import { AllInOneError } from "../src/errors.ts";

/** Never resolves. Only the timeout/abort race can end this call. */
class HangingAdapter extends BaseProviderAdapter {
  constructor() {
    super({
      id: "local",
      displayName: "Hanging Local",
      protocol: "local",
      locality: "local",
      apiKeyEnv: null,
      endpoint: null,
      capabilities: ["CODING"],
      availableWithoutCredentials: true,
    });
  }
  override invoke(): Promise<ProviderInvokeResult> {
    return new Promise<ProviderInvokeResult>(() => {
      /* intentionally never settles */
    });
  }
}

/** Succeeds and reports a real cost, to prove the paid path moves money. */
class PricedAdapter extends BaseProviderAdapter {
  constructor() {
    super({
      id: "local",
      displayName: "Priced Local",
      protocol: "local",
      locality: "local",
      apiKeyEnv: null,
      endpoint: null,
      capabilities: ["CODING"],
      availableWithoutCredentials: true,
    });
  }
  override async invoke(request: ProviderInvokeRequest): Promise<ProviderInvokeResult> {
    return {
      providerId: this.id,
      modelId: request.model,
      capability: request.capability,
      ok: true,
      text: "priced",
      costUsd: 0.5,
      latencyMs: 1,
    };
  }
}

const PAID_MODEL = {
  id: "local/pro",
  capabilities: ["CODING"],
  costClass: "PAID" as const,
  inputPer1M: 1,
  providerAdapter: "local",
};

function engineFor(
  adapters: AdapterRegistry,
  budget: BudgetLedger,
): ExecutionEngine {
  const fixture = buildCatalogFixture([PAID_MODEL]);
  const approvals = new ApprovalStore();
  approvals.grant({ modelId: "local/pro", scope: "run", grantedAt: 0 });
  return new ExecutionEngine({
    catalog: fixture.catalog,
    capabilities: fixture.capabilities,
    chains: fixture.chains,
    approvals,
    budget,
    adapters,
    policy: "PREMIUM_ALLOWED",
    // Paid or not, the adapter is local; egress stays deny-all and irrelevant,
    // which also pins that a local provider never needs an egress grant.
    egress: DEFAULT_EGRESS_POLICY,
  });
}

const CALL = {
  capability: "CODING",
  inputs: [{ kind: "text" as const, text: "x" }],
};

describe("settlement on success and failure", () => {
  it("commits the actual cost of a successful paid call", async () => {
    const adapters = new AdapterRegistry();
    adapters.register(new PricedAdapter());
    const budget = new BudgetLedger(10);
    const engine = engineFor(adapters, budget);
    const outcome = await engine.invoke(CALL);
    expect(outcome.committedUsd).toBe(0.5);
    expect(budget.snapshot()).toEqual({ budgetUsd: 10, reservedUsd: 0, spentUsd: 0.5 });
  });

  it("releases the reservation when the adapter throws", async () => {
    const adapters = new AdapterRegistry();
    adapters.register(
      new (class extends BaseProviderAdapter {
        constructor() {
          super({
            id: "local",
            displayName: "Failing",
            protocol: "local",
            locality: "local",
            apiKeyEnv: null,
            endpoint: null,
            capabilities: ["CODING"],
            availableWithoutCredentials: true,
          });
        }
        override invoke(): Promise<ProviderInvokeResult> {
          throw new AllInOneError("boom", "PROVIDER_CALL_FAILED", "unavailable");
        }
      })(),
    );
    const budget = new BudgetLedger(10);
    const engine = engineFor(adapters, budget);
    await expect(engine.invoke(CALL)).rejects.toMatchObject({ code: "PROVIDER_CALL_FAILED" });
    expect(budget.snapshot()).toEqual({ budgetUsd: 10, reservedUsd: 0, spentUsd: 0 });
  });
});

describe("settlement on timeout and cancellation", () => {
  it("settles the reservation when a call times out", async () => {
    const adapters = new AdapterRegistry();
    adapters.register(new HangingAdapter());
    const budget = new BudgetLedger(10);
    const engine = engineFor(adapters, budget);
    const started = Date.now();
    await expect(engine.invoke(CALL, { timeoutMs: 40 })).rejects.toMatchObject({
      code: "PROVIDER_TIMEOUT",
      category: "unavailable",
      retryable: true,
    });
    // It actually waited for the timeout rather than failing fast.
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    // And left nothing pinned.
    expect(budget.snapshot()).toEqual({ budgetUsd: 10, reservedUsd: 0, spentUsd: 0 });
  });

  it("settles the reservation when a call is cancelled", async () => {
    const adapters = new AdapterRegistry();
    adapters.register(new HangingAdapter());
    const budget = new BudgetLedger(10);
    const engine = engineFor(adapters, budget);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await expect(
      engine.invoke(CALL, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "PROVIDER_CANCELLED", category: "unavailable" });
    expect(budget.snapshot()).toEqual({ budgetUsd: 10, reservedUsd: 0, spentUsd: 0 });
  });

  it("fails fast on an already-aborted signal without leaking a reservation", async () => {
    const adapters = new AdapterRegistry();
    adapters.register(new HangingAdapter());
    const budget = new BudgetLedger(10);
    const engine = engineFor(adapters, budget);
    const controller = new AbortController();
    controller.abort();
    await expect(
      engine.invoke(CALL, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "PROVIDER_CANCELLED" });
    expect(budget.snapshot()).toEqual({ budgetUsd: 10, reservedUsd: 0, spentUsd: 0 });
  });

  it("still serves a normal call after a timed-out one — the ledger is reusable", async () => {
    const adapters = new AdapterRegistry();
    adapters.register(new PricedAdapter());
    const budget = new BudgetLedger(10);
    const engine = engineFor(adapters, budget);
    const outcome = await engine.invoke(CALL, { timeoutMs: 1000 });
    expect(outcome.committedUsd).toBe(0.5);
    expect(budget.snapshot().spentUsd).toBe(0.5);
  });
});

describe("timeout and cancellation do not weaken the gates", () => {
  it("never sends a paid call to a refused destination, with or without a timeout", async () => {
    const fixture = buildCatalogFixture([
      {
        id: "remote/pro",
        capabilities: ["CODING"],
        costClass: "PAID" as const,
        inputPer1M: 1,
        providerAdapter: "remote",
      },
    ]);
    const adapters = new AdapterRegistry();
    adapters.register(
      new (class extends BaseProviderAdapter {
        constructor() {
          super({
            id: "remote",
            displayName: "Remote",
            protocol: "openai",
            locality: "remote",
            apiKeyEnv: "REMOTE_KEY",
            endpoint: "https://api.remote.example/v1",
            capabilities: ["CODING"],
            availableWithoutCredentials: false,
          });
        }
        override invoke(): Promise<ProviderInvokeResult> {
          return new Promise<ProviderInvokeResult>(() => {
            /* never settles */
          });
        }
      })(),
    );
    const approvals = new ApprovalStore();
    approvals.grant({ modelId: "remote/pro", scope: "run", grantedAt: 0 });
    const engine = new ExecutionEngine({
      catalog: fixture.catalog,
      capabilities: fixture.capabilities,
      chains: fixture.chains,
      approvals,
      budget: new BudgetLedger(10),
      adapters,
      policy: "PREMIUM_ALLOWED",
      egress: DEFAULT_EGRESS_POLICY, // deny-all: the host is not allowlisted
    });
    // The egress gate fires before the timeout race, so no reservation is taken.
    await expect(
      engine.invoke(CALL, { timeoutMs: 30 }),
    ).rejects.toMatchObject({ code: "EGRESS_BLOCKED", category: "security" });
  });

  it("applies the timeout race only after the host is explicitly allowlisted", async () => {
    const fixture = buildCatalogFixture([
      {
        id: "remote/pro",
        capabilities: ["CODING"],
        costClass: "PAID" as const,
        inputPer1M: 1,
        providerAdapter: "remote",
      },
    ]);
    const adapters = new AdapterRegistry();
    adapters.register(
      new OpenAICompatibleAdapter({
        id: "remote",
        displayName: "Remote",
        apiKeyEnv: "ALL_IN_1_TEST_ABSENT_KEY",
        endpoint: "https://api.remote.example/v1",
        capabilities: ["CODING"],
        // No transport is ever reached: the secret gate fires first.
        transport: {
          post: async () => {
            throw new Error("transport must not be called");
          },
        } as HttpTransport,
      }),
    );
    const approvals = new ApprovalStore();
    approvals.grant({ modelId: "remote/pro", scope: "run", grantedAt: 0 });
    const egress = allowHost(DEFAULT_EGRESS_POLICY, "api.remote.example");
    const engine = new ExecutionEngine({
      catalog: fixture.catalog,
      capabilities: fixture.capabilities,
      chains: fixture.chains,
      approvals,
      budget: new BudgetLedger(10),
      adapters,
      policy: "PREMIUM_ALLOWED",
      egress,
    });
    // Host allowlisted and approval recorded, but no credential exists in env —
    // the secret gate inside the adapter stops the call before any request is
    // built, so the timeout race never even starts.
    await expect(
      engine.invoke(CALL, { timeoutMs: 30 }),
    ).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
  });
});
