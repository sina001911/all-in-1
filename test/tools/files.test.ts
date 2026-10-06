/**
 * File tool tests (D2).
 *
 * Exercises the six filesystem tools through the executor, so every result also
 * proves the boundary, the permission class, and the audit path. The workspace
 * is a temp directory; an `outside` directory exists to prove no tool can reach
 * it.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildToolRuntime } from "../../src/tools/index.ts";
import { WorkspaceManager } from "../../src/tools/workspace.ts";
import { InMemoryToolAuditLog } from "../../src/tools/audit.ts";
import { AllowAllApprover } from "../../src/tools/approval.ts";
import type { ToolRuntime } from "../../src/tools/index.ts";

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aio-files-"));
  outside = mkdtempSync(join(tmpdir(), "aio-files-out-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function runtime(): ToolRuntime {
  const workspace = new WorkspaceManager({ roots: () => [root] });
  return buildToolRuntime({
    workspace,
    audit: new InMemoryToolAuditLog(),
    approver: new AllowAllApprover(),
  });
}

async function run(toolName: string, input: unknown, mode?: "INSPECT" | "BUILD") {
  const r = runtime();
  const out = await r.executor.execute({ toolName, input, runId: "run-1", mode });
  return { out, audit: r.audit.list() };
}

describe("files.read", () => {
  it("reads a file inside the workspace", async () => {
    const p = join(root, "a.txt");
    writeFileSync(p, "hello\nworld");
    const { out } = await run("files.read", { path: p });
    expect(out.ok).toBe(true);
    expect(out.content[0]).toMatchObject({ type: "text", text: "hello\nworld" });
  });

  it("accepts a workspace-relative path", async () => {
    writeFileSync(join(root, "a.txt"), "rel");
    const { out } = await run("files.read", { path: "a.txt" });
    expect(out.ok).toBe(true);
    expect((out.content[0] as { text: string }).text).toBe("rel");
  });

  it("reports truncation when the byte ceiling is exceeded", async () => {
    writeFileSync(join(root, "big.txt"), "x".repeat(300));
    const { out } = await run("files.read", { path: "big.txt", maxBytes: 50 });
    expect(out.ok).toBe(true);
    expect((out.metadata as { truncated: boolean }).truncated).toBe(true);
    expect((out.content[0] as { text: string }).text.length).toBeLessThanOrEqual(50);
  });

  it("honours line offset and limit", async () => {
    writeFileSync(join(root, "lines.txt"), "one\ntwo\nthree\nfour");
    const { out } = await run("files.read", { path: "lines.txt", offsetLine: 2, limitLines: 2 });
    expect((out.content[0] as { text: string }).text).toBe("two\nthree");
  });

  it("reads base64 for binary content", async () => {
    writeFileSync(join(root, "b.bin"), Buffer.from([0x00, 0xff, 0x10]));
    const { out } = await run("files.read", { path: "b.bin", encoding: "base64" });
    expect((out.content[0] as { text: string }).text).toBe(Buffer.from([0x00, 0xff, 0x10]).toString("base64"));
  });

  it("refuses to read outside the workspace", async () => {
    writeFileSync(join(outside, "x.txt"), "secret");
    const { out } = await run("files.read", { path: join(outside, "x.txt") });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("PATH_TRAVERSAL_BLOCKED");
  });

  it("fails on a missing file rather than creating one", async () => {
    const { out } = await run("files.read", { path: "nope.txt" });
    expect(out.ok).toBe(false);
  });
});

describe("files.list", () => {
  it("lists entries with kinds and sizes", async () => {
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "a.txt"), "abc");
    const { out } = await run("files.list", { path: "." });
    expect(out.ok).toBe(true);
    const json = (out.content[0] as { json: { entries: { name: string; kind: string }[] } }).json;
    const names = json.entries.map((e) => `${e.name}:${e.kind}`).sort();
    expect(names).toEqual(["a.txt:file", "sub:dir"]);
  });

  it("filters by a name pattern", async () => {
    writeFileSync(join(root, "a.ts"), "x");
    writeFileSync(join(root, "b.js"), "x");
    const { out } = await run("files.list", { path: ".", pattern: "\\.ts$" });
    const json = (out.content[0] as { json: { entries: { name: string }[] } }).json;
    expect(json.entries.map((e) => e.name)).toEqual(["a.ts"]);
  });

  it("reports an invalid pattern as a validation failure", async () => {
    const { out } = await run("files.list", { path: ".", pattern: "(" });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("TOOL_VALIDATION_FAILED");
  });
});

describe("files.search", () => {
  it("finds matches with line numbers", async () => {
    writeFileSync(join(root, "a.txt"), "alpha\nbeta\ngamma\nbeta");
    const { out } = await run("files.search", { path: ".", pattern: "beta" });
    expect(out.ok).toBe(true);
    const json = (out.content[0] as { json: { hits: { line: number; path: string }[] } }).json;
    expect(json.hits.map((h) => h.line)).toEqual([2, 4]);
  });

  it("skips binary files", async () => {
    writeFileSync(join(root, "bin.dat"), Buffer.from([0x00, 0x01, 0x02]));
    writeFileSync(join(root, "a.txt"), "target");
    const { out } = await run("files.search", { path: ".", pattern: "target" });
    const json = (out.content[0] as { json: { hits: { path: string }[] } }).json;
    expect(json.hits).toHaveLength(1);
  });

  it("caps the number of results", async () => {
    writeFileSync(join(root, "a.txt"), Array(20).fill("match").join("\n"));
    const { out } = await run("files.search", { path: ".", pattern: "match", maxResults: 3 });
    const json = (out.content[0] as { json: { hits: unknown[]; truncated: boolean } }).json;
    expect(json.hits).toHaveLength(3);
    expect(json.truncated).toBe(true);
  });

  it("does not follow a symlink outside the workspace", async () => {
    const canSymlink = (() => {
      try {
        symlinkSync(outside, join(root, "link"));
        return true;
      } catch {
        return false;
      }
    })();
    if (!canSymlink) return;
    writeFileSync(join(outside, "secret.txt"), "target");
    const { out } = await run("files.search", { path: ".", pattern: "target" });
    expect(out.ok).toBe(true);
    const json = (out.content[0] as { json: { hits: { path: string }[] } }).json;
    expect(json.hits.map((h) => h.path)).not.toContain(join(outside, "secret.txt"));
  });
});

describe("files.write", () => {
  it("writes a new file inside the workspace", async () => {
    const { out } = await run("files.write", { path: "out.txt", content: "written" });
    expect(out.ok).toBe(true);
    expect(readFileSync(join(root, "out.txt"), "utf8")).toBe("written");
  });

  it("creates missing parent directories when asked", async () => {
    const { out } = await run("files.write", { path: join("a", "b", "c.txt"), content: "x", createDirs: true });
    expect(out.ok).toBe(true);
    expect(readFileSync(join(root, "a", "b", "c.txt"), "utf8")).toBe("x");
  });

  it("refuses to write outside the workspace", async () => {
    const { out } = await run("files.write", { path: join(outside, "x.txt"), content: "x" });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("PATH_TRAVERSAL_BLOCKED");
  });

  it("refuses an oversized write", async () => {
    const { out } = await run("files.write", { path: "big.txt", content: "x".repeat(5 * 1024 * 1024) });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("TOOL_LIMIT_EXCEEDED");
  });

  it("is gated by the mode, not just the approval", async () => {
    const { out } = await run("files.write", { path: "out.txt", content: "x" }, "INSPECT");
    expect(out.ok).toBe(false);
    expect(out.code).toBe("MODE_VIOLATION");
  });
});

describe("files.edit", () => {
  it("replaces a unique occurrence and returns a diff", async () => {
    const p = join(root, "a.txt");
    writeFileSync(p, "one\ntwo\nthree");
    const { out } = await run("files.edit", { path: p, oldString: "two", newString: "TWO" });
    expect(out.ok).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("one\nTWO\nthree");
    const diff = out.content[0];
    expect(diff?.type).toBe("diff");
    expect((diff as { diff: string }).diff).toContain("-two");
    expect((diff as { diff: string }).diff).toContain("+TWO");
  });

  it("refuses an ambiguous occurrence without replaceAll", async () => {
    const p = join(root, "a.txt");
    writeFileSync(p, "dup\ndup");
    const { out } = await run("files.edit", { path: p, oldString: "dup", newString: "x" });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("TOOL_EXECUTION_FAILED");
    expect(out.message).toContain("2 times");
  });

  it("replaces every occurrence with replaceAll", async () => {
    const p = join(root, "a.txt");
    writeFileSync(p, "dup\ndup");
    const { out } = await run("files.edit", { path: p, oldString: "dup", newString: "x", replaceAll: true });
    expect(out.ok).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("x\nx");
  });

  it("refuses an identical replacement", async () => {
    const p = join(root, "a.txt");
    writeFileSync(p, "same");
    const { out } = await run("files.edit", { path: p, oldString: "same", newString: "same" });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("TOOL_VALIDATION_FAILED");
  });
});

describe("files.patch", () => {
  it("inserts, replaces, and deletes lines", async () => {
    const p = join(root, "a.txt");
    writeFileSync(p, "one\ntwo\nthree");
    // Addresses refer to the ORIGINAL file: ops are applied highest line first,
    // so a lower-line insert never shifts a higher op's target.
    const { out } = await run("files.patch", {
      path: p,
      ops: [
        { type: "insert", lineNumber: 1, text: "zero" },
        { type: "replace", lineNumber: 2, text: "TWO" },
        { type: "delete", lineNumber: 3 },
      ],
    });
    expect(out.ok).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("zero\none\nTWO");
  });

  it("refuses an op addressed past the end of the file", async () => {
    const p = join(root, "a.txt");
    writeFileSync(p, "one");
    const { out } = await run("files.patch", { path: p, ops: [{ type: "delete", lineNumber: 9 }] });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("TOOL_EXECUTION_FAILED");
  });

  it("refuses a replace op without text", async () => {
    const p = join(root, "a.txt");
    writeFileSync(p, "one");
    const { out } = await run("files.patch", { path: p, ops: [{ type: "replace", lineNumber: 1 }] });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("TOOL_VALIDATION_FAILED");
  });
});

describe("audit trail across file tools", () => {
  it("records every invocation with its permission class", async () => {
    const r = runtime();
    await r.executor.execute({ toolName: "files.list", input: { path: "." }, runId: "r" });
    await r.executor.execute({ toolName: "files.write", input: { path: "a.txt", content: "x" }, runId: "r" });
    const records = r.audit.list();
    expect(records.find((a) => a.toolName === "files.list")?.permission).toBe("read");
    const writeRecs = records.filter((a) => a.toolName === "files.write");
    expect(writeRecs.every((a) => a.approved)).toBe(true);
    expect(writeRecs.some((a) => a.status === "ok")).toBe(true);
  });
});
