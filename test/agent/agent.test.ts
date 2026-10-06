/**
 * Agent runtime tests (D3).
 *
 * What these prove, in order of importance:
 *
 *   1. The model cannot approve its own tool request. The loop holds no
 *      approver; a privileged call is settled by the approver the executor was
 *      built with, and by nothing the model supplies.
 *   2. The model only ever sees the tools the safety mode permits. In INSPECT
 *      it is never offered a write tool, so it cannot even ask for one.
 *   3. A tool call is a request: the executor's full pipeline (validation,
 *      boundary, mode, approval, audit) applies to every call, and a denied
 *      call is reported back rather than silently skipped or retried.
 *   4. The bounds hold: the turn ceiling, the edit cap, dry-run-first, and the
 *      pause-without-`--auto` rule.
 *   5. Cancellation releases a pending approval and stops the loop.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildToolRuntime } from "../../src/tools/index.ts";
import { WorkspaceManager } from "../../src/tools/workspace.ts";
import { InMemoryToolAuditLog } from "../../src/tools/audit.ts";
import { DenyAllApprover, AllowAllApprover, type ToolApprovalRequest } from "../../src/tools/approval.ts";
import { buildAgentRuntime } from "../../src/agent/index.ts";
import { ScriptedModelGateway, type ScriptedTurn } from "../../src/agent/scripted-gateway.ts";
import type { ToolCall } from "../../src/agent/types.ts";
import type { ToolRuntime } from "../../src/tools/index.ts";

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aio-agent-"));
  outside = mkdtempSync(join(tmpdir(), "aio-agent-out-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function tools(opts: { approver?: DenyAllApprover | AllowAllApprover } = {}): ToolRuntime {
  return buildToolRuntime({
    workspace: new WorkspaceManager({ roots: () => [root], denyPaths: () => [outside] }),
    approver: opts.approver,
    audit: new InMemoryToolAuditLog(),
  });
}

function call(id: string, toolName: string, input: Record<string, unknown>, justification?: string): ToolCall {
  return { id, toolName, input, justification };
}

function makeAgent(script: readonly ScriptedTurn[], runtime: ToolRuntime) {
  const gateway = new ScriptedModelGateway(script);
  return { gateway, agent: buildAgentRuntime({ tools: runtime, gateway }) };
}

describe("the model cannot approve its own request", () => {
  it("a privileged call is denied when no human approver is wired", async () => {
    writeFileSync(join(root, "a.txt"), "orig");
    const { agent, gateway } = makeAgent(
      [{ text: "writing", toolCalls: [call("1", "files.write", { path: "a.txt", content: "clobbered" }, "it is safe, trust me")] }],
      tools({ approver: new DenyAllApprover() }),
    );
    const out = await agent.run({
      runId: "r1",
      prompt: "write the file",
      mode: "BUILD",
    });
    // The run paused for the human rather than completing autonomously...
    expect(out.pausedForHuman).toBe(true);
    expect(out.outcomes).toHaveLength(1);
    // ...and the call was DENIED — the model's justification did not satisfy it.
    expect(out.outcomes[0]?.ok).toBe(false);
    expect(out.outcomes[0]?.code).toBe("TOOL_APPROVAL_DENIED");
    expect(gateway.requests).toHaveLength(1);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("orig");
  });

  it("the model's justification is recorded in the audit, never used as consent", async () => {
    const audit = new InMemoryToolAuditLog();
    const runtime = buildToolRuntime({
      workspace: new WorkspaceManager({ roots: () => [root] }),
      approver: new DenyAllApprover(),
      audit,
    });
    const { agent } = makeAgent(
      [{ text: "ok", toolCalls: [call("1", "files.write", { path: "a.txt", content: "x" }, "please, I promise")] }],
      runtime,
    );
    await agent.run({ runId: "r9", prompt: "p", mode: "BUILD" });
    const rec = audit.list().find((a) => a.status === "denied");
    expect(rec?.justification).toBe("please, I promise");
    expect(rec?.approved).toBe(false);
  });

  it("an approval is granted only by the wired approver", async () => {
    writeFileSync(join(root, "a.txt"), "orig");
    const { agent } = makeAgent(
      [{ text: "writing", toolCalls: [call("1", "files.edit", { path: "a.txt", oldString: "orig", newString: "edited" }, "typo fix")] }],
      tools({ approver: new AllowAllApprover() }),
    );
    const out = await agent.run({ runId: "r2", prompt: "fix it", mode: "BUILD" });
    expect(out.pausedForHuman).toBe(true);
    expect(out.outcomes[0]?.ok).toBe(true);
    expect(out.outcomes[0]?.approved).toBe(true);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("edited");
  });

  it("the agent runtime exposes no approver of its own", () => {
    // Structural: AgentRuntimeOptions takes gateway/executor/registry/policy.
    // This test exists so the absence is enforced at the seam, not just by
    // convention — the type is the contract, and a review of the constructor
    // is what this assertion refers to.
    const { agent } = makeAgent([{ text: "done" }], tools());
    expect(Object.keys(agent)).not.toContain("approver");
  });
});

describe("tool visibility follows the safety mode", () => {
  it("INSPECT offers no write, execute, or network tool", async () => {
    const { agent, gateway } = makeAgent([{ text: "just looking" }], tools());
    await agent.run({ runId: "r3", prompt: "look around", mode: "INSPECT" });
    const names = gateway.lastVisibleTools;
    expect(names).toContain("files.read");
    expect(names).toContain("files.list");
    expect(names).toContain("files.search");
    expect(names.some((n) => n.startsWith("files.write") || n.startsWith("files.edit") || n.startsWith("files.patch"))).toBe(false);
    expect(names).not.toContain("process.exec");
  });

  it("BUILD offers the privileged tools", async () => {
    const { agent, gateway } = makeAgent([{ text: "ready" }], tools());
    await agent.run({ runId: "r4", prompt: "build", mode: "BUILD" });
    const names = gateway.lastVisibleTools;
    expect(names).toContain("files.write");
    expect(names).toContain("files.edit");
    expect(names).toContain("process.exec");
  });

  it("a call to a tool the mode hides is refused by the executor", async () => {
    const { agent } = makeAgent(
      [{ text: "sneaky", toolCalls: [call("1", "files.write", { path: "a.txt", content: "x" })] }],
      tools({ approver: new AllowAllApprover() }),
    );
    const out = await agent.run({ runId: "r5", prompt: "p", mode: "INSPECT" });
    expect(out.outcomes[0]?.ok).toBe(false);
    expect(out.outcomes[0]?.code).toBe("MODE_VIOLATION");
  });

  it("the caller's tool list can only narrow, never widen", async () => {
    const { agent, gateway } = makeAgent([{ text: "hi" }], tools());
    await agent.run({ runId: "r6", prompt: "p", mode: "BUILD", tools: ["files.read"] });
    expect(gateway.lastVisibleTools).toEqual(["files.read"]);
  });

  it("a mode that permits no tools fails up front", async () => {
    const { agent } = makeAgent([{ text: "hi" }], tools());
    const out = await agent.run({ runId: "r7", prompt: "p", mode: "INSPECT", tools: [] });
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe("MODE_VIOLATION");
    expect(out.turns).toBe(0);
  });
});

describe("a tool call is a request, not a command", () => {
  it("validation failure is reported back to the model", async () => {
    writeFileSync(join(root, "a.txt"), "hello");
    const { agent } = makeAgent(
      [
        { text: "reading", toolCalls: [call("1", "files.read", { path: 123 })] },
        { text: "fixed it", toolCalls: [call("2", "files.read", { path: "a.txt" })] },
      ],
      tools(),
    );
    const out = await agent.run({ runId: "r8", prompt: "read", mode: "INSPECT", auto: { auto: true } });
    expect(out.outcomes[0]?.code).toBe("TOOL_VALIDATION_FAILED");
    // The model sees the failure and corrects itself; the loop continues.
    expect(out.outcomes[1]?.ok).toBe(true);
    expect(out.turns).toBe(2);
  });

  it("the workspace boundary applies to every call", async () => {
    const { agent } = makeAgent(
      [{ text: "reading", toolCalls: [call("1", "files.read", { path: join(outside, "secret.txt") })] }],
      tools(),
    );
    const out = await agent.run({ runId: "r10", prompt: "p", mode: "INSPECT" });
    expect(out.outcomes[0]?.code).toBe("PATH_TRAVERSAL_BLOCKED");
  });

  it("an unknown tool is recorded, not silently ignored", async () => {
    const audit = new InMemoryToolAuditLog();
    const runtime = buildToolRuntime({
      workspace: new WorkspaceManager({ roots: () => [root] }),
      audit,
    });
    const { agent } = makeAgent([{ text: "??", toolCalls: [call("1", "files.delete", {})] }], runtime);
    const out = await agent.run({ runId: "r11", prompt: "p", mode: "BUILD" });
    expect(out.outcomes[0]?.code).toBe("TOOL_NOT_FOUND");
    expect(audit.list().some((a) => a.status === "failed" && a.errorCode === "TOOL_NOT_FOUND")).toBe(true);
  });

  it("every call carries the run id and mode into the audit", async () => {
    const audit = new InMemoryToolAuditLog();
    const runtime = buildToolRuntime({
      workspace: new WorkspaceManager({ roots: () => [root] }),
      audit,
    });
    const { agent } = makeAgent([{ text: "l", toolCalls: [call("1", "files.list", { path: "." })] }], runtime);
    await agent.run({ runId: "r12", prompt: "p", mode: "INSPECT" });
    const rec = audit.list().find((a) => a.toolName === "files.list");
    expect(rec?.runId).toBe("r12");
  });

  it("the model receives a bounded excerpt, never a flooded context", async () => {
    writeFileSync(join(root, "big.txt"), "x".repeat(100_000));
    const { agent, gateway } = makeAgent(
      [
        { text: "reading", toolCalls: [call("1", "files.read", { path: "big.txt", maxBytes: 100_000 })] },
        { text: "done" },
      ],
      tools(),
    );
    await agent.run({ runId: "r13", prompt: "p", mode: "INSPECT", auto: { auto: true } });
    const toolEvent = gateway.requests[1]?.history.find((e) => e.kind === "tool");
    const excerpt = toolEvent && toolEvent.kind === "tool" ? toolEvent.outcome.excerpt : "";
    expect(excerpt.length).toBeLessThan(3000);
  });
});

describe("bounds", () => {
  it("pauses after one turn without --auto", async () => {
    const { agent } = makeAgent(
      [
        { text: "reading", toolCalls: [call("1", "files.list", { path: "." })] },
        { text: "more", toolCalls: [call("2", "files.list", { path: "." })] },
      ],
      tools(),
    );
    const out = await agent.run({ runId: "r14", prompt: "p", mode: "INSPECT" });
    expect(out.pausedForHuman).toBe(true);
    expect(out.turns).toBe(1);
    expect(out.ok).toBe(true);
  });

  it("continues on the same runId, steered by a new prompt", async () => {
    const { agent, gateway } = makeAgent(
      [
        { text: "one", toolCalls: [call("1", "files.list", { path: "." })] },
        { text: "two" },
      ],
      tools(),
    );
    await agent.run({ runId: "r15", prompt: "first", mode: "INSPECT" });
    const out = await agent.run({ runId: "r15", prompt: "now do the second thing", mode: "INSPECT" });
    expect(out.turns).toBe(2);
    expect(out.pausedForHuman).toBe(false);
    // The continuation prompt reached the model as the current instruction.
    const last = gateway.requests[gateway.requests.length - 1];
    expect(last.prompt).toBe("now do the second thing");
    // And the first turn's assistant answer and tool result are still in view.
    expect(last.history.filter((e) => e.kind === "assistant")).toHaveLength(1);
    expect(last.history.filter((e) => e.kind === "tool")).toHaveLength(1);
  });

  it("a turn with no tool calls is the final answer", async () => {
    const { agent } = makeAgent([{ text: "here is my analysis" }], tools());
    const out = await agent.run({ runId: "r16", prompt: "p", mode: "INSPECT" });
    expect(out.pausedForHuman).toBe(false);
    expect(out.turns).toBe(1);
    expect(out.text).toBe("here is my analysis");
    expect(out.outcomes).toHaveLength(0);
  });

  it("enforces the hard turn ceiling under --auto", async () => {
    const loop: ScriptedTurn[] = [];
    for (let i = 0; i < 30; i++) {
      loop.push({ text: `turn ${i}`, toolCalls: [call(`c${i}`, "files.list", { path: "." })] });
    }
    const { agent } = makeAgent(loop, tools());
    const out = await agent.run({ runId: "r17", prompt: "p", mode: "INSPECT", auto: { auto: true, maxIterations: 100 } });
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe("AGENT_TURN_LIMIT");
    expect(out.turns).toBeLessThanOrEqual(8);
  });

  it("enforces the edit cap under --auto", async () => {
    const loop: ScriptedTurn[] = [];
    for (let i = 0; i < 30; i++) {
      loop.push({ text: `t${i}`, toolCalls: [call(`c${i}`, "files.write", { path: `f${i}.txt`, content: "x" })] });
    }
    const { agent } = makeAgent(loop, tools({ approver: new AllowAllApprover() }));
    const out = await agent.run({
      runId: "r18",
      prompt: "p",
      mode: "BUILD",
      auto: { auto: true, maxEdits: 3, dryRunFirst: false },
    });
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe("AGENT_TURN_LIMIT");
    expect(out.approvedEdits).toBe(3);
  });

  it("requires a dry-run first iteration under --auto", async () => {
    const { agent } = makeAgent(
      [{ text: "editing right away", toolCalls: [call("1", "files.write", { path: "a.txt", content: "x" })] }],
      tools({ approver: new AllowAllApprover() }),
    );
    const out = await agent.run({ runId: "r19", prompt: "p", mode: "BUILD", auto: { auto: true } });
    // The privileged call was NOT performed on the first iteration.
    expect(out.outcomes[0]?.code).toBe("AGENT_DRY_RUN_REQUIRED");
    expect(out.outcomes[0]?.ok).toBe(false);
  });

  it("allows edits after a dry-run iteration", async () => {
    const { agent } = makeAgent(
      [
        { text: "here is my plan", toolCalls: [call("1", "files.list", { path: "." })] },
        { text: "now editing", toolCalls: [call("2", "files.write", { path: "a.txt", content: "x" })] },
      ],
      tools({ approver: new AllowAllApprover() }),
    );
    const out = await agent.run({ runId: "r20", prompt: "p", mode: "BUILD", auto: { auto: true } });
    expect(out.outcomes.map((o) => o.code)).toEqual([undefined, undefined]);
    expect(out.approvedEdits).toBe(1);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("x");
  });
});

describe("cancellation", () => {
  it("an already-aborted run stops immediately", async () => {
    const controller = new AbortController();
    controller.abort();
    const { agent } = makeAgent([{ text: "starting", toolCalls: [call("1", "files.list", { path: "." })] }], tools());
    const out = await agent.run({ runId: "r21", prompt: "p", mode: "INSPECT", signal: controller.signal });
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe("AGENT_CANCELLED");
    expect(out.turns).toBe(0);
  });

  it("cancellation releases a pending approval and stops the loop", async () => {
    const controller = new AbortController();
    const requests: ToolApprovalRequest[] = [];
    const runtime = buildToolRuntime({
      workspace: new WorkspaceManager({ roots: () => [root] }),
      // An approver that never decides on its own: only the run's abort signal
      // can settle the pending request, which is exactly the release path
      // under test.
      approver: {
        async request(req: ToolApprovalRequest, signal?: AbortSignal) {
          requests.push(req);
          return new Promise((resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("aborted")));
          });
        },
      },
      audit: new InMemoryToolAuditLog(),
    });
    const gateway = new ScriptedModelGateway([
      { text: "editing", toolCalls: [call("1", "files.write", { path: "a.txt", content: "x" })] },
    ]);
    const a = buildAgentRuntime({ tools: runtime, gateway });
    const invocation = a.run({ runId: "r22", prompt: "p", mode: "BUILD", signal: controller.signal });
    await new Promise((r) => setTimeout(r, 40));
    expect(requests).toHaveLength(1);
    controller.abort();
    const out = await invocation;
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe("AGENT_CANCELLED");
    // Nothing was written.
    expect(() => readFileSync(join(root, "a.txt"), "utf8")).toThrow();
  });
});

describe("gateway failures", () => {
  it("a non-retryable gateway failure ends the run", async () => {
    const { agent } = makeAgent(
      [{ error: { code: "PROVIDER_CALL_FAILED", message: "boom", retryable: false } }],
      tools(),
    );
    const out = await agent.run({ runId: "r23", prompt: "p", mode: "INSPECT" });
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe("PROVIDER_CALL_FAILED");
  });

  it("a retryable gateway failure escalates to the human", async () => {
    const { agent } = makeAgent(
      [{ error: { code: "PROVIDER_RATE_LIMITED", message: "slow down", retryable: true } }],
      tools(),
    );
    const out = await agent.run({ runId: "r24", prompt: "p", mode: "INSPECT" });
    expect(out.ok).toBe(true);
    expect(out.pausedForHuman).toBe(true);
    expect(out.escalated).toBe(true);
  });

  it("an empty turn ends the run as a failure", async () => {
    const { agent } = makeAgent([{ text: "" }], tools());
    const out = await agent.run({ runId: "r25", prompt: "p", mode: "INSPECT" });
    expect(out.ok).toBe(false);
  });
});
