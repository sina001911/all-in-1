/**
 * Provider model gateway tests (D4).
 *
 * The D3 loop was driven by a scripted gateway. This wires the REAL gateway to
 * the REAL execution stack, so every assertion here also proves the frozen
 * gates still bind an agent turn: selection, egress, approval, budget, and the
 * single network seam. Under the frozen defaults the only model reachable is
 * the deterministic local agent model — no host is allowlisted, no credential
 * is read, and the budget is zero, so a remote call cannot even begin.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildToolRuntime } from "../../src/tools/index.ts";
import { WorkspaceManager } from "../../src/tools/workspace.ts";
import { InMemoryToolAuditLog } from "../../src/tools/audit.ts";
import { AllowAllApprover } from "../../src/tools/approval.ts";
import { buildSpecialistStack } from "../../src/specialists/stack.ts";
import { ProviderModelGateway } from "../../src/agent/provider-gateway.ts";
import { buildAgentRuntime } from "../../src/agent/index.ts";
import type { ToolCall } from "../../src/agent/types.ts";
import type { SelectionRequest } from "../../src/models/types.ts";
import type { ExecutionOutcome, InvocationPortal, InvokeOptions } from "../../src/execution/engine.ts";

/** A portal that inspects the selection request, then delegates to the real engine. */
function spyingOn(engine: InvocationPortal, capture: (req: SelectionRequest) => void): InvocationPortal {
  return {
    async invoke(request: SelectionRequest, options?: InvokeOptions): Promise<ExecutionOutcome> {
      capture(request);
      return engine.invoke(request, options);
    },
  };
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aio-d4-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A prompt that makes the deterministic local model emit these tool calls. */
function withToolCalls(calls: ToolCall[], body = "on it"): string {
  const block = JSON.stringify(calls, null, 2);
  return `${body}\n\n\`\`\`tool-calls\n${block}\n\`\`\``;
}

describe("gateway against the real execution stack", () => {
  it("routes a turn through the engine and returns the model's text", async () => {
    const stack = buildSpecialistStack({ agentModel: true });
    const gateway = new ProviderModelGateway({ engine: stack.stack.engine });
    const out = await gateway.turn({
      runId: "g1",
      prompt: "hello",
      mode: "INSPECT",
      history: [],
      tools: [],
    });
    expect(out.ok).toBe(true);
    expect(out.text).toContain("local:CODING");
    expect(out.toolCalls).toEqual([]);
  });

  it("carries the model's tool calls through", async () => {
    const stack = buildSpecialistStack({ agentModel: true });
    const gateway = new ProviderModelGateway({ engine: stack.stack.engine });
    const out = await gateway.turn({
      runId: "g2",
      prompt: withToolCalls([
        { id: "1", toolName: "files.read", input: { path: "a.txt" }, justification: "need it" },
      ]),
      mode: "INSPECT",
      history: [],
      tools: [],
    });
    expect(out.toolCalls).toEqual([
      { id: "1", toolName: "files.read", input: { path: "a.txt" }, justification: "need it" },
    ]);
  });

  it("hands the permitted tool declarations to the provider", async () => {
    const stack = buildSpecialistStack({ agentModel: true });
    let declared: unknown = null;
    const gateway = new ProviderModelGateway({
      engine: spyingOn(stack.stack.engine, (req) => {
        declared = req.toolDeclarations;
      }),
    });
    await gateway.turn({
      runId: "g3",
      prompt: "p",
      mode: "INSPECT",
      history: [],
      tools: [
        {
          name: "files.read",
          description: "read a file",
          permission: "read",
          input: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      ],
    });
    expect(declared).toEqual([
      {
        name: "files.read",
        description: "read a file",
        input: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    ]);
  });

  it("a malformed tool-calls block degrades to a text turn", async () => {
    const stack = buildSpecialistStack({ agentModel: true });
    const gateway = new ProviderModelGateway({ engine: stack.stack.engine });
    const out = await gateway.turn({
      runId: "g4",
      prompt: "do it\n\n```tool-calls\n[not valid json\n```",
      mode: "INSPECT",
      history: [],
      tools: [],
    });
    expect(out.ok).toBe(true);
    expect(out.toolCalls).toEqual([]);
  });

  it("the transcript reaches the model, conversation and all", async () => {
    const stack = buildSpecialistStack({ agentModel: true });
    let sentText: string | null = null;
    const gateway = new ProviderModelGateway({
      engine: spyingOn(stack.stack.engine, (req) => {
        const text = req.inputs?.find((i) => i.kind === "text");
        sentText = text?.text ?? null;
      }),
    });
    const out = await gateway.turn({
      runId: "g5",
      prompt: "second turn",
      mode: "BUILD",
      history: [
        { kind: "user", text: "first turn" },
        {
          kind: "assistant",
          text: "looking",
          toolCalls: [{ id: "1", toolName: "files.list", input: { path: "." } }],
        },
        {
          kind: "tool",
          outcome: {
            toolCallId: "1",
            toolName: "files.list",
            ok: true,
            excerpt: "a.txt b.txt",
            artifacts: [],
            approved: false,
          },
        },
      ],
      tools: [],
    });
    expect(out.ok).toBe(true);
    // The whole conversation reached the provider, and the current prompt is
    // last, where the deterministic protocol looks for a directive.
    expect(sentText).toContain("first turn");
    expect(sentText).toContain("a.txt b.txt");
    const transcript = sentText ?? "";
    expect(transcript.trimEnd().endsWith("second turn")).toBe(true);
  });

  it("an earlier prompt's tool-call directive is never replayed", async () => {
    // A past prompt asked for a read; the current one asks for nothing. The
    // deterministic model must not echo the old call onto the new turn.
    const stack = buildSpecialistStack({ agentModel: true });
    const gateway = new ProviderModelGateway({ engine: stack.stack.engine });
    const out = await gateway.turn({
      runId: "g8",
      prompt: "just talk",
      mode: "INSPECT",
      history: [
        {
          kind: "user",
          text: "read it\n\n```tool-calls\n[{\"id\":\"1\",\"toolName\":\"files.read\",\"input\":{\"path\":\"a.txt\"}}]\n```",
        },
        { kind: "assistant", text: "ok", toolCalls: [{ id: "1", toolName: "files.read", input: { path: "a.txt" } }] },
        {
          kind: "tool",
          outcome: {
            toolCallId: "1",
            toolName: "files.read",
            ok: true,
            excerpt: "contents",
            artifacts: [],
            approved: false,
          },
        },
      ],
      tools: [],
    });
    expect(out.ok).toBe(true);
    expect(out.toolCalls).toEqual([]);
  });

  it("forwards the turn timeout and cancellation", async () => {
    const stack = buildSpecialistStack({ agentModel: true });
    const gateway = new ProviderModelGateway({ engine: stack.stack.engine });
    const controller = new AbortController();
    controller.abort();
    const out = await gateway.turn(
      { runId: "g6", prompt: "p", mode: "INSPECT", history: [], tools: [] },
      { signal: controller.signal },
    );
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe("PROVIDER_CANCELLED");
  });
});

describe("the full agent loop on the real stack", () => {
  it("reads a file through the real model, the real pipeline, and back", async () => {
    writeFileSync(join(root, "a.txt"), "the answer is 42");
    const stack = buildSpecialistStack({ agentModel: true });
    const runtime = buildToolRuntime({
      workspace: new WorkspaceManager({ roots: () => [root] }),
      audit: new InMemoryToolAuditLog(),
    });
    const agent = buildAgentRuntime({
      tools: runtime,
      gateway: new ProviderModelGateway({ engine: stack.stack.engine }),
    });

    const first = await agent.run({
      runId: "full-1",
      prompt: withToolCalls([{ id: "1", toolName: "files.read", input: { path: "a.txt" } }], "read the file"),
      mode: "INSPECT",
    });
    // Without --auto the loop pauses after one turn; the read is done.
    expect(first.pausedForHuman).toBe(true);
    expect(first.outcomes).toHaveLength(1);
    expect(first.outcomes[0]?.ok).toBe(true);
    expect(first.outcomes[0]?.excerpt).toContain("the answer is 42");

    // Continue: the model now has the result and answers.
    const second = await agent.run({
      runId: "full-1",
      prompt: "what does it say? answer in plain text, call no tools",
      mode: "INSPECT",
    });
    expect(second.pausedForHuman).toBe(false);
    expect(second.turns).toBe(2);
  });

  it("a privileged call still waits for the human on the real stack", async () => {
    writeFileSync(join(root, "a.txt"), "orig");
    const stack = buildSpecialistStack({ agentModel: true });
    const audit = new InMemoryToolAuditLog();
    const runtime = buildToolRuntime({
      workspace: new WorkspaceManager({ roots: () => [root] }),
      approver: new AllowAllApprover(),
      audit,
    });
    const agent = buildAgentRuntime({
      tools: runtime,
      gateway: new ProviderModelGateway({ engine: stack.stack.engine }),
    });
    const out = await agent.run({
      runId: "full-2",
      prompt: withToolCalls(
        [{ id: "1", toolName: "files.write", input: { path: "a.txt", content: "clobbered" }, justification: "updating" }],
        "rewrite the file",
      ),
      mode: "BUILD",
    });
    expect(out.outcomes[0]?.ok).toBe(true);
    expect(out.outcomes[0]?.approved).toBe(true);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("clobbered");
    // The model's justification was recorded, and the approval was the wired
    // approver's — never the model's own.
    const rec = audit.list().find((a) => a.toolName === "files.write" && a.status === "ok");
    expect(rec?.justification).toBe("updating");
    expect(rec?.approved).toBe(true);
  });

  it("the workspace boundary binds a real model call", async () => {
    const outside = mkdtempSync(join(tmpdir(), "aio-d4-out-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "secret");
      const stack = buildSpecialistStack({ agentModel: true });
      const runtime = buildToolRuntime({
        workspace: new WorkspaceManager({ roots: () => [root], denyPaths: () => [outside] }),
        audit: new InMemoryToolAuditLog(),
      });
      const agent = buildAgentRuntime({
        tools: runtime,
        gateway: new ProviderModelGateway({ engine: stack.stack.engine }),
      });
      const out = await agent.run({
        runId: "full-3",
        prompt: withToolCalls([{ id: "1", toolName: "files.read", input: { path: join(outside, "secret.txt") } }], "read it"),
        mode: "INSPECT",
      });
      expect(out.outcomes[0]?.code).toBe("PATH_TRAVERSAL_BLOCKED");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("the frozen defaults still bind", () => {
  it("without the agent model opted in, no tool-capable model is selectable", async () => {
    const stack = buildSpecialistStack(); // agentModel defaults to false
    const gateway = new ProviderModelGateway({ engine: stack.stack.engine });
    const out = await gateway.turn({
      runId: "g7",
      prompt: "p",
      mode: "INSPECT",
      history: [],
      tools: [],
    });
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe("SELECTION_FAILED");
  });

  it("the default catalogue is unchanged by the opt-in", () => {
    expect(buildSpecialistStack().stack.catalog.list().map((m) => m.id).sort()).toEqual([
      "local/deterministic",
      "local/vision",
    ]);
    expect(buildSpecialistStack({ agentModel: true }).stack.catalog.list().map((m) => m.id).sort()).toEqual([
      "local/agent",
      "local/deterministic",
      "local/vision",
    ]);
  });
});
