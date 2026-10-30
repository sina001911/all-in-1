/**
 * D29: the diagnostic streaming seam between the D16 bridge and the D18
 * renderer was never connected.
 *
 * The renderer sets `streaming: true` and a stable `runId` when the "stream
 * events" checkbox is on; the facade starts the workflow bridge and keys the
 * resume derivation off that id. Between them, the IPC handler forwarded
 * neither field — so `workflowStreamBridge.start()` never ran, the renderer
 * polled a key that could not exist, and the entire D18 milestone shipped
 * inert. This file pins both ends of the fixed seam, plus the renderer guard
 * that keeps the now-reachable id honest.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamEvent } from "../../src/execution/types.ts";
import type { InvocationPortal } from "../../src/execution/engine.ts";
import { buildDesktopStack, type DesktopStack } from "../src/desktop-stack.ts";
import { DesktopFacade } from "../src/facade.ts";
import { MemoryCredentialProvider } from "../src/credentials/memory-credential-provider.ts";
import { buildDiagnosticRequest } from "../src/ipc-requests.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-d29-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A stub engine that mirrors the real settle phase (committing cost to the
 * ledger) AND emits the frames a streaming caller asked for, so a test can see
 * that the D16 sink chain — loop → runner → engine options → bridge — is
 * actually wired, not just present.
 */
function streamingEngine(opts: { readonly emit?: boolean }): InvocationPortal {
  return {
    invoke: async (request: unknown, options?: { onStreamEvent?: (e: StreamEvent) => void }) => {
      const capability = (request as { capability?: string } | undefined)?.capability ?? "FAST_TASK";
      if (opts.emit) {
        options?.onStreamEvent?.({ kind: "text", text: "frame-1" });
        options?.onStreamEvent?.({ kind: "usage", promptTokens: 12, completionTokens: 7 });
        options?.onStreamEvent?.({ kind: "finish", finishReason: "stop" });
      }
      return {
        decision: { ok: true, model: { provider: "stub", modelId: "m" }, costEstimateUsd: 0, requiresApproval: false },
        adapterId: "acme",
        result: {
          providerId: "stub",
          modelId: "acme/pro",
          capability,
          ok: true,
          text: "done",
          structured: { findings: [] },
          costUsd: 0,
          latencyMs: 5,
        },
        committedUsd: 0,
      } as never;
    },
  };
}

describe("the diagnostic IPC request mapping (D29)", () => {
  it("forwards runId and streaming — the fields the D16-D18 chain needs", () => {
    const req = buildDiagnosticRequest({
      mode: "INSPECT",
      subject: "s",
      streaming: true,
      runId: "diag-abc",
    });
    expect(req.streaming).toBe(true);
    expect(req.runId).toBe("diag-abc");
  });

  it("never defaults streaming on; a non-string runId is dropped, not adopted", () => {
    // Absent streaming is an explicit false, never undefined: the facade
    // treats only `=== true` as opt-in, and the field never carries a third
    // meaning.
    expect(buildDiagnosticRequest({ mode: "SUGGEST", subject: "s" }).streaming).toBe(false);
    // A truthy-but-not-true value must not silently open a progressive channel.
    expect(buildDiagnosticRequest({ mode: "SUGGEST", subject: "s", streaming: "true" }).streaming).toBe(false);
    expect(buildDiagnosticRequest({ mode: "SUGGEST", subject: "s", runId: 42 }).runId).toBeUndefined();
    // An empty string reaches the facade, which generates its own id.
    expect(buildDiagnosticRequest({ mode: "SUGGEST", subject: "s", runId: "" }).runId).toBe("");
  });

  it("validates exactly as the inline handler did", () => {
    expect(() => buildDiagnosticRequest(null)).toThrow(/Invalid diagnostic request/);
    expect(() => buildDiagnosticRequest("nope")).toThrow(/Invalid diagnostic request/);
    expect(() => buildDiagnosticRequest({ mode: "NOPE", subject: "s" })).toThrow(/Invalid mode: NOPE/);
    expect(() => buildDiagnosticRequest({ mode: "INSPECT" })).toThrow(/subject must be a string/);
  });

  it("maps the remaining fields unchanged, including step roles", () => {
    const req = buildDiagnosticRequest({
      mode: "BUILD",
      subject: "s",
      steps: ["FAST_TASK", "CODE_REVIEWER"],
      auto: true,
      plan: false,
      timeoutMs: 12000,
    });
    expect(req.steps).toEqual(["FAST_TASK", "CODE_REVIEWER"]);
    expect(req.auto).toBe(true);
    expect(req.plan).toBe(false);
    expect(req.timeoutMs).toBe(12000);
    // A list containing a non-role is rejected wholesale, not silently trimmed.
    expect(
      buildDiagnosticRequest({ mode: "BUILD", subject: "s", steps: ["FAST_TASK", "BOGUS"] }).steps,
    ).toBeUndefined();
  });
});

describe("the bridge is reachable from the facade (D16/D18)", () => {
  function stack(emit: boolean): DesktopStack {
    return buildDesktopStack({
      baseDir: dir,
      credentials: new MemoryCredentialProvider(),
      overrides: { engine: streamingEngine({ emit }) },
    });
  }

  it("a streaming run leaves a pollable envelope under the caller's runId", async () => {
    const f = new DesktopFacade(stack(true));
    const result = await f.runDiagnostic({
      mode: "INSPECT",
      subject: "s",
      steps: ["FAST_TASK"],
      runId: "diag-live",
      streaming: true,
    });
    expect(result.ok).toBe(true);
    expect(result.runId).toBe("diag-live");

    // The renderer polls exactly this. Before D29 the key never existed.
    const envelope = f.getWorkflowStream("diag-live", 0);
    expect(envelope).toBeDefined();
    expect(envelope?.state).toBe("done");
    expect(envelope?.events.map((e) => e.kind)).toEqual(["text", "usage", "finish"]);
    // Cursor advancement: a second poll from nextIndex sees nothing new.
    const tail = f.getWorkflowStream("diag-live", envelope!.nextIndex);
    expect(tail?.events).toEqual([]);
  });

  it("a non-streaming run leaves no bridge entry — the D18 inert signature", async () => {
    const f = new DesktopFacade(stack(true));
    const result = await f.runDiagnostic({
      mode: "INSPECT",
      subject: "s",
      steps: ["FAST_TASK"],
      runId: "diag-quiet",
    });
    expect(result.ok).toBe(true);
    // The engine would have emitted; nothing was installed to receive it.
    expect(f.getWorkflowStream("diag-quiet", 0)).toBeUndefined();
  });

  it("does not confuse two concurrent streaming runs", async () => {
    const f = new DesktopFacade(stack(true));
    const [a, b] = await Promise.all([
      f.runDiagnostic({ mode: "INSPECT", subject: "a", steps: ["FAST_TASK"], runId: "diag-a", streaming: true }),
      f.runDiagnostic({ mode: "INSPECT", subject: "b", steps: ["FAST_TASK"], runId: "diag-b", streaming: true }),
    ]);
    expect(a.runId).toBe("diag-a");
    expect(b.runId).toBe("diag-b");
    expect(f.getWorkflowStream("diag-a", 0)?.events.map((e) => e.kind)).toEqual(["text", "usage", "finish"]);
    expect(f.getWorkflowStream("diag-b", 0)?.events.map((e) => e.kind)).toEqual(["text", "usage", "finish"]);
  });
});

describe("the renderer keeps a diagnostic id only while the run is resumable", () => {
  const SRC = join(process.cwd(), "desktop", "src");

  it("retains the id for a paused run and releases it once it settles", () => {
    const renderer = readFileSync(join(SRC, "renderer", "renderer.js"), "utf8");
    // The reuse exists to CONTINUE a paused run (D26); a completed run must not
    // lend its id to the next one, or the fresh run lands on a used key and one
    // Runs row silently reports two runs' spend.
    expect(renderer).toContain("diagRunId = result.pausedForHuman ? result.runId : null");
    // A blank id still starts a new run, so the released id is never reused.
    expect(renderer).toContain('request.runId = diagRunId || ("diag-');
  });
});

describe("the Electron handler delegates to the extracted mapping", () => {
  // The mapping is the seam: if the handler is inlined again without
  // forwarding `runId`/`streaming`, the D16 bridge and the D18 progress UI go
  // back to polling a key that cannot exist. Pin the delegation so that
  // regression cannot pass typecheck-looking code review silently.
  it("routes the diagnostic channel through buildDiagnosticRequest", () => {
    const main = readFileSync(join(process.cwd(), "desktop", "src", "main.ts"), "utf8");
    expect(main).toContain("all-in-1:run:diagnostic");
    expect(main).toContain("facade.runDiagnostic(buildDiagnosticRequest(raw))");
    // The inline validation the mapping replaced must not linger as a second,
    // divergent copy of the boundary.
    expect(main).not.toContain("subject must be a string");
  });
});
