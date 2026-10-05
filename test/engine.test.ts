/**
 * Execution engine suite (P4): the first real call path.
 *
 * The gate ORDER is a security property, so it is pinned by tests:
 *
 *   SELECT -> VALIDATE -> APPROVAL -> EGRESS -> SECRET -> RESERVE -> INVOKE
 *                     -> SETTLE (commit on success, release on failure)
 *
 * In particular a credential must never be read for a destination that egress
 * refuses, and an unapproved paid model must stop before any reservation.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ExecutionEngine } from "../src/execution/engine.ts";
import { LocalAdapter } from "../src/execution/local-adapter.ts";
import { AdapterRegistry } from "../src/execution/adapter-registry.ts";
import { DEFAULT_EGRESS_POLICY, allowHost } from "../src/execution/egress.ts";
import { buildCatalogFixture } from "../src/execution/test-fixtures.ts";
import { ApprovalStore } from "../src/registry/approvals.ts";
import { BudgetLedger } from "../src/registry/budget.ts";
import { BaseProviderAdapter, type ProviderInvokeRequest } from "../src/providers/types.ts";
import type { ProviderInvokeResult } from "../src/execution/types.ts";
import { AllInOneError } from "../src/errors.ts";

const KEY_NAME = "AIO_TEST_ENGINE_KEY";
const REMOTE_HOST = "api.example-vendor.com";

afterEach(() => {
  delete process.env[KEY_NAME];
});

/** A remote adapter with an https endpoint, used to prove egress ordering. */
class RemoteAdapter extends BaseProviderAdapter {
  keyWasRead = false;
  constructor(endpoint = `https://${REMOTE_HOST}/v1`) {
    super({
      id: "remote",
      displayName: "Remote",
      protocol: "openai-compatible",
      locality: "remote",
      apiKeyEnv: KEY_NAME,
      endpoint,
      capabilities: ["CODING"],
    });
  }
  override async invoke(request: ProviderInvokeRequest): Promise<ProviderInvokeResult> {
    this.keyWasRead = true;
    return {
      providerId: this.id,
      modelId: request.model,
      capability: request.capability,
      ok: true,
      text: "reached",
      costUsd: 0,
      latencyMs: 0,
    };
  }
}

/** An adapter that always fails, to test budget release on failure. */
class FailingAdapter extends BaseProviderAdapter {
  constructor() {
    super({
      id: "local",
      displayName: "Local",
      protocol: "local",
      locality: "local",
      apiKeyEnv: null,
      endpoint: null,
      capabilities: ["CODING"],
      availableWithoutCredentials: true,
    });
  }
  override async invoke(): Promise<ProviderInvokeResult> {
    throw new AllInOneError("boom", "PROVIDER_CALL_FAILED", "unavailable", {
      retryable: false,
    });
  }
}

/** An adapter that reports a real cost, to test settlement. */
class PricedAdapter extends BaseProviderAdapter {
  constructor() {
    super({
      id: "local",
      displayName: "Local",
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

function engineFor(
  models: Parameters<typeof buildCatalogFixture>[0],
  opts: {
    adapters?: AdapterRegistry;
    approvals?: ApprovalStore;
    budget?: BudgetLedger;
    policy?: "FREE_ONLY" | "PREMIUM_ALLOWED";
    egress?: typeof DEFAULT_EGRESS_POLICY;
  } = {},
) {
  const fixture = buildCatalogFixture(models);
  const adapters = opts.adapters ?? new AdapterRegistry();
  if (!opts.adapters) adapters.register(new LocalAdapter());
  return new ExecutionEngine({
    catalog: fixture.catalog,
    capabilities: fixture.capabilities,
    chains: fixture.chains,
    approvals: opts.approvals ?? new ApprovalStore(),
    budget: opts.budget ?? new BudgetLedger(0),
    adapters,
    policy: opts.policy,
    egress: opts.egress ?? DEFAULT_EGRESS_POLICY,
  });
}

const LOCAL_FREE = {
  id: "local/deterministic",
  capabilities: ["CODING"],
  costClass: "FREE" as const,
  providerAdapter: "local",
};

describe("execution engine: happy path", () => {
  it("executes a free local model end to end", async () => {
    const engine = engineFor([LOCAL_FREE]);
    const outcome = await engine.invoke({
      capability: "CODING",
      inputs: [{ kind: "text", text: "hello world" }],
    });
    expect(outcome.decision.ok).toBe(true);
    expect(outcome.decision.model).toEqual({ provider: "local", modelId: "deterministic" });
    expect(outcome.adapterId).toBe("local");
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.text).toContain("hello world");
    expect(outcome.committedUsd).toBe(0);
  });

  it("forwards structured-output requests", async () => {
    const engine = engineFor([LOCAL_FREE]);
    const outcome = await engine.invoke({
      capability: "CODING",
      structuredOutput: true,
      inputs: [{ kind: "text", text: "summarize" }],
    });
    expect(outcome.result.structured).toBeDefined();
  });

  it("is deterministic for identical input", async () => {
    const engine = engineFor([LOCAL_FREE]);
    const a = await engine.invoke({
      capability: "CODING",
      inputs: [{ kind: "text", text: "same" }],
    });
    const b = await engine.invoke({
      capability: "CODING",
      inputs: [{ kind: "text", text: "same" }],
    });
    expect(b.result.text).toBe(a.result.text);
  });

  it("accepts image artifact inputs (not decoded by the local adapter)", async () => {
    const engine = engineFor([LOCAL_FREE]);
    const outcome = await engine.invoke({
      capability: "CODING",
      inputs: [
        { kind: "text", text: "describe" },
        { kind: "image", artifactId: "shot-001" },
      ],
    });
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.text).toContain("image-inputs: 1");
  });
});

describe("execution engine: selection failure", () => {
  it("throws SELECTION_FAILED when no candidate exists", async () => {
    const engine = engineFor([LOCAL_FREE]);
    await expect(
      engine.invoke({ capability: "EMBEDDING", inputs: [{ kind: "text", text: "x" }] }),
    ).rejects.toMatchObject({ code: "SELECTION_FAILED", category: "config" });
  });

  it("throws PROVIDER_UNAVAILABLE when the model's adapter is not registered", async () => {
    const engine = engineFor([
      {
        id: "local/ghost",
        capabilities: ["CODING"],
        costClass: "FREE" as const,
        providerAdapter: "not-registered",
      },
    ]);
    await expect(
      engine.invoke({ capability: "CODING", inputs: [{ kind: "text", text: "x" }] }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});

describe("execution engine: egress gate precedes the secret", () => {
  it("blocks an unallowlisted remote endpoint with EGRESS_BLOCKED, before reading the key", async () => {
    const adapters = new AdapterRegistry();
    const remote = new RemoteAdapter();
    adapters.register(remote);
    const engine = engineFor(
      [
        {
          id: "remote/anything",
          capabilities: ["CODING"],
          costClass: "FREE" as const,
          providerAdapter: "remote",
        },
      ],
      { adapters },
    );
    await expect(
      engine.invoke({ capability: "CODING", inputs: [{ kind: "text", text: "x" }] }),
    ).rejects.toMatchObject({
      code: "EGRESS_BLOCKED",
      category: "security",
      host: REMOTE_HOST,
    });
    expect(remote.keyWasRead).toBe(false);
  });

  it("blocks an allowlisted host when the scheme is plain http", async () => {
    const adapters = new AdapterRegistry();
    const remote = new RemoteAdapter(`http://${REMOTE_HOST}/v1`);
    adapters.register(remote);
    const engine = engineFor(
      [
        {
          id: "remote/anything",
          capabilities: ["CODING"],
          costClass: "FREE" as const,
          providerAdapter: "remote",
        },
      ],
      {
        adapters,
        egress: allowHost(DEFAULT_EGRESS_POLICY, REMOTE_HOST),
      },
    );
    await expect(
      engine.invoke({ capability: "CODING", inputs: [{ kind: "text", text: "x" }] }),
    ).rejects.toMatchObject({ code: "EGRESS_BLOCKED", category: "security" });
    expect(remote.keyWasRead).toBe(false);
  });
});

describe("execution engine: approval gate", () => {
  const LOCAL_PAID = {
    id: "local/pro",
    capabilities: ["CODING"],
    costClass: "PAID" as const,
    inputPer1M: 1,
    providerAdapter: "local",
  };

  it("blocks an unapproved paid model with APPROVAL_REQUIRED", async () => {
    const engine = engineFor([LOCAL_PAID], { policy: "PREMIUM_ALLOWED" });
    await expect(
      engine.invoke({ capability: "CODING", inputs: [{ kind: "text", text: "x" }] }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED", category: "config" });
  });

  it("proceeds when an approval is recorded", async () => {
    const approvals = new ApprovalStore();
    approvals.grant({ modelId: "local/pro", scope: "run", grantedAt: 0 });
    const engine = engineFor([LOCAL_PAID], {
      policy: "PREMIUM_ALLOWED",
      approvals,
      budget: new BudgetLedger(10),
    });
    const outcome = await engine.invoke({
      capability: "CODING",
      inputs: [{ kind: "text", text: "x" }],
    });
    expect(outcome.decision.requiresApproval).toBe(false);
    expect(outcome.result.ok).toBe(true);
  });
});

describe("execution engine: budget settlement", () => {
  const LOCAL_PAID = {
    id: "local/pro",
    capabilities: ["CODING"],
    costClass: "PAID" as const,
    inputPer1M: 1,
    providerAdapter: "local",
  };

  it("refuses a paid call when the budget is zero", async () => {
    const approvals = new ApprovalStore();
    approvals.grant({ modelId: "local/pro", scope: "run", grantedAt: 0 });
    const engine = engineFor([LOCAL_PAID], {
      policy: "PREMIUM_ALLOWED",
      approvals,
      budget: new BudgetLedger(0),
    });
    await expect(
      engine.invoke({ capability: "CODING", inputs: [{ kind: "text", text: "x" }] }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  it("releases the reservation when the adapter throws", async () => {
    const adapters = new AdapterRegistry();
    adapters.register(new FailingAdapter());
    const budget = new BudgetLedger(10);
    const engine = engineFor([LOCAL_FREE], { adapters, budget });
    await expect(
      engine.invoke({ capability: "CODING", inputs: [{ kind: "text", text: "x" }] }),
    ).rejects.toMatchObject({ code: "PROVIDER_CALL_FAILED" });
    expect(budget.snapshot().reservedUsd).toBe(0);
    expect(budget.snapshot().spentUsd).toBe(0);
  });

  it("commits the actual cost reported by the adapter and releases the rest", async () => {
    const adapters = new AdapterRegistry();
    adapters.register(new PricedAdapter());
    const budget = new BudgetLedger(10);
    const engine = engineFor([LOCAL_FREE], { adapters, budget });
    const outcome = await engine.invoke({
      capability: "CODING",
      inputs: [{ kind: "text", text: "x" }],
    });
    expect(outcome.committedUsd).toBe(0.5);
    expect(budget.snapshot().spentUsd).toBeCloseTo(0.5);
    expect(budget.snapshot().reservedUsd).toBe(0);
  });
});

describe("execution engine: allowlisted remote egress", () => {
  it("permits an allowlisted https host and reads the key only then", async () => {
    const adapters = new AdapterRegistry();
    const remote = new RemoteAdapter();
    adapters.register(remote);
    process.env[KEY_NAME] = "sk-test";
    const engine = engineFor(
      [
        {
          id: "remote/anything",
          capabilities: ["CODING"],
          costClass: "FREE" as const,
          providerAdapter: "remote",
        },
      ],
      {
        adapters,
        budget: new BudgetLedger(1),
        egress: allowHost(DEFAULT_EGRESS_POLICY, REMOTE_HOST),
      },
    );
    const outcome = await engine.invoke({
      capability: "CODING",
      inputs: [{ kind: "text", text: "x" }],
    });
    expect(outcome.result.ok).toBe(true);
    expect(remote.keyWasRead).toBe(true);
  });
});
