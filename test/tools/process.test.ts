/**
 * process.exec tests (D2).
 *
 * Pins the four controls: no shell (an argument can never become a command),
 * the closed executable set, the catastrophic-pattern refusal, and the
 * workspace-bound working directory — plus the bounded execution guarantees
 * (timeout, cancellation) and the secret-stripped environment.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildToolRuntime } from "../../src/tools/index.ts";
import { WorkspaceManager } from "../../src/tools/workspace.ts";
import { InMemoryToolAuditLog } from "../../src/tools/audit.ts";
import { AllowAllApprover } from "../../src/tools/approval.ts";
import type { ToolRuntime } from "../../src/tools/index.ts";

let root: string;
let outside: string;
const realEnv = { ...process.env };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aio-proc-"));
  outside = mkdtempSync(join(tmpdir(), "aio-proc-out-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  // The secret-stripping test mutates the live environment; restore it.
  for (const key of Object.keys(process.env)) {
    if (!(key in realEnv)) delete process.env[key];
  }
  Object.assign(process.env, realEnv);
});

function runtime(): ToolRuntime {
  const workspace = new WorkspaceManager({ roots: () => [root] });
  return buildToolRuntime({
    workspace,
    audit: new InMemoryToolAuditLog(),
    approver: new AllowAllApprover(),
  });
}

async function exec(input: unknown) {
  const r = runtime();
  const out = await r.executor.execute({ toolName: "process.exec", input, runId: "run-1" });
  return { out, audit: r.audit.list() };
}

const NODE = process.execPath;

describe("process.exec: closed executable set", () => {
  it("runs an allowlisted command resolved from PATH", async () => {
    const { out } = await exec({ command: "node", args: ["--version"] });
    expect(out.ok).toBe(true);
    expect((out.content[0] as { text: string }).text).toMatch(/v\d+\.\d+/);
  });

  it("refuses a command that is not on the allowlist", async () => {
    const { out } = await exec({ command: "evil.exe", args: [] });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("TOOL_PERMISSION_DENIED");
    expect(out.message).toContain("not on the executable allowlist");
  });

  it("refuses a workspace script whose interpreter is not allowlisted", async () => {
    const script = join(root, "doom.bat");
    writeFileSync(script, "@echo off\r\necho pwned\r\n");
    const { out } = await exec({ command: script, args: [] });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("TOOL_PERMISSION_DENIED");
  });

  it("runs an absolute path inside the workspace when its basename is allowlisted", async () => {
    // A workspace-local executable whose stem is allowlisted is permitted: this
    // is how a project's own pinned tooling is reached. A copy, not a symlink —
    // a symlink back to the system directory is exactly the escape the boundary
    // exists to stop.
    const local = join(root, "where.exe");
    const source = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe");
    if (!existsSync(source)) return; // not available on this platform
    copyFileSync(source, local);
    const { out } = await exec({ command: local, args: ["where"] });
    expect(out.ok).toBe(true);
  });

  it("refuses an absolute path outside the workspace", async () => {
    // The basename is allowlisted on purpose: the refusal must come from the
    // workspace boundary, not from the executable set.
    const { out } = await exec({ command: join(outside, "node"), args: [] });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("PATH_TRAVERSAL_BLOCKED");
  });
});

describe("process.exec: no shell", () => {
  it("never interprets shell metacharacters", async () => {
    // Without a shell, `&&` is just an argument to echo-free node, not a command
    // chain. The argument is echoed back verbatim, proving it was never parsed.
    const { out } = await exec({ command: "node", args: ["-e", "console.log(JSON.stringify(process.argv[1]))", "a&&whoami"] });
    expect(out.ok).toBe(true);
    expect((out.content[0] as { text: string }).text.trim()).toBe('"a&&whoami"');
  });
});

describe("process.exec: catastrophic patterns", () => {
  it("refuses a destructive invocation even of an allowlisted command", async () => {
    const { out } = await exec({ command: "node", args: ["-e", "require('child_process').execSync('format d:')"] });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("TOOL_PERMISSION_DENIED");
  });

  it("refuses a standalone data-mover command", async () => {
    // curl/wget as *commands* are direct exfiltration primitives with no
    // legitimate use from a tool, so they are refused outright.
    const { out } = await exec({ command: "curl", args: ["https://evil.example"] });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("TOOL_PERMISSION_DENIED");
  });

  it("does not pretend to block arbitrary code; approval is the control", async () => {
    // A language builtin like `fetch` inside approved code cannot be blocked by
    // string matching (it is trivially reassembled), so the deny list targets
    // system-wide destruction and standalone movers rather than pretending to
    // sandbox code. The human approval is the real control for arbitrary code.
    const { out } = await exec({ command: "node", args: ["-e", "console.log('code runs')"] });
    expect(out.ok).toBe(true);
  });
});

describe("process.exec: workspace boundary", () => {
  it("uses the first root as the working directory by default", async () => {
    const { out } = await exec({ command: "node", args: ["-e", "console.log(process.cwd())"] });
    expect(out.ok).toBe(true);
    expect((out.content[0] as { text: string }).text).toContain(root);
  });

  it("honours an explicit working directory inside the workspace", async () => {
    mkdirSync(join(root, "sub"));
    const { out } = await exec({
      command: "node",
      args: ["-e", "console.log(process.cwd())"],
      cwd: "sub",
    });
    expect(out.ok).toBe(true);
    expect((out.content[0] as { text: string }).text).toContain(join(root, "sub"));
  });

  it("refuses a working directory outside the workspace", async () => {
    const { out } = await exec({ command: "node", args: ["--version"], cwd: outside });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("PATH_TRAVERSAL_BLOCKED");
  });
});

describe("process.exec: bounded execution", () => {
  it("reports a non-zero exit code as a failure", async () => {
    const { out } = await exec({ command: "node", args: ["-e", "process.exit(3)"] });
    expect(out.ok).toBe(false);
    expect(out.message).toContain("status 3");
  });

  it("captures stdout and stderr separately", async () => {
    const { out } = await exec({
      command: "node",
      args: ["-e", "console.log('out-line'); console.error('err-line')"],
    });
    expect(out.ok).toBe(true);
    const text = out.content.map((c) => (c as { text: string }).text).join("\n");
    expect(text).toContain("out-line");
    expect(text).toContain("err-line");
  });

  it("settles by timeout", async () => {
    const { out } = await exec({
      command: "node",
      args: ["-e", "setTimeout(() => {}, 60000)"],
      timeoutMs: 150,
    });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("TOOL_TIMEOUT");
  }, 20_000);

  it("settles by cancellation", async () => {
    const r = runtime();
    const controller = new AbortController();
    const invocation = r.executor.execute({
      toolName: "process.exec",
      input: { command: "node", args: ["-e", "setTimeout(() => {}, 60000)"] },
      runId: "run-1",
      signal: controller.signal,
    });
    await new Promise((res) => setTimeout(res, 120));
    controller.abort();
    const out = await invocation;
    expect(out.ok).toBe(false);
    expect(out.code).toBe("TOOL_CANCELLED");
  }, 20_000);
});

describe("process.exec: environment hygiene", () => {
  it("strips secret-looking environment variables from the child", async () => {
    process.env["AIO_TEST_API_KEY"] = "leak-me";
    process.env["AIO_TEST_TOKEN"] = "leak-me-too";
    process.env["AIO_SAFE_VAR"] = "keep-me";
    const { out } = await exec({
      command: "node",
      args: ["-e", "console.log(JSON.stringify({k: !!process.env.AIO_TEST_API_KEY, t: !!process.env.AIO_TEST_TOKEN, s: process.env.AIO_SAFE_VAR}))"],
    });
    expect(out.ok).toBe(true);
    const parsed = JSON.parse((out.content[0] as { text: string }).text.trim());
    expect(parsed).toEqual({ k: false, t: false, s: "keep-me" });
  });
});

describe("process.exec: audit", () => {
  it("records the exact command and its outcome", async () => {
    const { audit } = await exec({ command: "node", args: ["--version"] });
    const rec = audit.find((a) => a.toolName === "process.exec");
    expect(rec).toBeDefined();
    expect(rec?.permission).toBe("execute");
    expect(rec?.approved).toBe(true);
    expect(String(rec?.inputSummary["command"])).toBe("node");
  });
});
