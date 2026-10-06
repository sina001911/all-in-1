/**
 * D4 desktop integration tests.
 *
 * The agent loop wired into the desktop stack, driving the deterministic local
 * agent model through the real execution engine and the real tool pipeline.
 * What these prove, end to end:
 *
 *   - a run reaches a model without any host allowlisted or credential read
 *     (the frozen defaults bind: only the local model is reachable);
 *   - a privileged call still waits for the human at the interactive approver;
 *   - the mode determines what the model is even offered;
 *   - the run is resumable, and a continuation steers it.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDesktopStack } from "../src/desktop-stack.ts";
import { DesktopFacade } from "../src/facade.ts";
import { MemoryCredentialProvider } from "../src/credentials/memory-credential-provider.ts";
import type { AgentRequest, ToolCall } from "../../src/agent/index.ts";

let dir: string;
let project: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-d4desk-"));
  project = mkdtempSync(join(tmpdir(), "aio-d4desk-proj-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function stack(): DesktopFacade {
  const s = buildDesktopStack({
    baseDir: dir,
    credentials: new MemoryCredentialProvider(),
  });
  s.settingsStore.patch({ workspaceRoots: [project] });
  return new DesktopFacade(s);
}

/** A prompt that makes the deterministic local model emit these tool calls. */
function withToolCalls(calls: ToolCall[], body = "on it"): string {
  const block = JSON.stringify(calls, null, 2);
  return `${body}\n\n\`\`\`tool-calls\n${block}\n\`\`\``;
}

/** Satisfy every approval the run raises, until it settles. */
async function runApproving(f: DesktopFacade, request: AgentRequest) {
  let settled = false;
  const done = f.runAgent(request).then((r) => {
    settled = true;
    return r;
  });
  void (async () => {
    while (!settled) {
      for (const p of f.listPendingToolApprovals()) f.approveTool(p.id, "test");
      await new Promise((r) => setTimeout(r, 5));
    }
  })();
  return done;
}

describe("agent tools by mode", () => {
  it("INSPECT offers no privileged tool", () => {
    const f = stack();
    const names = f.listAgentTools("INSPECT").map((t) => t.name);
    expect(names).toContain("files.read");
    expect(names.some((n) => n.startsWith("files.write") || n.startsWith("files.edit"))).toBe(false);
    expect(names).not.toContain("process.exec");
  });

  it("BUILD offers the privileged tools, flagged as needing approval", () => {
    const f = stack();
    const byName = new Map(f.listAgentTools("BUILD").map((t) => [t.name, t]));
    expect(byName.get("files.write")?.requiresApproval).toBe(true);
    expect(byName.get("process.exec")?.requiresApproval).toBe(true);
    expect(byName.get("files.read")?.requiresApproval).toBe(false);
  });
});

describe("an agent run on the desktop stack", () => {
  it("reads a file through the real model and the real pipeline", async () => {
    const f = stack();
    writeFileSync(join(project, "a.txt"), "the answer is 42");
    const first = await f.runAgent({
      runId: "desk-1",
      prompt: withToolCalls([{ id: "1", toolName: "files.read", input: { path: join(project, "a.txt") } }], "read the file"),
      mode: "INSPECT",
    });
    expect(first.ok).toBe(true);
    expect(first.pausedForHuman).toBe(true);
    expect(first.outcomes).toHaveLength(1);
    expect(first.outcomes[0]?.ok).toBe(true);
    expect(first.outcomes[0]?.excerpt).toContain("the answer is 42");
  });

  it("continues a run, steered by a new prompt", async () => {
    const f = stack();
    writeFileSync(join(project, "a.txt"), "the answer is 42");
    await f.runAgent({
      runId: "desk-2",
      prompt: withToolCalls([{ id: "1", toolName: "files.read", input: { path: join(project, "a.txt") } }], "read it"),
      mode: "INSPECT",
    });
    const second = await f.runAgent({
      runId: "desk-2",
      prompt: "answer in plain text, call no tools",
      mode: "INSPECT",
    });
    expect(second.turns).toBe(2);
    expect(second.pausedForHuman).toBe(false);
  });

  it("a privileged call waits for the human and is recorded", async () => {
    const f = stack();
    writeFileSync(join(project, "a.txt"), "orig");
    const out = await runApproving(f, {
      runId: "desk-3",
      prompt: withToolCalls(
        [{ id: "1", toolName: "files.write", input: { path: join(project, "a.txt"), content: "clobbered" }, justification: "refreshing" }],
        "rewrite the file",
      ),
      mode: "BUILD",
    });
    expect(out.outcomes[0]?.ok).toBe(true);
    expect(out.outcomes[0]?.approved).toBe(true);
    expect(readFileSync(join(project, "a.txt"), "utf8")).toBe("clobbered");
    // The approval was the interactive approver's — a pending request existed
    // and was answered, never satisfied by the model's own justification.
    const approvals = f.listToolApprovals();
    expect(approvals.filter((a) => a.status === "approved")).toHaveLength(1);
    const audit = f.listToolAudit();
    const rec = audit.find((a) => a.toolName === "files.write" && a.status === "ok");
    expect(rec?.justification).toBe("refreshing");
    expect(rec?.approved).toBe(true);
  });

  it("a denial leaves the file untouched and the run pauses", async () => {
    const f = stack();
    writeFileSync(join(project, "a.txt"), "orig");
    const invocation = f.runAgent({
      runId: "desk-4",
      prompt: withToolCalls(
        [{ id: "1", toolName: "files.write", input: { path: join(project, "a.txt"), content: "no" } }],
        "rewrite it",
      ),
      mode: "BUILD",
    });
    await new Promise((r) => setTimeout(r, 60));
    const [pending] = f.listPendingToolApprovals();
    expect(pending).toBeDefined();
    f.denyTool(pending!.id, "not needed");
    const out = await invocation;
    expect(out.outcomes[0]?.ok).toBe(false);
    expect(out.outcomes[0]?.code).toBe("TOOL_APPROVAL_DENIED");
    expect(readFileSync(join(project, "a.txt"), "utf8")).toBe("orig");
  });

  it("the workspace boundary binds even the agent's own model", async () => {
    const f = stack();
    const outside = mkdtempSync(join(tmpdir(), "aio-d4desk-out-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "secret");
      const out = await f.runAgent({
        runId: "desk-5",
        prompt: withToolCalls([{ id: "1", toolName: "files.read", input: { path: join(outside, "secret.txt") } }], "read it"),
        mode: "INSPECT",
      });
      expect(out.outcomes[0]?.code).toBe("PATH_TRAVERSAL_BLOCKED");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("the frozen defaults leave only the local agent model reachable", () => {
    const s = buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() });
    const ids = s.core.stack.catalog.list().map((m) => m.id).sort();
    expect(ids).toEqual(["local/agent", "local/deterministic", "local/vision"]);
    expect(s.core.stack.egress.kind).toBe("deny-all");
    expect(s.budget.snapshot().budgetUsd).toBe(0);
  });
});
