/**
 * D5 desktop UI tests.
 *
 * Two distinct concerns, both load-bearing:
 *
 *   1. The renderer must actually RUN. D1 shipped a TypeScript file under a
 *      `.js` name, and Chromium transpiles nothing, so the entire page died
 *      with a SyntaxError before a single handler wired up. No test had ever
 *      executed the file — they only read it as text — so the bug lived
 *      through D1-D4. These tests compile it as browser JavaScript.
 *
 *   2. The surface the UI consumes. `listModels` and the workspace roots are
 *      new read-only channels; agent-run cancellation is newly wired through
 *      the desktop's own hub so the pending approval a cancelled run raised is
 *      released (a denial on disposal, never an approval).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, Script } from "node:vm";
import { buildDesktopStack } from "../src/desktop-stack.ts";
import { DesktopFacade } from "../src/facade.ts";
import { MemoryCredentialProvider } from "../src/credentials/memory-credential-provider.ts";
import { IPC_CHANNELS } from "../src/ipc-channels.ts";
import type { AgentRequest, ToolCall } from "../../src/agent/index.ts";

const SRC = join(process.cwd(), "desktop", "src");

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

let dir: string;
let project: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-d5desk-"));
  project = mkdtempSync(join(tmpdir(), "aio-d5desk-proj-"));
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

/** Compiles the renderer as browser JavaScript would: parse, no execution. */
function compileRenderer(): void {
  const src = read(join("renderer", "renderer.js"));
  // A bare `<script>` is a classic script, not a module: compile in a context
  // without import support. A SyntaxError here is exactly the D1 failure mode.
  new Script(src, { filename: "renderer.js" });
}

describe("renderer parses as browser JavaScript (the D1 regression)", () => {
  it("compiles as a classic script", () => {
    expect(() => compileRenderer()).not.toThrow();
  });

  it("contains no TypeScript type annotations", () => {
    const src = read(join("renderer", "renderer.js"));
    // The two D1 offenders were annotation syntax. Plain JS cannot contain
    // these, and Chromium would reject them.
    expect(src).not.toMatch(/\):\s*(?:readonly\s+)?[A-Za-z_$][\w$.<>\[\]|, ]*\s*[{=]/);
    expect(src).not.toMatch(/<T>/);
    expect(src).not.toMatch(/interface\s+\w+/);
    expect(src).not.toMatch(/as\s+const\b/);
  });

  it("executes in a DOM-less sandbox, wiring its handlers and pulling the initial views", async () => {
    // Execute it against a minimal `window`/`document` so we prove the
    // top-level code path (handler wiring + the initial refresh chain) runs
    // rather than merely parsing. The DOM is a stub; the bridge is a proxy
    // that records every view the renderer pulls.
    const src = read(join("renderer", "renderer.js"));
    const calls: string[] = [];

    function fakeEl() {
      const node: Record<string, unknown> = {
        addEventListener: (ev: string) => void calls.push(ev),
        appendChild: () => undefined,
        removeChild: () => undefined,
        remove: () => undefined,
        querySelector: () => fakeEl(),
        querySelectorAll: () => [],
        createElement: () => fakeEl(),
        createTextNode: () => ({ nodeType: 3 }),
        setAttribute: (k: string) => void calls.push("attr:" + k),
        getAttribute: () => null,
        removeAttribute: () => undefined,
        contains: () => false,
        focus: () => undefined,
        blur: () => undefined,
        classList: { add: () => undefined, remove: () => undefined, toggle: () => undefined },
        dataset: {},
        parentNode: null,
        ownerDocument: null,
      };
      Object.defineProperty(node, "firstChild", { get: () => null });
      for (const prop of ["textContent", "innerHTML", "className", "value", "hidden", "disabled", "id", "title", "type", "colSpan", "size", "rows", "scrollTop", "scrollHeight", "href", "parentElement"]) {
        node[prop] = "";
      }
      return node;
    }

    const api = new Proxy(
      {},
      {
        get: (_t, prop: string) => {
          calls.push(prop);
          if (prop === "getSystemStatus") {
            return async () => ({
              egress: { kind: "deny-all" },
              budget: { budgetUsd: 0 },
              approvals: 0,
              runs: 0,
              credentials: [],
            });
          }
          if (prop === "getSelectionPosture") {
            return async () => ({
              egress: "deny-all",
              budgetUsd: 0,
              policy: "FREE_ONLY",
              note: "frozen posture",
            });
          }
          return async () => [];
        },
      },
    );

    const sandbox = {
      window: { allInOne: api },
      document: {
        getElementById: () => fakeEl(),
        createElement: () => fakeEl(),
        createTextNode: () => ({ nodeType: 3 }),
        querySelectorAll: () => [],
        addEventListener: (ev: string) => void calls.push(ev),
        activeElement: null,
        documentElement: fakeEl(),
        body: fakeEl(),
        hidden: false,
      },
      setTimeout: (fn: () => void) => {
        fn();
        return 1;
      },
      setInterval: () => 1,
      clearInterval: () => undefined,
      console,
    };
    createContext(sandbox);
    new Script(src, { filename: "renderer.js" }).runInContext(sandbox as never);
    // Let the async init chain flush.
    await new Promise((r) => setTimeout(r, 50));

    // Interactive handlers were wired before any data arrived.
    expect(calls).toContain("click");
    expect(calls).toContain("change");
    expect(calls).toContain("visibilitychange");
    // The boot chain pulls the settings, the status bar, the pending-approval
    // view and the tool table. The remaining views load lazily when opened, so
    // their bridge calls are asserted statically below.
    expect(calls).toContain("getSettings");
    expect(calls).toContain("getSystemStatus");
    expect(calls).toContain("getSelectionPosture");
    expect(calls).toContain("listPendingToolApprovals");
    expect(calls).toContain("listAgentTools");
    expect(calls).not.toContain("ipcRenderer");
  });

  it("every lazily-loaded view still reaches its data through the bridge", () => {
    const src = read(join("renderer", "renderer.js"));
    for (const call of [
      "listModels",
      "listRuns",
      "getRun",
      "listTools",
      "listToolAudit",
      "listLogs",
      "listWorkspaceRoots",
      "pickWorkspaceRoot",
      "listCredentialNames",
      "getUsageTotals",
      "getBudget",
      "getFrozenDefaults",
      "patchSettings",
    ]) {
      expect(src).toContain("api." + call);
    }
  });
});

describe("renderer isolation contract (kept from D1)", () => {
  const renderer = () => read(join("renderer", "renderer.js"));

  it("reaches the core only through the exposed bridge", () => {
    const src = renderer();
    expect(src).toMatch(/window\.allInOne/);
    expect(src).not.toMatch(/require\(/);
    expect(src).not.toMatch(/import\s+/);
    expect(src).not.toMatch(/ipcRenderer/);
    expect(src).not.toMatch(/node:/);
  });

  it("escapes rendered content to avoid injecting markup", () => {
    expect(renderer()).toContain("function esc(");
  });

  it("the page loads a packaged script, not a remote one", () => {
    const html = read(join("renderer", "index.html"));
    expect(html).toMatch(/<script src="renderer\.js"><\/script>/);
    expect(html).not.toMatch(/https?:\/\//);
    // No inline event handlers: behaviour is attached from the script.
    expect(html).not.toMatch(/\bon\w+\s*=\s*["']/);
  });
});

describe("the new channels are enumerated end to end", () => {
  it("main registers a handler for every channel, including the D5 additions", () => {
    const main = read("main.ts");
    const handled = [...main.matchAll(/ipcMain\.handle\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(handled.sort()).toEqual([...IPC_CHANNELS].sort());
  });

  it("the preload exposes the D5 read-only views", () => {
    const preload = read("preload.cjs");
    expect(preload).toMatch(/listModels:/);
    expect(preload).toMatch(/getSelectionPosture:/);
    expect(preload).toMatch(/listWorkspaceRoots:/);
  });
});

describe("listModels", () => {
  it("returns exactly the three local models, with no secret material", () => {
    const f = stack();
    const models = f.listModels();
    const ids = models.map((m) => m.id).sort();
    expect(ids).toEqual(["local/agent", "local/deterministic", "local/vision"]);
    // The shape is JSON-safe and descriptor-only: no credential, no key.
    const json = JSON.stringify(models);
    expect(json).not.toMatch(/secret|password|apiKey|token/i);
  });

  it("every entry is local and free, and the posture explains why", () => {
    const f = stack();
    for (const m of f.listModels()) {
      expect(m.locality).toBe("local");
      expect(m.costClass).toBe("FREE");
    }
    const posture = f.selectionPosture();
    expect(posture.egress).toBe("deny-all");
    expect(posture.budgetUsd).toBe(0);
    expect(posture.policy).toBe("FREE_ONLY");
    expect(posture.note.length).toBeGreaterThan(0);
  });
});

describe("workspace roots channel data", () => {
  it("lists the roots the settings hold", () => {
    const f = stack();
    expect(f.listWorkspaceRoots()).toEqual([project]);
  });

  it("is empty until the user opens a directory", () => {
    const s = buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() });
    expect(new DesktopFacade(s).listWorkspaceRoots()).toEqual([]);
  });
});

describe("agent cancellation releases the pending approval", () => {
  it("a cancelled run settles as cancelled and denies its pending request", async () => {
    const f = stack();
    writeFileSync(join(project, "a.txt"), "orig");
    const invocation = f.runAgent({
      runId: "d5-cancel",
      prompt: withToolCalls(
        [{ id: "1", toolName: "files.write", input: { path: join(project, "a.txt"), content: "no" } }],
        "rewrite it",
      ),
      mode: "BUILD",
    });
    // Let the privileged call reach the human gate.
    await new Promise((r) => setTimeout(r, 80));
    const pending = f.listPendingToolApprovals();
    expect(pending).toHaveLength(1);

    // The human cancels the run instead of answering.
    expect(f.cancelRun("d5-cancel")).toBe(true);
    const out = await invocation;

    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe("AGENT_CANCELLED");
    // Nothing was written.
    expect(readFileSync(join(project, "a.txt"), "utf8")).toBe("orig");
    // The request the run raised is no longer awaiting an answer, and it was
    // never approved — disposal is a denial.
    expect(f.listPendingToolApprovals()).toHaveLength(0);
    const resolved = f.listToolApprovals().filter((a) => a.id === pending[0]!.id);
    expect(resolved[0]?.status).toBe("denied");
  });

  it("cancellation denies only this run's request; another run's stays pending", async () => {
    const f = stack();
    writeFileSync(join(project, "a.txt"), "orig");
    writeFileSync(join(project, "b.txt"), "orig");

    const a = f.runAgent({
      runId: "d5-run-a",
      prompt: withToolCalls(
        [{ id: "1", toolName: "files.write", input: { path: join(project, "a.txt"), content: "no" } }],
        "rewrite a",
      ),
      mode: "BUILD",
    });
    const b = f.runAgent({
      runId: "d5-run-b",
      prompt: withToolCalls(
        [{ id: "1", toolName: "files.write", input: { path: join(project, "b.txt"), content: "no" } }],
        "rewrite b",
      ),
      mode: "BUILD",
    });

    // Let both reach their human gates.
    await new Promise((r) => setTimeout(r, 100));
    const pending = f.listPendingToolApprovals();
    expect(pending).toHaveLength(2);
    const byRun = new Map(pending.map((p) => [p.runId, p]));

    // The human cancels A only.
    expect(f.cancelRun("d5-run-a")).toBe(true);
    const aOut = await a;
    expect(aOut.error?.code).toBe("AGENT_CANCELLED");
    expect(readFileSync(join(project, "a.txt"), "utf8")).toBe("orig");
    // A's request was denied on disposal, never approved.
    const aApproval = f.listToolApprovals().find((x) => x.id === byRun.get("d5-run-a")!.id);
    expect(aApproval?.status).toBe("denied");

    // B is untouched and still waiting for its own decision.
    const stillPending = f.listPendingToolApprovals();
    expect(stillPending).toHaveLength(1);
    expect(stillPending[0]?.runId).toBe("d5-run-b");

    // The human then answers B normally, and it is honoured.
    f.denyTool(stillPending[0]!.id, "no");
    const bOut = await b;
    expect(bOut.outcomes[0]?.code).toBe("TOOL_APPROVAL_DENIED");
    expect(readFileSync(join(project, "b.txt"), "utf8")).toBe("orig");
  });
});

describe("the UI approve/deny path", () => {
  it("approve proceeds and is audited; deny leaves the file untouched", async () => {
    const f = stack();
    writeFileSync(join(project, "a.txt"), "orig");

    // Approve path.
    const approved = await runApproving(f, {
      runId: "d5-approve",
      prompt: withToolCalls(
        [{ id: "1", toolName: "files.write", input: { path: join(project, "a.txt"), content: "clobbered" }, justification: "refreshing" }],
        "rewrite it",
      ),
      mode: "BUILD",
    });
    expect(approved.outcomes[0]?.ok).toBe(true);
    expect(approved.outcomes[0]?.approved).toBe(true);
    expect(readFileSync(join(project, "a.txt"), "utf8")).toBe("clobbered");
    const auditOk = f.listToolAudit().find((a) => a.toolName === "files.write" && a.status === "ok");
    expect(auditOk?.justification).toBe("refreshing");
    expect(auditOk?.approved).toBe(true);

    // Deny path.
    writeFileSync(join(project, "b.txt"), "orig");
    const invocation = f.runAgent({
      runId: "d5-deny",
      prompt: withToolCalls(
        [{ id: "1", toolName: "files.write", input: { path: join(project, "b.txt"), content: "no" } }],
        "rewrite it",
      ),
      mode: "BUILD",
    });
    await new Promise((r) => setTimeout(r, 80));
    const [pending] = f.listPendingToolApprovals();
    expect(pending).toBeDefined();
    expect(f.denyTool(pending!.id, "not needed")).toBe(true);
    const denied = await invocation;
    expect(denied.outcomes[0]?.ok).toBe(false);
    expect(denied.outcomes[0]?.code).toBe("TOOL_APPROVAL_DENIED");
    expect(readFileSync(join(project, "b.txt"), "utf8")).toBe("orig");
  });
});

describe("mode narrowing as the UI renders it", () => {
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
