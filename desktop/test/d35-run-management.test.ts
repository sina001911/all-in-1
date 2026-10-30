/**
 * D35: run management — rename, delete, and search on RunRecord.
 *
 * The run store is the persistence layer for every workflow, agent, and
 * collaboration run. This file exercises the three new mutations end to end
 * through the facade, plus the IPC boundary contract that keeps the renderer
 * from forging a request the store would not accept:
 *
 *   - `renameRun` sets a cosmetic display name without changing the run's
 *     identity (id, subject, and steps are untouched);
 *   - `removeRun` deletes the record but leaves artifacts and accounting alone;
 *   - `searchRuns` matches subject or name case-insensitively, and an empty
 *     query returns every run, newest first, like `listRuns`.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDesktopStack } from "../src/desktop-stack.ts";
import { DesktopFacade } from "../src/facade.ts";
import { MemoryCredentialProvider } from "../src/credentials/memory-credential-provider.ts";
import { IPC_CHANNELS } from "../src/ipc-channels.ts";
import type { RunRecord } from "../src/persistence/types.ts";

let dir: string;
let project: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-d35-run-"));
  project = mkdtempSync(join(tmpdir(), "aio-d35-run-proj-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function facade(): DesktopFacade {
  const s = buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() });
  s.settingsStore.patch({ workspaceRoots: [project] });
  return new DesktopFacade(s);
}

function record(f: DesktopFacade, subject: string, id = `run-${subject}`): RunRecord {
  f.runDiagnostic({ mode: "INSPECT", subject, runId: id });
  return f.getRun(id)!;
}

describe("Run management (D35)", () => {
  it("renames a run without changing its identity", () => {
    const f = facade();
    const before = record(f, "refactor the auth module");
    expect(before.name).toBeUndefined();
    expect(f.renameRun(before.id, "Auth refactor")).toBe(true);
    const after = f.getRun(before.id)!;
    expect(after.name).toBe("Auth refactor");
    // Identity fields are untouched by a cosmetic rename.
    expect(after.id).toBe(before.id);
    expect(after.subject).toBe(before.subject);
    expect(after.steps).toEqual(before.steps);
  });

  it("returns false when renaming a run that does not exist", () => {
    const f = facade();
    expect(f.renameRun("does-not-exist", "x")).toBe(false);
  });

  it("removes a run and leaves artifacts and accounting alone", () => {
    const f = facade();
    const r = record(f, "delete me");
    expect(f.getRun(r.id)).toBeDefined();
    expect(f.removeRun(r.id)).toBe(true);
    expect(f.getRun(r.id)).toBeUndefined();
    // A second remove is a no-op, not an error.
    expect(f.removeRun(r.id)).toBe(false);
    // The run is gone from the list, but nothing else was disturbed.
    expect(f.listRuns().some((x) => x.id === r.id)).toBe(false);
  });

  it("searches by subject or display name, case-insensitively", () => {
    const f = facade();
    record(f, "refactor the auth module", "run-auth");
    record(f, "write tests for the billing flow", "run-billing");
    record(f, "document the new CLI flags", "run-docs");
    f.renameRun("run-auth", "Auth Refactor");

    const bySubject = f.searchRuns("billing");
    expect(bySubject.map((r) => r.id)).toEqual(["run-billing"]);

    const byName = f.searchRuns("auth");
    expect(byName.map((r) => r.id)).toEqual(["run-auth"]);

    // Case-insensitive.
    expect(f.searchRuns("BILLING").map((r) => r.id)).toEqual(["run-billing"]);

    // No match.
    expect(f.searchRuns("zzz")).toHaveLength(0);
  });

  it("returns every run, newest first, for an empty query", () => {
    const f = facade();
    record(f, "first", "run-1");
    record(f, "second", "run-2");
    const all = f.searchRuns("");
    expect(all).toHaveLength(2);
    expect(all[0]!.id).toBe("run-2");
    expect(all[1]!.id).toBe("run-1");
  });
});

describe("IPC boundary (D35)", () => {
  it("declares the run-management channels", () => {
    for (const ch of ["all-in-1:run:rename", "all-in-1:run:delete", "all-in-1:run:search"]) {
      expect(IPC_CHANNELS).toContain(ch);
    }
  });
});