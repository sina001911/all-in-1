/**
 * D1 facade tests.
 *
 * Proves the DesktopFacade drives the full 7-gate pipeline standalone, records
 * runs and usage, persists across a restart, and exposes no value-bearing
 * credential method.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDesktopStack } from "../src/desktop-stack.ts";
import { DesktopFacade } from "../src/facade.ts";
import { MemoryCredentialProvider } from "../src/credentials/memory-credential-provider.ts";
import { buildDesktopStack as rebuild } from "../src/desktop-stack.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-facade-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function facade(): DesktopFacade {
  return new DesktopFacade(
    buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() }),
  );
}

describe("facade: diagnostic pipeline", () => {
  it("runs INSPECT through the full pipeline and records the run", async () => {
    const f = facade();
    const r = await f.runDiagnostic({ mode: "INSPECT", subject: "the login flow" });
    expect(r.ok).toBe(true);
    expect(r.mode).toBe("INSPECT");
    expect(r.text).toContain("the login flow");
    expect(r.text).toContain("INSPECT");
    expect(r.text).toContain("egress deny-all");
    expect(r.iterations).toBe(1);

    const stored = f.getRun(r.runId);
    expect(stored?.status).toBe("completed");
    expect(stored?.ok).toBe(true);
    expect(stored?.deliverable).toContain("the login flow");
  });

  it("records structured usage for the run", async () => {
    const f = facade();
    const r = await f.runDiagnostic({ mode: "INSPECT", subject: "x" });
    const usage = f.listUsage();
    expect(usage).toHaveLength(1);
    expect(usage[0]?.runId).toBe(r.runId);
    expect(usage[0]?.costUsd).toBe(0); // deterministic local adapter: genuinely zero
    expect(usage[0]?.outcome).toBe("ok");
    expect(f.getUsageTotals().invocations).toBe(1);
  });

  it("refuses planning in INSPECT with MODE_VIOLATION", async () => {
    const r = await facade().runDiagnostic({ mode: "INSPECT", subject: "x", plan: true });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("MODE_VIOLATION");
  });

  it("produces a plan in SUGGEST without any edit surface", async () => {
    const r = await facade().runDiagnostic({ mode: "SUGGEST", subject: "the retry policy" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("plan:");
    expect(r.text).not.toContain("never writes files");
  });

  it("caps --auto at the frozen iteration limit", async () => {
    const r = await facade().runDiagnostic({
      mode: "BUILD",
      subject: "x",
      auto: true,
      steps: ["CODE_REVIEWER", "DEEP_REASONING", "CODING_ASSISTANT", "FAST_TASK", "CODE_REVIEWER", "DEEP_REASONING"],
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("WORKFLOW_AUTO_LIMIT");
  });

  it("runs a named specialist by role through the same gates", async () => {
    const r = await facade().runDiagnostic({
      mode: "INSPECT",
      subject: "check the handler",
      steps: ["CODE_REVIEWER"],
    });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("[CODE_REVIEWER]");
  });

  it("cancels a run that has not been started", () => {
    expect(facade().cancelRun("nope")).toBe(false);
  });
});

describe("facade: persistence across restart", () => {
  it("restores runs, usage, and approvals on re-open", async () => {
    const f1 = facade();
    const r = await f1.runDiagnostic({ mode: "INSPECT", subject: "persisted run" });
    f1.grantApproval({ modelId: "openrouter/coding", scope: "session", grantedAt: 7 });

    // A fresh stack on the same directory simulates a restart.
    const f2 = new DesktopFacade(
      rebuild({ baseDir: dir, credentials: new MemoryCredentialProvider() }),
    );
    expect(f2.listRuns().map((x) => x.id)).toContain(r.runId);
    expect(f2.getRun(r.runId)?.subject).toBe("persisted run");
    expect(f2.listUsage()).toHaveLength(1);
    expect(f2.listApprovals().map((a) => a.modelId)).toContain("openrouter/coding");
  });

  it("persists settings patches", () => {
    const f1 = facade();
    f1.patchSettings({ theme: "dark", workspaceRoots: [join(dir, "proj")] });
    const f2 = new DesktopFacade(
      rebuild({ baseDir: dir, credentials: new MemoryCredentialProvider() }),
    );
    expect(f2.getSettings().theme).toBe("dark");
    expect(f2.getSettings().workspaceRoots).toEqual([join(dir, "proj")]);
  });
});

describe("facade: credential surface", () => {
  it("stores, lists presence, and deletes a credential", () => {
    const f = facade();
    f.setCredential("OPENROUTER_API_KEY", "sk-very-secret");
    expect(f.hasCredential("OPENROUTER_API_KEY")).toBe(true);
    expect(f.listCredentialNames()).toEqual(["OPENROUTER_API_KEY"]);
    f.deleteCredential("OPENROUTER_API_KEY");
    expect(f.hasCredential("OPENROUTER_API_KEY")).toBe(false);
  });

  it("exposes no method that returns a credential value", () => {
    const f = facade();
    const proto = Object.getPrototypeOf(f);
    const methods = Object.getOwnPropertyNames(proto).filter((m) => m !== "constructor");
    const valueLike = methods.filter((m) =>
      /^(get|resolve|read|fetch|export).*(secret|credential|key|token|password)/i.test(m),
    );
    expect(valueLike).toEqual([]);
    // And the credential methods present are the safe subset.
    for (const m of methods.filter((m) =>/credential/i.test(m))) {
      expect(["listCredentialNames", "hasCredential", "setCredential", "deleteCredential"]).toContain(m);
    }
  });

  it("never returns the stored value even indirectly", () => {
    const f = facade();
    f.setCredential("K", "sk-secret-value");
    const snapshot = JSON.stringify({
      status: f.getSystemStatus(),
      settings: f.getSettings(),
      logs: f.listLogs(),
      runs: f.listRuns(),
    });
    expect(snapshot).not.toContain("sk-secret-value");
  });

  it("rejects an empty credential name", () => {
    expect(() => facade().setCredential("", "v")).toThrow(/empty/);
  });
});

describe("facade: logs", () => {
  it("records a redacted audit trail from the engine", async () => {
    const f = facade();
    await f.runDiagnostic({ mode: "INSPECT", subject: "logged run" });
    const logs = f.listLogs();
    expect(logs.length).toBeGreaterThan(0);
    // No secret material may ever appear in the trail.
    expect(JSON.stringify(logs)).not.toContain("sk-");
  });
});
