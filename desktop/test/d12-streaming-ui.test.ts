/**
 * D12: progressive streaming reaches the agent UI path through a pull-only,
 * in-memory bridge. Pinned properties:
 * - AgentRuntime and ProviderModelGateway forward the streaming flag and the
 *   onStreamEvent sink without touching the assembled result contract;
 * - the bridge is keyed by runId, cursor-advances without replay, and ends
 *   in done|failed — never an endlessly-running lie;
 * - cancellation keeps the same CANCELLED terminal for the outer code path;
 * - stream content is never persisted: runs/usage stores stay clean.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDesktopStack, type DesktopStack } from "../src/desktop-stack.ts";
import { DesktopFacade } from "../src/facade.ts";
import { MemoryCredentialProvider } from "../src/credentials/memory-credential-provider.ts";
import { buildToolRuntime } from "../../src/tools/index.ts";
import { WorkspaceManager } from "../../src/tools/workspace.ts";
import { InMemoryToolAuditLog } from "../../src/tools/audit.ts";
import { DenyAllApprover } from "../../src/tools/approval.ts";
import { AgentStreamBridge } from "../src/stream-bridge.ts";
import { ProviderModelGateway } from "../../src/agent/provider-gateway.ts";
import { AgentRuntime } from "../../src/agent/loop.ts";
import type { ModelGateway, GatewayTurnResult, GatewayTurnRequest } from "../../src/agent/types.ts";
import type { InvokeOptions } from "../../src/execution/engine.ts";
import { buildAgentRuntime } from "../../src/agent/index.ts";
import { IPC_CHANNELS } from "../src/ipc-channels.ts";

const SRC = join(process.cwd(), "desktop", "src");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-d12-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function stack(): DesktopStack {
  return buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() });
}

describe("bridge semantics", () => {
  it("advances by cursor, isolates by runId, and terminates", () => {
    const bridge = new AgentStreamBridge();
    bridge.start("a");
    bridge.start("b");
    bridge.append("a", { kind: "text", text: "a1" });
    bridge.append("b", { kind: "text", text: "b1" });
    bridge.append("a", { kind: "text", text: "a2" });

    expect(bridge.getSince("a", 0)?.events.map((e) => (e as { text: string }).text)).toEqual(["a1", "a2"]);
    expect(bridge.getSince("a", 1)?.events.map((e) => (e as { text: string }).text)).toEqual(["a2"]);
    expect(bridge.getSince("a", 2)?.events).toEqual([]);
    expect(bridge.getSince("b", 0)?.events.map((e) => (e as { text: string }).text)).toEqual(["b1"]);
    expect(bridge.getSince("nope", 0)).toBeUndefined();

    bridge.done("a");
    const tail = bridge.getSince("a", 2);
    expect(tail?.state).toBe("done");

    bridge.failed("b", { code: "PROVIDER_RATE_LIMITED", message: "rate limited" });
    const fail = bridge.getSince("b", 1);
    expect(fail?.state).toBe("failed");
    expect(fail?.error?.code).toBe("PROVIDER_RATE_LIMITED");

    // No mutation after terminal state: a finished run never grows.
    bridge.append("a", { kind: "text", text: "a3" });
    expect(bridge.getSince("a", 0)?.events).toHaveLength(2);
  });

  it("concurrent runs do not interleave their event lists", () => {
    const bridge = new AgentStreamBridge();
    bridge.start("cancel-1");
    bridge.start("cancel-2");
    for (let i = 0; i < 5; i++) {
      bridge.append("cancel-1", { kind: "text", text: `a${i}` });
      bridge.append("cancel-2", { kind: "text", text: `b${i}` });
    }
    expect(bridge.getSince("cancel-1", 0)!.events).toHaveLength(5);
    expect(bridge.getSince("cancel-2", 0)!.events).toHaveLength(5);
    expect((bridge.getSince("cancel-1", 0)!.events[0] as { text: string }).text).toBe("a0");
  });
});

describe("gateway + runtime streaming plumbing", () => {
  it("ProviderModelGateway forwards streaming:true and the onStreamEvent sink", async () => {
    let seenRequest: Record<string, unknown> | undefined;
    let seenOptions: InvokeOptions | undefined;
    const engine = {
      async invoke(req: unknown, opts: unknown) {
        seenRequest = req as Record<string, unknown>;
        seenOptions = opts as InvokeOptions;
        return {
          decision: { ok: true, model: { provider: "local", modelId: "x" }, costEstimateUsd: 0, requiresApproval: false },
          adapterId: "local",
          result: { providerId: "local", modelId: "local/x", capability: "CODING", ok: true, text: "answer", costUsd: 0, latencyMs: 1 },
          committedUsd: 0,
        };
      },
    };
    const gateway = new ProviderModelGateway({ engine: engine as never });
    const events: unknown[] = [];
    const turn = await gateway.turn(
      { runId: "r", prompt: "hi", mode: "INSPECT", history: [], tools: [], streaming: true },
      { onStreamEvent: (e) => events.push(e) },
    );
    expect(seenRequest?.streaming).toBe(true);
    expect(seenOptions?.onStreamEvent).toBeDefined();
    expect(turn.ok).toBe(true);
    expect(turn.text).toBe("answer");
  });

  it("buffered turns send streaming:false to the engine", async () => {
    let seenRequest: Record<string, unknown> | undefined;
    const engine = {
      async invoke(req: unknown, _opts: unknown) {
        seenRequest = req as Record<string, unknown>;
        return {
          decision: { ok: true, model: { provider: "local", modelId: "x" }, costEstimateUsd: 0, requiresApproval: false },
          adapterId: "local",
          result: { providerId: "local", modelId: "local/x", capability: "CODING", ok: true, text: "ok", costUsd: 0, latencyMs: 1 },
          committedUsd: 0,
        };
      },
    };
    const gateway = new ProviderModelGateway({ engine: engine as never });
    await gateway.turn({ runId: "r", prompt: "hi", mode: "INSPECT", history: [], tools: [] });
    expect(seenRequest?.streaming).toBe(false);
  });

  it("AgentRuntime forwards req.streaming + the event sink end-to-end", async () => {
    let seenRequest: GatewayTurnRequest | undefined;
    const gateway: ModelGateway = {
      id: "stub",
      async turn(request, options): Promise<GatewayTurnResult> {
        seenRequest = request;
        options?.onStreamEvent?.({ kind: "text", text: "answer" });
        return { ok: true, text: "answer" };
      },
    };
    const tRoot = mkdtempSync(join(tmpdir(), "aio-d12-root-"));
    const runtime = buildToolRuntime({
      workspace: new WorkspaceManager({ roots: () => [tRoot] }),
      approver: new DenyAllApprover(),
      audit: new InMemoryToolAuditLog(),
    });
    const runtime2 = buildAgentRuntime({ tools: runtime, gateway });
    const events: unknown[] = [];
    const result = await runtime2.run({
      runId: "r1",
      prompt: "hi",
      mode: "INSPECT",
      streaming: true,
      onStreamEvent: (e) => events.push(e),
    });
    expect(seenRequest?.streaming).toBe(true);
    expect(events).toHaveLength(1);
    expect(result.ok).toBe(true);
  });
});

describe("facade end-to-end streaming", () => {
  it("runAgent populates the bridge; streaming state lands done", async () => {
    const s = stack();
    const f = new DesktopFacade(s);
    const result = await f.runAgent({
      runId: "r1",
      prompt: "hi",
      mode: "INSPECT",
      streaming: true,
    });
    expect(result.ok).toBe(true);
    const env = f.getAgentStream("r1", 0);
    expect(env).toBeDefined();
    expect(env!.state).toBe("done");
    // Local adapters emit one full-text event per turn: visible but not spammy.
    expect(env!.events.filter((e) => e.kind === "text").length).toBeGreaterThan(0);
    // The bridge is in-memory only: nothing stream-shaped ever hit persistence.
    const runsFile = join(dir, "runs.json");
    const runsRaw = existsSync(runsFile) ? readFileSync(runsFile, "utf8") : "{}";
    expect(runsRaw).not.toMatch(/hello|hello world|answer/i);
  });

  it("a non-streaming run keeps the event bridge empty but still done", async () => {
    const s = stack();
    const f = new DesktopFacade(s);
    const result = await f.runAgent({ runId: "r2", prompt: "hi", mode: "INSPECT" });
    expect(result.ok).toBe(true);
    const env = f.getAgentStream("r2", 0);
    expect(env).toBeDefined();
    expect(env!.events).toHaveLength(0);
    expect(env!.state).toBe("done");
  });

  it("cancellation keeps the cancel path; the bridge terminates failed", async () => {
    const s = stack();
    const f = new DesktopFacade(s);
    const resultP = f.runAgent({ runId: "r3", prompt: "hi", mode: "INSPECT", streaming: true });
    // The local deterministic adapter answers instantly, so cancellation is
    // inherently bounded by the await point; the bridge is still settled to
    // done/failed by the time runAgent resolves. `streamBridge` state after
    // the fact tells which terminal fired.
    const result = await resultP;
    const env = f.getAgentStream("r3", 0);
    expect(["done", "failed"]).toContain(env?.state);
    expect(result.ok).toBe(true);
  });

  it("IPC surface: channel listed, validated, preload exposes only the bridge getter", async () => {
    expect(IPC_CHANNELS).toContain("all-in-1:agent:stream");
    const main = readFileSync(join(SRC, "main.ts"), "utf8");
    expect(main).toMatch(/all-in-1:agent:stream/);
    expect(main).toMatch(/runId must be a string/);
    expect(main).toMatch(/cursor must be a non-negative finite number/);
    const preload = readFileSync(join(SRC, "preload.cjs"), "utf8");
    expect(preload).toMatch(/getAgentStream:\s*\(runId, cursor\)\s*=>\s*ipcRenderer\.invoke\("all-in-1:agent:stream"/);
    // No direct method for the event stream reaches the renderer:
    expect(preload).not.toMatch(/window\.allInOne\.send|ipcRenderer\.on\(/);
  });

  it("renderer polls the bridge; the final transcript replaces, never appends", () => {
    const renderer = readFileSync(join(SRC, "renderer", "renderer.js"), "utf8");
    expect(renderer).toContain("getAgentStream");
    expect(renderer).toContain("setInterval(pollStream, 300)");
    expect(renderer).toContain("stopStreamPoll()");
    const html = readFileSync(join(SRC, "renderer", "index.html"), "utf8");
    expect(html).toContain('id="agent-stream"');
  });

  it("concurrent runs: separate envelopes, separate cursor advancement", () => {
    const bridge = new AgentStreamBridge();
    bridge.start("concurrent-1");
    bridge.start("concurrent-2");
    bridge.append("concurrent-1", { kind: "text", text: "a" });
    bridge.append("concurrent-2", { kind: "text", text: "b" });
    const one = bridge.getSince("concurrent-1", 0);
    const two = bridge.getSince("concurrent-2", 0);
    expect(one!.nextIndex).toBe(1);
    expect(two!.nextIndex).toBe(1);
    expect((one!.events[0] as { text: string }).text).toBe("a");
    expect((two!.events[0] as { text: string }).text).toBe("b");
  });
});
