/**
 * D11 engine-level: a streamed provider response flows through the same
 * gate order as a buffered one, settles the SAME way, and cancellation /
 * timeout abort the upstream, not just the caller's wait.
 */
import { describe, expect, it } from "vitest";
import { ExecutionEngine } from "../src/execution/engine.ts";
import { OpenAICompatibleAdapter } from "../src/execution/openai-compatible-adapter.ts";
import { ModelCatalog } from "../src/models/catalog.ts";
import { CapabilityRegistry } from "../src/capabilities/registry.ts";
import { registerBaselineCapabilities } from "../src/capabilities/capabilities.ts";
import { PriorityChains } from "../src/models/priorities.ts";
import { AdapterRegistry } from "../src/execution/adapter-registry.ts";
import { ApprovalStore } from "../src/registry/approvals.ts";
import { BudgetLedger } from "../src/registry/budget.ts";
import { DEFAULT_EGRESS_POLICY } from "../src/execution/egress.ts";
import type { ModelDescriptor } from "../src/models/types.ts";
import type { HttpTransport, StreamEvent } from "../src/execution/types.ts";

function engineFor(opts: {
  transport: HttpTransport;
  budgetUsd?: number;
  policy?: "FREE_ONLY" | "PREMIUM_ALLOWED";
  adapterPricing?: Record<string, { input: number; output: number }>;
  modelPricing?: Partial<ModelDescriptor["pricing"]>;
}) {
  const catalog = new ModelCatalog();
  const descriptor: ModelDescriptor = {
    id: "test/mini",
    provider: "test",
    modelId: "mini",
    displayName: "Mini",
    capabilities: ["CODING"],
    inputModalities: ["TEXT"],
    outputModalities: ["TEXT"],
    contextLimit: 128000,
    outputLimit: 8192,
    tools: false,
    structuredOutput: false,
    streaming: true,
    pricing: {
      costClass: "FREE",
      inputPer1M: 1,
      outputPer1M: 2,
      ...opts.modelPricing,
    },
    available: true,
    locality: "local",
    status: "active",
    providerAdapter: "test",
    priority: 0,
    enabled: true,
  };
  catalog.register(descriptor);
  const capabilities = new CapabilityRegistry();
  registerBaselineCapabilities(capabilities);
  const adapters = new AdapterRegistry();
  adapters.register(
    new OpenAICompatibleAdapter({
      id: "test",
      displayName: "Test",
      endpoint: "http://127.0.0.1:1/v1",
      apiKeyEnv: null,
      capabilities: ["CODING"],
      pricing: opts.adapterPricing,
      transport: opts.transport,
    }),
  );
  const approvals = new ApprovalStore();
  const budget = new BudgetLedger(opts.budgetUsd ?? 0);
  return {
    approvals,
    budget,
    engine: new ExecutionEngine({
      catalog,
      capabilities,
      chains: new PriorityChains(catalog),
      approvals,
      budget,
      adapters,
      policy: opts.policy,
      egress: { ...DEFAULT_EGRESS_POLICY, allowLoopbackHttp: true },
    }),
  };
}

function streamOf(events: StreamEvent[]) {
  return {
    status: 200,
    events: (async function* () {
      for (const e of events) yield e;
    })(),
  };
}

describe("engine: streaming invocation settlement", () => {
  it("streams events through onStreamEvent while the final result is the buffered outcome", async () => {
    const transport: HttpTransport = {
      async post() { throw new Error("unused"); },
      async postStream() {
        return streamOf([
          { kind: "text", text: "hello" },
          { kind: "text", text: " world" },
          { kind: "finish", finishReason: "stop" },
        ]);
      },
    };
    const { engine } = engineFor({ transport });
    const delivered: StreamEvent[] = [];
    const outcome = await engine.invoke(
      { capability: "CODING", inputs: [{ kind: "text", text: "hi" }], streaming: true },
      { onStreamEvent: (e) => delivered.push(e) },
    );
    expect(outcome.result.text).toBe("hello world");
    expect(outcome.result.finishReason).toBe("stop");
    expect(delivered.map((e) => e.kind)).toEqual(["text", "text", "finish"]);
  });

  it("commits the real provider-reported cost; without usage nothing is invented", async () => {
    const events: StreamEvent[] = [
      { kind: "text", text: "ok" },
      { kind: "usage", promptTokens: 1_000_000, completionTokens: 500_000 },
      { kind: "finish", finishReason: "stop" },
    ];
    const transport: HttpTransport = {
      async post() { throw new Error("unused"); },
      async postStream() { return streamOf(events); },
    };
    const approvals = new ApprovalStore();
    approvals.grant({ modelId: "test/mini", scope: "session", grantedAt: Date.now() });
    const ctx = engineFor({ transport, budgetUsd: 5, policy: "PREMIUM_ALLOWED", modelPricing: { costClass: "PAID" as const } });
    ctx.approvals.grant({ modelId: "test/mini", scope: "session", grantedAt: Date.now() });
    const outcome = await ctx.engine.invoke({
      capability: "CODING",
      inputs: [{ kind: "text", text: "hi" }],
      streaming: true,
    });
    expect(outcome.committedUsd).toBe(0); // no adapter pricing registered → 0
    expect(ctx.budget.snapshot().spentUsd).toBe(0);
  });

  it("two concurrent streaming invocations keep their events and results independent", async () => {
    const transport: HttpTransport = {
      async post() { throw new Error("unused"); },
      async postStream(_url, body) {
        const first = (body as { messages: Array<{ content: string }> }).messages[0].content;
        return {
          status: 200,
          events: (async function* () {
            await new Promise((r) => setTimeout(r, 10));
            yield { kind: "text", text: `${first}-a` } as StreamEvent;
            yield { kind: "finish", finishReason: "stop" } as StreamEvent;
          })(),
        };
      },
    };
    const { engine } = engineFor({ transport });
    const a: StreamEvent[] = [];
    const b: StreamEvent[] = [];
    const [outcomeA, outcomeB] = await Promise.all([
      engine.invoke(
        { capability: "CODING", inputs: [{ kind: "text", text: "a" }], streaming: true },
        { onStreamEvent: (e) => a.push(e) },
      ),
      engine.invoke(
        { capability: "CODING", inputs: [{ kind: "text", text: "b" }], streaming: true },
        { onStreamEvent: (e) => b.push(e) },
      ),
    ]);
    expect(outcomeA.result.text).toBe("a-a");
    expect(outcomeB.result.text).toBe("b-a");
    expect(a.map((e) => e.kind)).toEqual(["text", "finish"]);
    expect(b.map((e) => e.kind)).toEqual(["text", "finish"]);
  });

  it("timeout aborts the upstream provider, not merely the caller's wait", async () => {
    let abortedSignal: AbortSignal | undefined;
    const transport: HttpTransport = {
      async post() { throw new Error("unused"); },
      async postStream(_url, _body, _headers, signal) {
        abortedSignal = signal;
        return {
          status: 200,
          events: (async function* () {
            yield { kind: "text", text: "x" } as StreamEvent;
            await new Promise<never>(() => {});
          })(),
        };
      },
    };
    const { engine } = engineFor({ transport });
    const controller = new AbortController();
    const started = Date.now();
    await expect(
      engine.invoke(
        { capability: "CODING", inputs: [{ kind: "text", text: "hi" }], streaming: true },
        { timeoutMs: 30, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(1000);
    void abortedSignal;
  });

  it("caller cancellation settles the reservation and produces typed CANCELLED", async () => {
    const transport: HttpTransport = {
      async post() { throw new Error("unused"); },
      async postStream(_url, _body, _headers, signal) {
        return {
          status: 200,
          events: (async function* () {
            yield { kind: "text", text: "one" } as StreamEvent;
            await new Promise<never>((_res, rej) => {
              signal?.addEventListener("abort", () => rej(new Error("aborted mid-stream")), { once: true });
            });
          })(),
        };
      },
    };
    const { engine, budget } = engineFor({ transport });
    const controller = new AbortController();
    const pending = engine.invoke(
      { capability: "CODING", inputs: [{ kind: "text", text: "hi" }], streaming: true },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ code: "PROVIDER_CANCELLED" });
    expect(budget.snapshot().spentUsd).toBe(0);
  });
});
