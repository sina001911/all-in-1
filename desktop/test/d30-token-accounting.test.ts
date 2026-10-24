/**
 * D30: token counts travel WITH the cost they produced.
 *
 * The confirmed defect: `OpenAICompatibleAdapter` derived `costUsd` from the
 * provider's own usage frame and then THREW THE FRAME AWAY. The token counts
 * that produced a cost never reached `ProviderInvokeResult`, so an accounting
 * seam that read only the stream sink (which a buffered turn never emits)
 * reported a usage record with a cost and "—" for tokens. A buffered agent turn
 * against a real provider was exactly that path: the engine charged the ledger,
 * the usage store recorded the spend, and the tokens were silently absent.
 *
 * What is pinned here:
 *
 *   - the real adapter's BUFFERED path puts the token counts on the result
 *     right beside the `costUsd` they produced;
 *   - BOTH accounting seams — the specialist runner and the agent gateway —
 *     carry those counts for a buffered (non-streaming) turn;
 *   - a usage record written from such a turn carries its cost AND its tokens
 *     together;
 *   - nothing is invented: a provider that reports no usage still yields absent
 *     counts, never zero.
 *
 * The agent-gateway case is the one that was actually broken: before D30 it
 * read only its stream-captured locals, which a buffered turn never sets, so
 * `accounting.promptTokens` was `undefined` even when the settled result
 * carried 200/80.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAICompatibleAdapter } from "../../src/execution/openai-compatible-adapter.ts";
import { SpecialistRunner } from "../../src/specialists/runner.ts";
import { ProviderModelGateway } from "../../src/agent/provider-gateway.ts";
import type { HttpResponse, HttpTransport } from "../../src/execution/types.ts";
import type { InvocationPortal } from "../../src/execution/engine.ts";
import type { SpecialistRequest } from "../../src/specialists/types.ts";
import type { BudgetLedger } from "../../src/registry/budget.ts";
import { buildDesktopStack } from "../src/desktop-stack.ts";
import { DesktopFacade } from "../src/facade.ts";
import { MemoryCredentialProvider } from "../src/credentials/memory-credential-provider.ts";

const KEY_NAME = "AIO_TEST_D30_KEY";

let dir: string;
let project: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-d30-"));
  project = mkdtempSync(join(tmpdir(), "aio-d30-proj-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  delete process.env[KEY_NAME];
});

/**
 * The usage frame a real provider returns in a BUFFERED Chat Completions
 * response. D30's whole point is that these numbers survive past the cost
 * computation.
 */
const REPORTED = { prompt_tokens: 200, completion_tokens: 80 } as const;
/** input $1.00 + output $2.00 per 1M tokens → (200*1 + 80*2)/1e6 */
const EXPECTED_COST = 0.00036;

describe("the real adapter's buffered path carries the tokens with the cost", () => {
  function transport(): HttpTransport {
    return {
      async post(): Promise<HttpResponse> {
        return {
          status: 200,
          body: {
            choices: [{ message: { content: "42" }, finish_reason: "stop" }],
            usage: REPORTED,
          },
        };
      },
    };
  }

  it("reports promptTokens, completionTokens and costUsd together", async () => {
    process.env[KEY_NAME] = "sk-d30";
    const adapter = new OpenAICompatibleAdapter({
      id: "acme",
      displayName: "Acme",
      endpoint: "https://api.acme.test/v1",
      apiKeyEnv: KEY_NAME,
      capabilities: ["CODING"],
      transport: transport(),
      retryBackoffMs: 0,
      pricing: { "gpt-ish": { input: 1, output: 2 } },
    });
    const result = await adapter.invoke({
      model: "acme/gpt-ish",
      capability: "CODING",
      inputs: [{ kind: "text", text: "answer" }],
    });
    expect(result.ok).toBe(true);
    // The cost is non-zero, and the counts that produced it are right beside it.
    expect(result.costUsd).toBe(EXPECTED_COST);
    expect(result.promptTokens).toBe(200);
    expect(result.completionTokens).toBe(80);
  });

  it("without a usage frame there is still nothing invented", async () => {
    process.env[KEY_NAME] = "sk-d30";
    const noUsage: HttpTransport = {
      async post(): Promise<HttpResponse> {
        return { status: 200, body: { choices: [{ message: { content: "42" }, finish_reason: "stop" }] } };
      },
    };
    const adapter = new OpenAICompatibleAdapter({
      id: "acme",
      displayName: "Acme",
      endpoint: "https://api.acme.test/v1",
      apiKeyEnv: KEY_NAME,
      capabilities: ["CODING"],
      transport: noUsage,
      retryBackoffMs: 0,
      pricing: { "gpt-ish": { input: 1, output: 2 } },
    });
    const result = await adapter.invoke({
      model: "acme/gpt-ish",
      capability: "CODING",
      inputs: [{ kind: "text", text: "answer" }],
    });
    expect(result.costUsd).toBe(0);
    // No usage frame reported → absent counts, never zero-invented.
    expect(result.promptTokens).toBeUndefined();
    expect(result.completionTokens).toBeUndefined();
  });
});

/**
 * A stub engine that plays a D30 adapter: the token counts ride on the settled
 * RESULT (never on a stream event), so a buffered turn sees them. It mirrors
 * the real engine's settle phase by committing the cost to the budget ledger.
 */
function bufferedTokenEngine(opts: {
  readonly committedUsd?: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly getBudget?: () => BudgetLedger;
}): InvocationPortal {
  return {
    invoke: async () => {
      const committed = Math.max(0, opts.committedUsd ?? 0.0005);
      opts.getBudget?.().commit(committed);
      return {
        decision: { ok: true, model: { provider: "stub", modelId: "m" }, costEstimateUsd: 0, requiresApproval: false },
        adapterId: "acme",
        result: {
          providerId: "stub",
          modelId: "acme/pro",
          capability: "FAST_TASK",
          ok: true,
          text: "done",
          structured: { findings: [] },
          costUsd: committed,
          latencyMs: 12,
          // D30: the counts are on the result, exactly where the adapter put them.
          promptTokens: opts.promptTokens,
          completionTokens: opts.completionTokens,
        },
        committedUsd: committed,
      } as never;
    },
  };
}

function stubSpecialists(): never {
  return { bySpecialistRole: () => [{ id: "x", defaultOutputSchema: {} }] } as never;
}

function step(role: SpecialistRequest["role"]): SpecialistRequest {
  return { role, prompt: "p", inputs: [{ kind: "text", text: "hi" }], outputSchema: {} };
}

describe("the specialist accounting seam carries result-borne tokens on a buffered turn", () => {
  it("puts promptTokens and completionTokens on the accounting", async () => {
    const runner = new SpecialistRunner({
      engine: bufferedTokenEngine({ committedUsd: 0.0005, promptTokens: 200, completionTokens: 80 }),
      specialists: stubSpecialists(),
    });
    // Note: NOT a streaming request — no usage frame can reach a stream sink.
    const res = await runner.run(step("FAST_TASK"));
    expect(res.ok).toBe(true);
    expect(res.accounting?.committedUsd).toBe(0.0005);
    expect(res.accounting?.promptTokens).toBe(200);
    expect(res.accounting?.completionTokens).toBe(80);
  });

  it("reports absent counts when the provider reported no usage", async () => {
    const runner = new SpecialistRunner({
      engine: bufferedTokenEngine({ committedUsd: 0 }),
      specialists: stubSpecialists(),
    });
    const res = await runner.run(step("FAST_TASK"));
    expect(res.accounting?.committedUsd).toBe(0);
    expect(res.accounting?.promptTokens).toBeUndefined();
    expect(res.accounting?.completionTokens).toBeUndefined();
  });
});

describe("the agent accounting seam carries result-borne tokens on a buffered turn", () => {
  it("puts promptTokens and completionTokens on the turn settlement", async () => {
    const gateway = new ProviderModelGateway({
      engine: bufferedTokenEngine({ committedUsd: 0.0005, promptTokens: 200, completionTokens: 80 }),
    });
    // A buffered agent turn: streaming is NOT requested, so no stream sink is
    // ever installed and no usage frame can be intercepted. Before D30 this
    // returned undefined counts alongside a non-zero cost.
    const turn = await gateway.turn({
      runId: "t1",
      prompt: "hello",
      mode: "INSPECT",
      history: [],
      tools: [],
    });
    expect(turn.ok).toBe(true);
    expect(turn.accounting?.committedUsd).toBe(0.0005);
    expect(turn.accounting?.promptTokens).toBe(200);
    expect(turn.accounting?.completionTokens).toBe(80);
  });

  it("a streamed turn still prefers the result, then the stream frame", async () => {
    // A provider that reports usage ONLY through the stream sink keeps working:
    // the result is absent, so the D27 stream capture supplies the counts.
    let emitted = false;
    const engine: InvocationPortal = {
      invoke: async (_req, options) => {
        emitted = true;
        (options as { onStreamEvent?: (e: unknown) => void } | undefined)?.onStreamEvent?.({
          kind: "usage",
          promptTokens: 90,
          completionTokens: 30,
        });
        return {
          decision: { ok: true, model: { provider: "stub", modelId: "m" }, costEstimateUsd: 0, requiresApproval: false },
          adapterId: "acme",
          result: {
            providerId: "stub",
            modelId: "acme/pro",
            capability: "CODING",
            ok: true,
            text: "done",
            costUsd: 0.0002,
            latencyMs: 9,
          },
          committedUsd: 0.0002,
        } as never;
      },
    };
    const gateway = new ProviderModelGateway({ engine });
    const turn = await gateway.turn({
      runId: "t2",
      prompt: "hello",
      mode: "INSPECT",
      history: [],
      tools: [],
      streaming: true,
    });
    expect(emitted).toBe(true);
    expect(turn.accounting?.promptTokens).toBe(90);
    expect(turn.accounting?.completionTokens).toBe(30);
  });

  it("reports absent counts when the provider reported no usage", async () => {
    const gateway = new ProviderModelGateway({ engine: bufferedTokenEngine({ committedUsd: 0 }) });
    const turn = await gateway.turn({ runId: "t3", prompt: "p", mode: "INSPECT", history: [], tools: [] });
    expect(turn.accounting?.promptTokens).toBeUndefined();
    expect(turn.accounting?.completionTokens).toBeUndefined();
  });
});

describe("an agent run's usage record carries its cost and its tokens together", () => {
  it("records both committedUsd and the token counts for a buffered paid turn", async () => {
    let ledger: BudgetLedger | undefined;
    const s = buildDesktopStack({
      baseDir: dir,
      credentials: new MemoryCredentialProvider(),
      overrides: {
        agentEngine: bufferedTokenEngine({
          committedUsd: 0.0005,
          promptTokens: 200,
          completionTokens: 80,
          getBudget: () => ledger as BudgetLedger,
        }),
      },
    });
    s.settingsStore.patch({ workspaceRoots: [project] });
    ledger = s.budget;
    const f = new DesktopFacade(s);

    const out = await f.runAgent({ runId: "d30-1", prompt: "say hello in plain text, call no tools", mode: "INSPECT" });
    expect(out.ok).toBe(true);
    // The turn carried its tokens all the way through the gateway.
    expect(out.accounting?.[0]).toMatchObject({ committedUsd: 0.0005, promptTokens: 200, completionTokens: 80 });

    const records = f.listUsage().filter((u) => u.runId === "d30-1");
    expect(records).toHaveLength(1);
    // The record shows BOTH the spend and the tokens that produced it — never
    // one without the other.
    expect(records[0]?.costUsd).toBe(0.0005);
    expect(records[0]?.promptTokens).toBe(200);
    expect(records[0]?.completionTokens).toBe(80);

    // The derived ledger agrees, and totals them.
    const summary = f.getRunUsage("d30-1");
    expect(summary?.costUsd).toBe(0.0005);
    expect(summary?.promptTokens).toBe(200);
    expect(summary?.completionTokens).toBe(80);
    expect(f.getUsageTotals().totalCostUsd).toBe(0.0005);
    // What the usage store shows is what the budget ledger was charged.
    expect(s.budget.snapshot().spentUsd).toBe(0.0005);
  });

  it("a genuinely zero-cost, usage-silent turn records no invented tokens", async () => {
    const s = buildDesktopStack({
      baseDir: dir,
      credentials: new MemoryCredentialProvider(),
      overrides: { agentEngine: bufferedTokenEngine({ committedUsd: 0 }) },
    });
    s.settingsStore.patch({ workspaceRoots: [project] });
    const f = new DesktopFacade(s);
    await f.runAgent({ runId: "d30-2", prompt: "say hello in plain text, call no tools", mode: "INSPECT" });
    const records = f.listUsage().filter((u) => u.runId === "d30-2");
    expect(records).toHaveLength(1);
    expect(records[0]?.costUsd).toBe(0);
    expect(records[0]?.promptTokens).toBeUndefined();
    expect(records[0]?.completionTokens).toBeUndefined();
  });
});
