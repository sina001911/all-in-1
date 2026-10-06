/**
 * Tool executor tests (D2).
 *
 * Pins the fixed pipeline and its security properties:
 *   - unknown tools and invalid inputs never execute;
 *   - the mode gate refuses privileged classes outside BUILD;
 *   - a privileged tool never runs without a human approval, and the model can
 *     never satisfy that itself;
 *   - timeouts and cancellation settle the call without leaking state;
 *   - a tool that throws is isolated into a settled result;
 *   - every terminal state is audited, including refusals.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildToolRuntime } from "../../src/tools/index.ts";
import { WorkspaceManager } from "../../src/tools/workspace.ts";
import { InMemoryToolAuditLog } from "../../src/tools/audit.ts";
import {
  AllowAllApprover,
  ClassRuleApprover,
  DenyAllApprover,
  type ToolApprovalRequest,
} from "../../src/tools/approval.ts";
import { ToolPermissionPolicy } from "../../src/tools/permissions.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { ToolExecutor } from "../../src/tools/executor.ts";
import type { Tool, ToolSchema } from "../../src/tools/types.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-exec-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runtime(opts?: {
  approver?: AllowAllApprover | ClassRuleApprover | DenyAllApprover | RecordingApprover;
  extraTools?: readonly Tool[];
}) {
  const workspace = new WorkspaceManager({ roots: () => [dir] });
  const audit = new InMemoryToolAuditLog();
  return buildToolRuntime({
    workspace,
    audit,
    approver: opts?.approver,
    extraTools: opts?.extraTools,
  });
}

/** Records every approval request so a test can prove the model was asked. */
class RecordingApprover extends AllowAllApprover {
  public readonly requests: ToolApprovalRequest[] = [];
  async request(req: ToolApprovalRequest) {
    this.requests.push(req);
    return super.request(req);
  }
}

/** A tool that never settles on its own; only the executor's race ends it. */
function hangingTool(): Tool {
  return {
    schema: {
      name: "test.hang",
      description: "never settles",
      permission: "read",
      timeoutMs: 60_000,
      input: { type: "object", additionalProperties: false, properties: {} },
    },
    async execute() {
      return new Promise(() => {
        /* never resolves */
      });
    },
  };
}

/** A tool that throws, to prove error isolation. */
function throwingTool(): Tool {
  return {
    schema: {
      name: "test.throw",
      description: "always throws",
      permission: "read",
      input: { type: "object", additionalProperties: false, properties: {} },
    },
    async execute() {
      throw new Error("boom");
    },
  };
}

describe("executor: resolve and validate", () => {
  it("reports TOOL_NOT_FOUND for an unregistered tool", async () => {
    const r = runtime();
    const out = await r.executor.execute({ toolName: "nope", input: {}, runId: "run-1" });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("TOOL_NOT_FOUND");
    // Refusals are audited too.
    expect(r.audit.list().map((a) => a.status)).toContain("failed");
    expect(r.audit.list()[0]?.errorCode).toBe("TOOL_NOT_FOUND");
  });

  it("reports TOOL_VALIDATION_FAILED for a bad input", async () => {
    const r = runtime();
    const out = await r.executor.execute({
      toolName: "files.read",
      input: { path: 123 },
      runId: "run-1",
    });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("TOOL_VALIDATION_FAILED");
  });

  it("refuses an input with unknown properties", async () => {
    const r = runtime();
    const out = await r.executor.execute({
      toolName: "files.read",
      input: { path: join(dir, "a"), unexpected: true },
      runId: "run-1",
    });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("TOOL_VALIDATION_FAILED");
  });
});

describe("executor: mode gate", () => {
  it("refuses a write tool in INSPECT mode", async () => {
    const r = runtime({ approver: new AllowAllApprover() });
    const out = await r.executor.execute({
      toolName: "files.write",
      input: { path: "a.txt", content: "x" },
      runId: "run-1",
      mode: "INSPECT",
    });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("MODE_VIOLATION");
  });

  it("allows a write tool in BUILD mode with approval", async () => {
    const r = runtime({ approver: new AllowAllApprover() });
    const out = await r.executor.execute({
      toolName: "files.write",
      input: { path: "a.txt", content: "x" },
      runId: "run-1",
      mode: "BUILD",
    });
    expect(out.ok).toBe(true);
  });

  it("allows a read tool in every mode", async () => {
    const r = runtime();
    for (const mode of ["INSPECT", "SUGGEST", "BUILD"] as const) {
      const out = await r.executor.execute({
        toolName: "files.list",
        input: { path: "." },
        runId: "run-1",
        mode,
      });
      expect(out.ok).toBe(true);
    }
  });
});

describe("executor: approvals", () => {
  it("never runs a privileged tool without a human approval", async () => {
    const r = runtime({ approver: new DenyAllApprover() });
    const out = await r.executor.execute({
      toolName: "files.write",
      input: { path: "a.txt", content: "x" },
      runId: "run-1",
    });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("TOOL_APPROVAL_DENIED");
    expect(out.approved).toBe(false);
  });

  it("runs the same tool once a human approves", async () => {
    const r = runtime({ approver: new AllowAllApprover() });
    const out = await r.executor.execute({
      toolName: "files.write",
      input: { path: "a.txt", content: "x" },
      runId: "run-1",
    });
    expect(out.ok).toBe(true);
    expect(out.approved).toBe(true);
  });

  it("does not ask for approval on a read-class tool", async () => {
    const approver = new RecordingApprover();
    const r = runtime({ approver });
    const out = await r.executor.execute({
      toolName: "files.list",
      input: { path: "." },
      runId: "run-1",
    });
    expect(out.ok).toBe(true);
    expect(approver.requests).toHaveLength(0);
  });

  it("records the model's justification and a sanitized input in the request", async () => {
    const approver = new RecordingApprover();
    const r = runtime({ approver });
    await r.executor.execute({
      toolName: "files.write",
      input: { path: "a.txt", content: "x".repeat(500) },
      runId: "run-1",
      justification: "the test needs a file",
    });
    expect(approver.requests).toHaveLength(1);
    const req = approver.requests[0] as ToolApprovalRequest;
    expect(req.justification).toBe("the test needs a file");
    expect(req.permission).toBe("write");
    // Content is never copied into the approval request, at any length.
    expect(String(req.inputSummary["content"])).toBe("500 characters");
    expect(req.summary).toContain("files.write");
  });

  it("classifies per privilege class, not per request", async () => {
    const approver = new ClassRuleApprover(["capture"]);
    const r = runtime({ approver });
    const allowed = await r.executor.execute({
      toolName: "files.list",
      input: { path: "." },
      runId: "run-1",
    });
    expect(allowed.ok).toBe(true);
    const denied = await r.executor.execute({
      toolName: "files.write",
      input: { path: "a.txt", content: "x" },
      runId: "run-1",
    });
    expect(denied.ok).toBe(false);
    expect(denied.code).toBe("TOOL_APPROVAL_DENIED");
  });
});

describe("executor: bounded execution", () => {
  it("settles a hanging tool by timeout", async () => {
    const r = runtime({ extraTools: [hangingTool()] });
    const out = await r.executor.execute({
      toolName: "test.hang",
      input: {},
      runId: "run-1",
      timeoutMs: 40,
    });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("TOOL_TIMEOUT");
    expect(r.audit.list().some((a) => a.status === "timeout")).toBe(true);
  }, 10_000);

  it("settles a hanging tool by cancellation", async () => {
    const r = runtime({ extraTools: [hangingTool()] });
    const controller = new AbortController();
    const invocation = r.executor.execute({
      toolName: "test.hang",
      input: {},
      runId: "run-1",
      signal: controller.signal,
    });
    await new Promise((res) => setTimeout(res, 60));
    controller.abort();
    const out = await invocation;
    expect(out.ok).toBe(false);
    expect(out.code).toBe("TOOL_CANCELLED");
    expect(r.audit.list().some((a) => a.status === "cancelled")).toBe(true);
  }, 10_000);

  it("cancels before an approval is even requested", async () => {
    const controller = new AbortController();
    controller.abort();
    const r = runtime({ approver: new AllowAllApprover() });
    const out = await r.executor.execute({
      toolName: "files.write",
      input: { path: "a.txt", content: "x" },
      runId: "run-1",
      signal: controller.signal,
    });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("TOOL_CANCELLED");
  });
});

describe("executor: error isolation", () => {
  it("converts a thrown tool error into a settled failure", async () => {
    const r = runtime({ extraTools: [throwingTool()] });
    const out = await r.executor.execute({ toolName: "test.throw", input: {}, runId: "run-1" });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("TOOL_EXECUTION_FAILED");
    expect(out.message).toContain("boom");
    expect(r.audit.list().some((a) => a.status === "failed")).toBe(true);
  });
});

describe("executor: audit", () => {
  it("records a terminal entry for a successful run", async () => {
    const r = runtime();
    await r.executor.execute({ toolName: "files.list", input: { path: "." }, runId: "run-42" });
    const records = r.audit.list();
    expect(records.length).toBeGreaterThanOrEqual(1);
    expect(records.some((a) => a.runId === "run-42" && a.status === "ok")).toBe(true);
    expect(records.every((a) => a.toolName === "files.list")).toBe(true);
  });

  it("records the refusal of an unregistered tool", async () => {
    const r = runtime();
    await r.executor.execute({ toolName: "nope", input: {}, runId: "run-1" });
    expect(r.audit.list()[0]?.status).toBe("failed");
  });

  it("never records file contents", async () => {
    const r = runtime({ approver: new AllowAllApprover() });
    const secret = "SUPER-SECRET-BODY";
    await r.executor.execute({
      toolName: "files.write",
      input: { path: "a.txt", content: secret },
      runId: "run-1",
    });
    expect(JSON.stringify(r.audit.list())).not.toContain(secret);
  });
});

describe("policy and registry wiring", () => {
  it("the frozen policy requires approval for privileged classes only", () => {
    const policy = new ToolPermissionPolicy();
    expect(policy.requiresApproval({ permission: "read" } as ToolSchema)).toBe(false);
    expect(policy.requiresApproval({ permission: "capture" } as ToolSchema)).toBe(false);
    expect(policy.requiresApproval({ permission: "write" } as ToolSchema)).toBe(true);
    expect(policy.requiresApproval({ permission: "execute" } as ToolSchema)).toBe(true);
    expect(policy.requiresApproval({ permission: "network" } as ToolSchema)).toBe(true);
  });

  it("an override cannot remove the approval requirement it did not declare", () => {
    const policy = new ToolPermissionPolicy({ write: { requiresApproval: false } });
    expect(policy.requiresApproval({ permission: "write" } as ToolSchema)).toBe(false);
    expect(policy.requiresApproval({ permission: "execute" } as ToolSchema)).toBe(true);
  });

  it("refuses to register two tools with the same name", () => {
    const registry = new ToolRegistry();
    registry.register(hangingTool());
    expect(() => registry.register(hangingTool())).toThrow(/already registered/);
  });

  it("the default runtime builds with a deny-all approver", () => {
    const r = runtime();
    expect(r.approver).toBeInstanceOf(DenyAllApprover);
    expect(r.registry.names()).toContain("files.read");
    expect(r.registry.names()).toContain("files.write");
    expect(r.registry.names()).toContain("files.edit");
    expect(r.registry.names()).toContain("files.patch");
    expect(r.registry.names()).toContain("files.search");
    expect(r.registry.names()).toContain("process.exec");
  });

  it("re-exports the executor with the shared policy", () => {
    const workspace = new WorkspaceManager({ roots: () => [dir] });
    const audit = new InMemoryToolAuditLog();
    const executor = new ToolExecutor({
      registry: new ToolRegistry(),
      policy: new ToolPermissionPolicy(),
      approver: new DenyAllApprover(),
      audit,
      workspace,
    });
    expect(executor).toBeDefined();
  });
});
