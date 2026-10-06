/**
 * D2 desktop integration tests.
 *
 * Proves the privileged layer is reachable only through the contract the
 * facade exposes: the workspace roots come from the user's settings, the data
 * directory is denied to every tool, a privileged tool blocks until the human
 * answers, and the audit trail is persisted across a restart.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDesktopStack } from "../src/desktop-stack.ts";
import { DesktopFacade } from "../src/facade.ts";
import { MemoryCredentialProvider } from "../src/credentials/memory-credential-provider.ts";
import { InteractiveToolApprover } from "../src/tools/approver.ts";
import { DesktopWorkspaceRoots } from "../src/tools/workspace-roots.ts";
import { FileSettingsStore, MemorySettingsStore } from "../src/persistence/settings-store.ts";
import { JsonFileStore } from "../src/persistence/json-store.ts";
import { FileToolAuditStore } from "../src/tools/audit-store.ts";
import { JsonlAppendStore } from "../src/persistence/json-store.ts";
import type { ToolRequest } from "../../src/tools/types.ts";

let dir: string;
let project: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-d2-"));
  project = mkdtempSync(join(tmpdir(), "aio-d2-proj-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function stack(workspaceRoots?: readonly string[]) {
  const s = buildDesktopStack({
    baseDir: dir,
    credentials: new MemoryCredentialProvider(),
  });
  if (workspaceRoots) {
    s.settingsStore.patch({ workspaceRoots });
  }
  return s;
}

function facade(workspaceRoots?: readonly string[]) {
  return new DesktopFacade(stack(workspaceRoots));
}

/**
 * Invoke a tool and satisfy every approval it raises automatically. The desktop
 * stack's approver is interactive — it blocks until a human answers — so a test
 * that only wants the post-approval behaviour must pump the answers itself.
 * The pump stops the moment the invocation settles.
 */
async function runApproved(f: DesktopFacade, req: ToolRequest) {
  let settled = false;
  const done = f.invokeTool(req).then((r) => {
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

describe("workspace rooting from settings", () => {
  it("exposes no root until the user opens a directory", () => {
    const f = facade();
    expect(f.listWorkspaceRoots()).toEqual([]);
  });

  it("takes roots from the settings, resolved absolute", () => {
    const f = facade([project, join(project, "sub")]);
    expect(f.listWorkspaceRoots()).toEqual([project, join(project, "sub")]);
  });

  it("deduplicates roots", () => {
    const f = facade([project, project]);
    expect(f.listWorkspaceRoots()).toEqual([project]);
  });

  it("denies the application data directory even inside a root", async () => {
    // The data directory sits under the base; place a root over it and confirm
    // a tool still cannot read the credential store.
    const s = stack([dir]);
    const f = new DesktopFacade(s);
    writeFileSync(join(s.paths.credentials), "cannot-reach-this");
    const out = await f.invokeTool({
      toolName: "files.read",
      input: { path: s.paths.credentials },
      runId: "run-1",
    });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("PATH_TRAVERSAL_BLOCKED");
  });

  it("confines a write to an opened root", async () => {
    const f = facade([project]);
    const out = await runApproved(f, {
      toolName: "files.write",
      input: { path: join(project, "a.txt"), content: "ok" },
      runId: "run-1",
    });
    expect(out.ok).toBe(true);
    expect(readFileSync(join(project, "a.txt"), "utf8")).toBe("ok");
  });

  it("refuses a write into a directory the user never opened", async () => {
    const outside = mkdtempSync(join(tmpdir(), "aio-d2-out-"));
    try {
      const f = facade([project]);
      const out = await runApproved(f, {
        toolName: "files.write",
        input: { path: join(outside, "a.txt"), content: "nope" },
        runId: "run-1",
      });
      expect(out.ok).toBe(false);
      expect(out.code).toBe("PATH_TRAVERSAL_BLOCKED");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("tool listing", () => {
  it("lists tools with their permission and approval requirement", () => {
    const f = facade([project]);
    const tools = f.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("files.read")?.permission).toBe("read");
    expect(byName.get("files.read")?.requiresApproval).toBe(false);
    expect(byName.get("files.write")?.requiresApproval).toBe(true);
    expect(byName.get("process.exec")?.permission).toBe("execute");
    expect(tools.map((t) => t.name)).toContain("files.patch");
  });
});

describe("interactive approvals", () => {
  it("a privileged tool blocks until the human approves", async () => {
    const s = stack([project]);
    const f = new DesktopFacade(s);
    writeFileSync(join(project, "a.txt"), "original");
    const invocation = f.invokeTool({
      toolName: "files.edit",
      input: { path: join(project, "a.txt"), oldString: "original", newString: "edited" },
      runId: "run-1",
      justification: "fixing the typo",
    });
    await new Promise((r) => setTimeout(r, 60));
    // The request is pending and the file is untouched.
    const pending = f.listPendingToolApprovals();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.justification).toBe("fixing the typo");
    expect(readFileSync(join(project, "a.txt"), "utf8")).toBe("original");

    const approved = f.approveTool(pending[0]!.id, "looks right");
    expect(approved).toBe(true);
    const out = await invocation;
    expect(out.ok).toBe(true);
    expect(readFileSync(join(project, "a.txt"), "utf8")).toBe("edited");
  });

  it("a denial leaves the file untouched", async () => {
    const s = stack([project]);
    const f = new DesktopFacade(s);
    writeFileSync(join(project, "a.txt"), "original");
    const invocation = f.invokeTool({
      toolName: "files.write",
      input: { path: join(project, "a.txt"), content: "clobbered" },
      runId: "run-1",
    });
    await new Promise((r) => setTimeout(r, 60));
    const [pending] = f.listPendingToolApprovals();
    expect(f.denyTool(pending!.id, "not needed")).toBe(true);
    const out = await invocation;
    expect(out.ok).toBe(false);
    expect(out.code).toBe("TOOL_APPROVAL_DENIED");
    expect(readFileSync(join(project, "a.txt"), "utf8")).toBe("original");
  });

  it("an answer may only be given once", async () => {
    const s = stack([project]);
    const f = new DesktopFacade(s);
    const invocation = f.invokeTool({
      toolName: "files.write",
      input: { path: join(project, "a.txt"), content: "x" },
      runId: "run-1",
    });
    await new Promise((r) => setTimeout(r, 60));
    const [pending] = f.listPendingToolApprovals();
    expect(f.approveTool(pending!.id)).toBe(true);
    await invocation;
    expect(f.approveTool(pending!.id)).toBe(false);
    expect(f.denyTool(pending!.id)).toBe(false);
  });

  it("abandoning pending approvals denies them", async () => {
    const s = stack([project]);
    const f = new DesktopFacade(s);
    const invocation = f.invokeTool({
      toolName: "files.write",
      input: { path: join(project, "a.txt"), content: "x" },
      runId: "run-1",
    });
    await new Promise((r) => setTimeout(r, 60));
    f.abandonPendingApprovals("run abandoned");
    const out = await invocation;
    expect(out.ok).toBe(false);
    expect(out.code).toBe("TOOL_APPROVAL_DENIED");
    expect(f.listPendingToolApprovals()).toHaveLength(0);
  });

  it("a read tool needs no approval", async () => {
    const f = facade([project]);
    writeFileSync(join(project, "a.txt"), "hello");
    const out = await f.invokeTool({
      toolName: "files.read",
      input: { path: join(project, "a.txt") },
      runId: "run-1",
    });
    expect(out.ok).toBe(true);
    expect(f.listPendingToolApprovals()).toHaveLength(0);
  });
});

describe("audit persistence", () => {
  it("persists the tool audit trail across a restart", async () => {
    const s1 = stack([project]);
    const f1 = new DesktopFacade(s1);
    writeFileSync(join(project, "a.txt"), "hello");
    await f1.invokeTool({
      toolName: "files.read",
      input: { path: join(project, "a.txt") },
      runId: "run-1",
    });
    await runApproved(f1, {
      toolName: "files.write",
      input: { path: join(project, "b.txt"), content: "new" },
      runId: "run-1",
    });
    expect(existsSync(join(s1.paths.root, "tool-audit.jsonl"))).toBe(true);

    const f2 = new DesktopFacade(
      buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() }),
    );
    const audit = f2.listToolAudit();
    // Each invocation records a "started" entry plus a terminal one.
    const terminal = audit.filter((a) => a.status === "ok").map((a) => a.toolName);
    expect(terminal).toEqual(["files.read", "files.write"]);
    expect(audit.find((a) => a.toolName === "files.write")?.approved).toBe(true);
  });

  it("never writes a file body into the audit trail", async () => {
    const s1 = stack([project]);
    const f1 = new DesktopFacade(s1);
    const secret = "NEVER-IN-AUDIT";
    await runApproved(f1, {
      toolName: "files.write",
      input: { path: join(project, "c.txt"), content: secret },
      runId: "run-1",
    });
    const onDisk = readFileSync(join(s1.paths.root, "tool-audit.jsonl"), "utf8");
    expect(onDisk).not.toContain(secret);
  });
});

describe("approver and roots in isolation", () => {
  it("the approver denies an unknown request", () => {
    const approver = new InteractiveToolApprover();
    expect(approver.approve("nope")).toBe(false);
    expect(approver.deny("nope")).toBe(false);
    expect(approver.listPending()).toEqual([]);
  });

  it("denyAll clears every pending request", async () => {
    const approver = new InteractiveToolApprover();
    const p1 = approver.request({ id: "a", runId: "r", toolName: "files.write", permission: "write", summary: "s", inputSummary: {}, createdAt: 1 });
    const p2 = approver.request({ id: "b", runId: "r", toolName: "files.write", permission: "write", summary: "s", inputSummary: {}, createdAt: 2 });
    approver.denyAll("shutdown");
    expect(await p1).toMatchObject({ approved: false });
    expect(await p2).toMatchObject({ approved: false });
    expect(approver.listPending()).toHaveLength(0);
  });

  it("roots are re-read on every resolution", () => {
    const store = new MemorySettingsStore();
    const roots = new DesktopWorkspaceRoots(store, dir);
    expect(roots.roots()).toEqual([]);
    store.patch({ workspaceRoots: [project] });
    expect(roots.roots()).toEqual([project]);
  });

  it("the file audit store drops suspect fields", () => {
    const store = new FileToolAuditStore(new JsonlAppendStore(dir, "ta.jsonl"));
    store.record({
      id: "x",
      runId: "r",
      ts: 1,
      toolName: "files.read",
      permission: "read",
      inputSummary: { path: "a.txt", apiKey: "leak" },
      approved: false,
      status: "ok",
    });
    const [rec] = store.list();
    expect(rec?.inputSummary).toEqual({ path: "a.txt" });
  });

  it("a settings store persists roots across a restart", () => {
    const first = new FileSettingsStore(new JsonFileStore(dir, "settings.json"));
    first.patch({ workspaceRoots: [project] });
    const reopened = new FileSettingsStore(new JsonFileStore(dir, "settings.json"));
    expect(reopened.get().workspaceRoots).toEqual([project]);
  });
});
