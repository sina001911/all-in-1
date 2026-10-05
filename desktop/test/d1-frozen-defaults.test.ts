/**
 * D1 frozen-defaults and independence tests.
 *
 * Proves the desktop stack boots in the exact inert posture the core ships:
 * deny-all egress, zero budget, no remote adapter, MAIN_CODER immutable, and no
 * OpenCode dependency anywhere in the runtime graph.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDesktopStack } from "../src/desktop-stack.ts";
import { DesktopFacade } from "../src/facade.ts";
import { MemoryCredentialProvider } from "../src/credentials/memory-credential-provider.ts";
import { ModelRouter } from "../../src/registry/model.router.ts";
import { ModelRegistry } from "../../src/registry/model.registry.ts";
import { registerStubs } from "../../src/registry/stub.ts";
import { ApprovalStore } from "../../src/registry/approvals.ts";
import { BudgetLedger } from "../../src/registry/budget.ts";
import { FROZEN_DEFAULTS } from "../../src/config/schema.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-frozen-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function stack() {
  return buildDesktopStack({
    baseDir: dir,
    credentials: new MemoryCredentialProvider(),
  });
}

describe("frozen desktop posture", () => {
  it("boots with deny-all egress", () => {
    const s = stack();
    expect(s.core.stack.egress.kind).toBe("deny-all");
    expect(s.core.stack.egress.allowlist).toEqual([]);
  });

  it("boots with a zero budget", () => {
    expect(stack().budget.snapshot()).toEqual({ budgetUsd: 0, reservedUsd: 0, spentUsd: 0 });
  });

  it("registers no remote provider adapter", () => {
    const s = stack();
    const ids = s.core.stack.adapters.list().map((a) => a.id);
    expect(ids).toEqual(["local"]);
    const local = s.core.stack.adapters.get("local");
    expect(local?.locality).toBe("local");
  });

  it("exposes the frozen defaults unchanged", () => {
    const s = stack();
    expect(s.frozenDefaults).toEqual(FROZEN_DEFAULTS);
    expect(s.frozenDefaults.mainCoder).toEqual({
      provider: "s1",
      model: "Atria-Dawn-Preview",
      fixed: true,
    });
    expect(s.frozenDefaults.cost.spendBudgetUsd).toBe(0);
    expect(s.frozenDefaults.cost.unknownPricing).toBe("premium");
    expect(s.frozenDefaults.workflow.humanInTheLoop).toBe(true);
    expect(s.frozenDefaults.media.enabled).toBe(false);
  });

  it("keeps MAIN_CODER unresolvable by the router", () => {
    const models = new ModelRegistry();
    registerStubs(models);
    const approvals = new ApprovalStore();
    const budget = new BudgetLedger(0);
    const router = new ModelRouter({ registry: models, approvals, budget });
    expect(() => router.resolve({ role: "MAIN_CODER" })).toThrow(/MAIN_CODER/);
  });

  it("cannot reserve against the frozen zero budget", () => {
    expect(stack().budget.reserve(0.01)).toBe(false);
  });

  it("reports the inert posture through the facade", () => {
    const facade = new DesktopFacade(stack());
    const status = facade.getSystemStatus();
    expect(status.egress.kind).toBe("deny-all");
    expect(status.budget.budgetUsd).toBe(0);
  });
});

describe("OpenCode independence", () => {
  it("imports no @opencode/plugin module anywhere in the desktop source", () => {
    const srcDir = join(process.cwd(), "desktop", "src");
    const offenders: string[] = [];
    for (const file of readdirSync(srcDir, { recursive: true })) {
      const path = join(srcDir, file.toString());
      if (!path.endsWith(".ts") && !path.endsWith(".js") && !path.endsWith(".cjs")) continue;
      const text = readFileSync(path, "utf8");
      if (/@opencode\/plugin/.test(text)) offenders.push(file.toString());
    }
    expect(offenders).toEqual([]);
  });

  it("does not require electron from any desktop module except main.ts and the preload bridge", () => {
    // main.ts owns the process; preload.cjs is the sandboxed contextBridge
    // shim and is the only other module permitted to touch Electron, and only
    // through contextBridge/ipcRenderer — never Node.
    const srcDir = join(process.cwd(), "desktop", "src");
    const offenders: string[] = [];
    for (const file of readdirSync(srcDir, { recursive: true })) {
      const rel = file.toString();
      if (rel === "main.ts" || rel === "preload.cjs") continue;
      const path = join(srcDir, rel);
      if (!path.endsWith(".ts") && !path.endsWith(".js") && !path.endsWith(".cjs")) continue;
      const text = readFileSync(path, "utf8");
      if (/from\s+["']electron["']|require\(\s*["']electron["']\)/.test(text)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
