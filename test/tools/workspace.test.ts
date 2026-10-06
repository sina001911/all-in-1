/**
 * Workspace boundary tests (D2).
 *
 * The boundary is the only thing standing between an untrusted model and the
 * filesystem, so each escape vector is pinned explicitly: lexical traversal,
 * absolute escapes, symlink escapes, application-owned deny paths, and writes
 * into a non-writable root.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../../src/tools/workspace.ts";
import { AllInOneError } from "../../src/errors.ts";

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aio-ws-"));
  outside = mkdtempSync(join(tmpdir(), "aio-ws-out-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function ws(opts?: {
  writableRoots?: () => readonly string[];
  denyPaths?: () => readonly string[];
}): WorkspaceManager {
  return new WorkspaceManager({
    roots: () => [root],
    writableRoots: opts?.writableRoots ?? (() => [root]),
    denyPaths: opts?.denyPaths ?? (() => []),
  });
}

describe("workspace: lexical containment", () => {
  it("accepts an absolute path inside a root", () => {
    const p = join(root, "src", "a.ts");
    expect(ws().resolveRead(p)).toBe(p);
  });

  it("anchors a relative path at the first root", () => {
    expect(ws().resolveRead(join("src", "a.ts"))).toBe(join(root, "src", "a.ts"));
  });

  it("rejects a parent traversal", () => {
    expect(() => ws().resolveRead(join(root, "..", "outside.txt"))).toThrow(AllInOneError);
    expect(() => ws().resolveRead("../../etc/passwd")).toThrow(/outside every workspace root/);
  });

  it("rejects an absolute path outside every root", () => {
    expect(() => ws().resolveRead(join(outside, "x.txt"))).toThrow(/outside every workspace root/);
  });

  it("rejects an empty path", () => {
    expect(() => ws().resolveRead("")).toThrow(/must not be empty/);
  });

  it("refuses every access when no root is configured", () => {
    const empty = new WorkspaceManager({ roots: () => [] });
    expect(() => empty.resolveRead(join(root, "x"))).toThrow(/No workspace root is configured/);
  });
});

describe("workspace: deny paths", () => {
  it("refuses an application-owned path even inside a root", () => {
    const dataDir = join(root, ".all-in-1");
    mkdirSync(dataDir, { recursive: true });
    const manager = ws({ denyPaths: () => [dataDir] });
    expect(() => manager.resolveRead(join(dataDir, "credentials.json"))).toThrow(
      /application-owned path is denied/,
    );
    expect(() => manager.resolveWrite(join(dataDir, "runs.json"))).toThrow(
      /application-owned path is denied/,
    );
  });

  it("still allows sibling paths in the root", () => {
    const dataDir = join(root, ".all-in-1");
    mkdirSync(dataDir, { recursive: true });
    const manager = ws({ denyPaths: () => [dataDir] });
    expect(manager.resolveRead(join(root, "src", "a.ts"))).toBe(join(root, "src", "a.ts"));
  });
});

describe("workspace: writable roots", () => {
  it("allows a write inside a writable root", () => {
    expect(ws().resolveWrite(join(root, "out.txt"))).toBe(join(root, "out.txt"));
  });

  it("refuses a write into a root that is not writable", () => {
    const other = mkdtempSync(join(tmpdir(), "aio-ws-ro-"));
    try {
      const manager = new WorkspaceManager({
        roots: () => [root, other],
        writableRoots: () => [root],
      });
      expect(() => manager.resolveWrite(join(other, "out.txt"))).toThrow(/not inside a writable workspace root/);
      // reads from the same root are still fine
      expect(manager.resolveRead(join(other, "in.txt"))).toBe(join(other, "in.txt"));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("workspace: symlink escapes", () => {
  const canSymlink = (() => {
    try {
      const probe = join(tmpdir(), `aio-symlink-probe-${Date.now()}`);
      symlinkSync(tmpdir(), probe);
      rmSync(probe);
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!canSymlink)("rejects a symlink that points outside the workspace", () => {
    const link = join(root, "link");
    symlinkSync(outside, link);
    writeFileSync(join(outside, "secret.txt"), "secret");
    expect(() => ws().resolveRead(join(link, "secret.txt"))).toThrow(/escapes the workspace via a symlink/);
  });

  it.skipIf(!canSymlink)("allows a symlink that stays inside the workspace", () => {
    mkdirSync(join(root, "real"), { recursive: true });
    writeFileSync(join(root, "real", "a.ts"), "x");
    symlinkSync(join(root, "real"), join(root, "link"));
    expect(ws().resolveRead(join(root, "link", "a.ts"))).toBe(join(root, "link", "a.ts"));
  });

  it.skipIf(!canSymlink)("rejects a symlinked parent for a write", () => {
    symlinkSync(outside, join(root, "outlink"));
    expect(() => ws().resolveWrite(join(root, "outlink", "new.txt"))).toThrow(/escapes the workspace/);
  });
});

describe("workspace: inspection", () => {
  it("lists roots and reports the read ceiling", () => {
    const manager = new WorkspaceManager({ roots: () => [root], maxReadBytes: 2048 });
    expect(manager.listRoots()).toEqual([root]);
    expect(manager.maxReadBytes).toBe(2048);
  });

  it("answers isInside without throwing", () => {
    const manager = ws();
    expect(manager.isInside(join(root, "a.ts"))).toBe(true);
    expect(manager.isInside(join(outside, "a.ts"))).toBe(false);
  });
});
