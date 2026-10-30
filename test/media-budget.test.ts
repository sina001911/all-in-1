/**
 * Media budget gate + generation cap tests (D35).
 *
 * Exercises the router's money and slot enforcement with a FAKE transport —
 * no socket, no credential, no artifact base on disk. The real router code is
 * identical; only the transport and the ledger seams are swapped.
 *
 * The router's `enabled` flag defaults to the frozen `mediaGate.enabled`
 * (false). Every test below passes `enabled: true` explicitly so the budget
 * path is exercisable without touching the frozen gate.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMediaRouter } from "../src/media/router.ts";
import type { HttpTransport, HttpResponse } from "../src/execution/types.ts";
import type { MediaRequest, MediaCapability } from "../src/media/types.ts";
import { ArtifactStore } from "../src/artifacts/store.ts";
import { BudgetLedger } from "../src/registry/budget.ts";

const P1PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function makeProvider(costEstimateUsd?: number) {
  return {
    id: "test",
    displayName: "test",
    endpoint: "http://media.test",
    protocol: "openai-compatible",
    auth: { type: "bearer" as const, apiKeyEnv: "TEST_MEDIA_KEY" },
    capabilities: ["TEXT_TO_IMAGE" as const],
    supportedInputs: ["text", "image"] as const,
    supportedOutputs: ["image"] as const,
    models: [{
      provider: "test",
      modelId: "tiny-img",
      displayName: "tiny",
      modality: "IMAGE" as const,
      inputTypes: ["text"],
      outputTypes: ["image"],
      capabilities: ["TEXT_TO_IMAGE" as const],
      pricing: "unknown" as const,
      costEstimateUsd,
      availability: true,
      priority: 0,
      enabled: true,
    }],
    pricing: "unknown" as const,
    availability: { healthy: true },
  };
}

function fakeTransport(fn: (url: string, body: unknown, headers: Record<string, string>) => Promise<HttpResponse>): HttpTransport {
  return { post: async (url, body, headers) => fn(url, body, headers) };
}

let dir: string;
let artifacts: ArtifactStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-media-bud-"));
  artifacts = new ArtifactStore({ baseDir: dir, retentionDays: 90, keepRuns: 64 });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function req(capability: MediaCapability = "TEXT_TO_IMAGE", extra?: Partial<MediaRequest>): MediaRequest {
  return { capability, prompt: "a cat", ...extra };
}

function routerWithBudget(budget: BudgetLedger, maxGenerations = 0, costEstimateUsd?: number) {
  return buildMediaRouter({
    transport: fakeTransport(async () => ({ status: 200, body: { data: [{ b64_json: P1PNG }] } })),
    artifacts,
    providers: new Map([["test", makeProvider(costEstimateUsd)]]),
    resolveBearer: () => "sk-fake",
    budget,
    maxGenerations,
    enabled: true,
  });
}

describe("media budget gate", () => {
  it("reserves the declared cost before the call and commits it after", async () => {
    const budget = new BudgetLedger(1);
    const r = routerWithBudget(budget, 0, 0.006);
    const result = await r.execute(req(), "run-1");
    expect(result.ok).toBe(true);
    expect(budget.snapshot().spentUsd).toBeCloseTo(0.006, 6);
    expect(budget.spentGenerationsCount).toBe(1);
    expect(result.costUsd).toBe(0.006);
    expect(result.costUnknown).toBe(false);
  });

  it("returns budget_exceeded when the declared cost does not fit", async () => {
    const budget = new BudgetLedger(0.005);
    const r = routerWithBudget(budget, 0, 0.006);
    const result = await r.execute(req(), "run-1");
    expect(result.ok).toBe(false);
    expect(result.warnings![0]).toContain("budget exceeded");
    expect(budget.snapshot().spentUsd).toBe(0);
    expect(budget.spentGenerationsCount).toBe(0);
  });

  it("does not reserve or commit when the cost is unknown", async () => {
    const budget = new BudgetLedger(1);
    const r = routerWithBudget(budget, 0, undefined);
    const result = await r.execute(req(), "run-1");
    expect(result.ok).toBe(true);
    expect(budget.snapshot().spentUsd).toBe(0);
    expect(budget.spentGenerationsCount).toBe(1);
    expect(result.costUnknown).toBe(true);
    expect(result.costUsd).toBeUndefined();
  });

  it("counts a free generation against the generation cap", async () => {
    const budget = new BudgetLedger(1);
    const r = routerWithBudget(budget, 1, 0);
    await r.execute(req(), "run-1");
    const result = await r.execute(req(), "run-2");
    expect(result.ok).toBe(false);
    expect(result.warnings![0]).toContain("generation cap reached");
    expect(budget.spentGenerationsCount).toBe(1);
  });

  it("releases the reservation when the credential is missing", async () => {
    const budget = new BudgetLedger(1);
    const r = buildMediaRouter({
      transport: fakeTransport(async () => { throw new Error("should not have been called"); }),
      artifacts,
      providers: new Map([["test", makeProvider(0.006)]]),
      resolveBearer: () => { throw new Error("TEST_MEDIA_KEY is not set"); },
      budget,
      enabled: true,
    });
    const result = await r.execute(req(), "run-1");
    expect(result.ok).toBe(false);
    expect(result.warnings![0]).toContain("TEST_MEDIA_KEY is not set");
    expect(budget.snapshot().reservedUsd).toBe(0);
    expect(budget.spentGenerationsCount).toBe(0);
  });
});
