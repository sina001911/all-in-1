/**
 * D15 core streaming path: WorkflowLoop stays the orchestrator, SpecialistRunner
 * forwards the progressively streamed engine events, and the result contract is
 * still the same buffered per-step outcome.
 *
 * Persistence stays out of scope: events travel only through the service input
 * options and never through a store.
 */
import { describe, expect, it } from "vitest";
import { WorkflowLoop } from "../src/workflow/index.ts";
import { SpecialistRunner } from "../src/specialists/runner.ts";
import type { SpecialistRequest } from "../src/specialists/types.ts";
import type { SpecialistResponse } from "../src/specialists/types.ts";
import type { ModelRole } from "../src/registry/roles.ts";
import type { InvocationPortal } from "../src/execution/engine.ts";
import type { StreamEvent } from "../src/execution/types.ts";

/** A controllable runner: claims success while recording the exact options. */
function fakeRunner(
  seen: { request?: SpecialistRequest; options?: unknown },
  response: SpecialistResponse | (() => Promise<SpecialistResponse>) = { ok: true, structured: { summary: "done" } },
): { run: (request: SpecialistRequest, options?: unknown) => Promise<SpecialistResponse> } {
  const run = async (request: SpecialistRequest, options?: unknown): Promise<SpecialistResponse> => {
    seen.request = request;
    seen.options = options;
    return typeof response === "function" ? response() : response;
  };
  return { run };
}

describe("SpecialistRunner streaming forwarding", () => {
  it("forwards onStreamEvent and timeout/signal to the engine without changing the result", async () => {
    let seenRequest: Record<string, unknown> | undefined;
    let seenOptions: Record<string, unknown> | undefined;
    const portal: InvocationPortal = {
      invoke: async (request: unknown, options?: unknown) => {
        seenRequest = request as Record<string, unknown>;
        seenOptions = options as Record<string, unknown>;
        options && (options as { onStreamEvent?: (e: StreamEvent) => void }).onStreamEvent?.({ kind: "text", text: "half" });
        return {
          decision: { ok: true, model: { provider: "local", modelId: "m" }, costEstimateUsd: 0, requiresApproval: false },
          adapterId: "local",
          result: { providerId: "local", modelId: "local/m", capability: "FAST_TASK", ok: true, text: "half", structured: { findings: [] }, costUsd: 0, latencyMs: 1 },
          committedUsd: 0,
        } as never;
      },
    };
    const runner = new SpecialistRunner({ engine: portal, specialists: { bySpecialistRole: () => [{ id: "x", defaultOutputSchema: {} }] } as never });
    const events: StreamEvent[] = [];
    const result = await runner.run(
      { role: "FAST_TASK", prompt: "p", inputs: [{ kind: "text", text: "hi" }], outputSchema: {}, streaming: true },
      { signal: undefined, timeoutMs: 5000, onStreamEvent: (e: StreamEvent) => events.push(e) } as never,
    );
    expect((seenRequest as any).streaming).toBe(true);
    expect(seenOptions?.timeoutMs).toBe(5000);
    expect(seenOptions?.onStreamEvent).toBeDefined();
    expect(events).toEqual([{ kind: "text", text: "half" }]);
    expect(result.ok).toBe(true);
  });
});

describe("WorkflowLoop streaming", () => {
  it("marks streaming steps and forwards the event sink into the runner options", async () => {
    const seen: { request?: SpecialistRequest; options?: Record<string, unknown> } = {};
    const runner = fakeRunner(seen);
    const loop = new WorkflowLoop({
      runner: runner as never,
      request: {
        mode: "INSPECT",
        steps: [{ role: "FAST_TASK", prompt: "p", inputs: [{ kind: "text", text: "x" }], outputSchema: {} }],
        streaming: true,
        timeoutMs: 2500,
        onStreamEvent: (_e) => {},
      },
    }) as unknown as { run: () => Promise<unknown> };
    await loop.run();
    expect(seen.request?.streaming).toBe(true);
    expect(seen.options?.timeoutMs).toBe(2500);
    expect(seen.options?.onStreamEvent).toBeDefined();
  });

  it("non-streaming workflow still omits the event sink", async () => {
    const seen: { request?: SpecialistRequest; options?: Record<string, unknown> } = {};
    const runner = fakeRunner(seen);
    const loop = new WorkflowLoop({
      runner: runner as never,
      request: {
        mode: "INSPECT",
        steps: [{ role: "FAST_TASK", prompt: "p", inputs: [{ kind: "text", text: "x" }], outputSchema: {} }],
      },
    }) as unknown as { run: () => Promise<unknown> };
    await loop.run();
    expect(seen.request?.streaming).not.toBe(true);
    expect(seen.options?.onStreamEvent).toBeUndefined();
  });

  it("forwards timeoutMs and cancels before the first step", async () => {
    const seen: { request?: SpecialistRequest; options?: Record<string, unknown> } = {};
    const runner = fakeRunner(seen);
    const controller = new AbortController();
    const loop = new WorkflowLoop({
      runner: runner as never,
      request: {
        mode: "INSPECT",
        steps: [{ role: "FAST_TASK", prompt: "p", inputs: [{ kind: "text", text: "x" }], outputSchema: {} }],
        streaming: true,
        timeoutMs: 1234,
        signal: controller.signal,
      },
    }) as unknown as { run: () => Promise<unknown> };
    controller.abort();
    const result = (await loop.run()) as { ok: boolean; error?: { code?: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("WORKFLOW_CANCELLED");
  });

  it("concurrent loops each get their own runner invocation without sharing options", async () => {
    const counters: Array<Record<string, unknown>> = [];
    const runner = {
      async run(_request: SpecialistRequest, options?: unknown) {
        counters.push((options ?? {}) as Record<string, unknown>);
        return { ok: true as const, structured: {} };
      },
    };
    const a = new WorkflowLoop({
      runner: runner as never,
      request: { mode: "INSPECT", steps: [{ role: "FAST_TASK", prompt: "a", inputs: [], outputSchema: {} }] },
    }) as unknown as { run: () => Promise<unknown> };
    const b = new WorkflowLoop({
      runner: runner as never,
      request: { mode: "INSPECT", steps: [{ role: "FAST_TASK", prompt: "b", inputs: [], outputSchema: {} }] },
    }) as unknown as { run: () => Promise<unknown> };
    await Promise.all([a.run(), b.run()]);
    expect(counters).toHaveLength(2);
  });
});
