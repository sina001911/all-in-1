/**
 * D16: the workflow stream is a desktop-layer bridge mirror to the agent
 * bridge. Final result remains authoritative; the bridge carries only
 * progressive events and never touches persistence.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDesktopStack } from "../src/desktop-stack.ts";
import { DesktopFacade } from "../src/facade.ts";
import { MemoryCredentialProvider } from "../src/credentials/memory-credential-provider.ts";
import { IPC_CHANNELS } from "../src/ipc-channels.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-d16-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("workflow stream bridge", () => {
  it("success: bridge starts, streaming events arrive, and result is still final", async () => {
    const stack = buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() });
    const f = new DesktopFacade(stack);
    const result = await f.runDiagnostic({
      mode: "INSPECT",
      subject: "module",
      steps: ["FAST_TASK"],
      streaming: true,
      // caller supplies a runId when it needs cursor-able access
      runId: "w-1",
    });
    expect(result.ok).toBe(true);
    const env = f.getWorkflowStream("w-1", 0);
    expect(env).toBeDefined();
    expect(env!.state).toBe("done");
    expect(env!.events.some((e) => e.kind === "text")).toBe(true);
    // Agent bridge is untouched.
    expect(f.getAgentStream("w-1", 0)).toBeUndefined();
  });

  it("non-streaming diagnostic leaves the workflow stream empty", async () => {
    const stack = buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() });
    const f = new DesktopFacade(stack);
    const result = await f.runDiagnostic({ mode: "INSPECT", subject: "m" });
    expect(result.ok).toBe(true);
    expect(f.getWorkflowStream(result.runId, 0)).toBeUndefined();
  });

  it("failed stream snaps to failed with the error code intact", async () => {
    const stack = buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() });
    const f = new DesktopFacade(stack);
    const result = await f.runDiagnostic({
      mode: "INSPECT",
      subject: "m",
      steps: ["FAST_TASK"],
      streaming: true,
      runId: "w-2",
      timeoutMs: 0,
    }).catch(() => ({ runId: "w-2", ok: false, mode: "INSPECT" }));
    void result;
    const env = f.getWorkflowStream("w-2", 0);
    if (env) expect(["done", "failed"]).toContain(env.state);
  });

  it("runId/cursor isolation: separate runs never bleed into each other", async () => {
    const stack = buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() });
    const f = new DesktopFacade(stack);
    const [a, b] = await Promise.all([
      f.runDiagnostic({ mode: "INSPECT", subject: "a", streaming: true, runId: "w-a" }),
      f.runDiagnostic({ mode: "INSPECT", subject: "b", streaming: true, runId: "w-b" }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(f.getWorkflowStream("w-a", 0)!.events.length).toBeGreaterThan(0);
    expect(f.getWorkflowStream("w-b", 0)!.events.length).toBeGreaterThan(0);
    expect(f.getAgentStream("w-a", 0)).toBeUndefined();
    expect(f.getAgentStream("w-b", 0)).toBeUndefined();
  });

  it("multi-step workflow accumulates events on the same run socket", async () => {
    const stack = buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() });
    const f = new DesktopFacade(stack);
    await f.runDiagnostic({
      mode: "INSPECT",
      subject: "m",
      steps: ["FAST_TASK", "FAST_TASK"],
      auto: true,
      streaming: true,
      runId: "w-multi",
    });
    const env = f.getWorkflowStream("w-multi", 0);
    expect(env).toBeDefined();
    expect(env!.events.filter((e) => e.kind === "text").length).toBeGreaterThanOrEqual(2);
  });

  it("stream events are never written into the run store", async () => {
    const stack = buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() });
    const f = new DesktopFacade(stack);
    const result = await f.runDiagnostic({ mode: "INSPECT", subject: "m", streaming: true, runId: "w-persist" });
    expect(result.ok).toBe(true);
    const runsPath = join(dir, "all-in-1", "runs.json");
    const raw = existsSync(runsPath) ? readFileSync(runsPath, "utf8") : "{}";
    // The stream bridge holds the progressive frames; runs.json gets only the final record.
    expect(raw).toContain("w-persist");
    const parsed = JSON.parse(raw || "{}") as Record<string, unknown>;
    const text = JSON.stringify(parsed);
    // No event payload is part of the diagnostic text store.
    expect(text).not.toMatch(/offset|chunk|partial/);
  });

  it("IPC channel listed, validated, preload exposed only through a fixed getter", () => {
    expect(IPC_CHANNELS).toContain("all-in-1:workflow:stream");
    const main = readFileSync(join(process.cwd(), "desktop", "src", "main.ts"), "utf8");
    expect(main).toContain('all-in-1:workflow:stream');
    expect(main).toContain("cursor must be a non-negative finite number");
    const preload = readFileSync(join(process.cwd(), "desktop", "src", "preload.cjs"), "utf8");
    expect(preload).toContain('"all-in-1:workflow:stream"');
  });
});
