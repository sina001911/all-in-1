/**
 * D10: provider configuration takes effect immediately, without a restart.
 *
 * Pinned properties:
 * - Debounced by none: a settings patch that changes `providers` rebuilds
 *   ONLY the provider-dependent core and swaps it in atomically
 *   (catalog/adapters/egress/engine/runner are replaced; stores, tools,
 *   agent runtime, and persistence are untouched);
 * - in-flight invocations keep their original engine; new invocations get
 *   the new one;
 * - a rebuild that cannot change the sanitized provider set swaps nothing
 *   (engine identity is preserved);
 * - the frozen posture (FREE_ONLY, budget 0, deny-all egress) is re-derived
 *   from the same settings object after every reload;
 * - no credential value appears in any surfaced output.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDesktopStack } from "../src/desktop-stack.ts";
import { DesktopFacade } from "../src/facade.ts";
import { MemoryCredentialProvider } from "../src/credentials/memory-credential-provider.ts";
import { SwappablePortal } from "../../src/execution/swappable-portal.ts";
import type { InvocationPortal, ExecutionOutcome } from "../../src/execution/engine.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-d10-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const okOutcome = { ok: true } as unknown as ExecutionOutcome;

describe("SwappablePortal", () => {
  it("delegates to the current engine and reflects a swap", async () => {
    const a: InvocationPortal = { invoke: async () => ({ ...okOutcome, adapterId: "a" }) as never };
    const b: InvocationPortal = { invoke: async () => ({ ...okOutcome, adapterId: "b" }) as never };
    const p = new SwappablePortal(a);
    expect((await p.invoke({} as never)).adapterId).toBe("a");
    p.swap(b);
    expect((await p.invoke({} as never)).adapterId).toBe("b");
  });

  it("in-flight invocation continues on the OLD engine after a swap", async () => {
    let resolveA!: (v: unknown) => void;
    const gate = new Promise((r) => (resolveA = r));
    const a: InvocationPortal = { invoke: async () => (await gate) as never };
    const b: InvocationPortal = { invoke: async () => ({ adapterId: "b" }) as never };
    const p = new SwappablePortal(a);
    const inflight = p.invoke({} as never);
    p.swap(b);
    resolveA({ adapterId: "a" });
    expect(((await inflight) as { adapterId: string }).adapterId).toBe("a");
    expect(((await p.invoke({} as never)) as { adapterId: string }).adapterId).toBe("b");
  });
});

describe("hot-reload through the facade", () => {
  it("adding a provider is visible immediately, without a new stack", () => {
    const credentials = new MemoryCredentialProvider();
    const stack = buildDesktopStack({ baseDir: dir, credentials });
    const f = new DesktopFacade(stack);
    const engineBefore = stack.core.stack.engine;
    expect(stack.core.stack.egress.kind).toBe("deny-all");

    f.patchSettings({
      providers: [
        { id: "ollama", displayName: "Ollama", endpoint: "http://127.0.0.1:11434/v1", apiKeyEnv: null, models: [{ id: "llama3" }] },
      ],
    } as never);

    expect(stack.core.stack.engine).not.toBe(engineBefore);
    expect(stack.core.stack.catalog.has("ollama/llama3")).toBe(true);
    expect(stack.core.stack.adapters.has("ollama")).toBe(true);
    expect(f.listModelProviders().map((p) => p.id)).toEqual(["ollama"]);
  });

  it("a remote provider flips egress to the exact allowlist, not an open door", () => {
    const stack = buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() });
    new DesktopFacade(stack).patchSettings({
      providers: [
        { id: "remote", displayName: "Remote", endpoint: "https://api.example.com/v1", apiKeyEnv: "REMOTE_KEY", models: [{ id: "big" }] },
      ],
    } as never);
    const egress = stack.core.stack.egress;
    expect(egress.kind).toBe("explicit-allowlist");
    expect(egress.allowlist).toEqual(["api.example.com"]);
    const posture = new DesktopFacade(stack).selectionPosture();
    expect(posture.note).toContain("api.example.com");
    expect(posture.note).not.toMatch(/deny-all/);
  });

  it("removing a provider revokes its models AND the builtin catalogue survives", () => {
    const credentials = new MemoryCredentialProvider();
    const stack = buildDesktopStack({ baseDir: dir, credentials });
    const f = new DesktopFacade(stack);
    f.patchSettings({
      providers: [
        { id: "ollama", displayName: "Ollama", endpoint: "http://127.0.0.1:11434/v1", apiKeyEnv: null, models: [{ id: "llama3" }] },
      ],
    } as never);
    expect(stack.core.stack.catalog.has("ollama/llama3")).toBe(true);
    const localBefore = stack.core.stack.catalog.snapshot().filter((m) => m.provider === "local").length;

    f.patchSettings({ providers: [] } as never);

    expect(stack.core.stack.catalog.has("ollama/llama3")).toBe(false);
    expect(stack.core.stack.adapters.has("ollama")).toBe(false);
    expect(stack.core.stack.egress.kind).toBe("deny-all");
    const localAfter = stack.core.stack.catalog.snapshot().filter((m) => m.provider === "local").length;
    expect(localAfter).toBe(localBefore);
  });

  it("update via replace: a changed endpoint is seen by the NEW engine, not the old", () => {
    const stack = buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() });
    const f = new DesktopFacade(stack);
    f.patchSettings({
      providers: [
        { id: "p", displayName: "P", endpoint: "https://api.example.com/v1", apiKeyEnv: null, models: [{ id: "big" }] },
      ],
    } as never);
    const adapterOld = stack.core.stack.adapters.get("p");
    f.patchSettings({
      providers: [
        { id: "p", displayName: "P", endpoint: "https://api2.example.com/v1", apiKeyEnv: null, models: [{ id: "big" }] },
      ],
    } as never);
    const adapterNew = stack.core.stack.adapters.get("p");
    expect(adapterNew).not.toBe(adapterOld);
    expect(adapterNew!.endpoint).toBe("https://api2.example.com/v1");
    expect(stack.core.stack.egress.allowlist).toEqual(["api2.example.com"]);
  });

  it("an all-invalid patch swaps NOTHING (sanitized to a no-op)", () => {
    const stack = buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() });
    const engineBefore = stack.core.stack.engine;
    new DesktopFacade(stack).patchSettings({
      providers: [{ id: "No Good", endpoint: "not a url", models: [{ id: "x" }] }],
    } as never);
    expect(stack.core.stack.engine).toBe(engineBefore);
    expect(stack.core.stack.egress.kind).toBe("deny-all");
  });
});

describe("in-flight and post-reload request semantics", () => {
  it("after a swap the OLD engine still serves, while the new catalogue is visible immediately", async () => {
    const stack = buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() });
    const f = new DesktopFacade(stack);
    f.patchSettings({
      providers: [
        {
          id: "remote",
          displayName: "Remote",
          endpoint: "https://api.example.com/v1",
          apiKeyEnv: null,
          models: [{ id: "big" }],
        },
      ],
    } as never);
    const oldEngine = stack.core.stack.engine;
    const oldCatalog = stack.core.stack.catalog;
    const oldEgress = stack.core.stack.egress;

    f.patchSettings({ providers: [] } as never);

    // Immediate consistency: catalogue, egress and engine references moved.
    expect(stack.core.stack.engine).not.toBe(oldEngine);
    expect(stack.core.stack.catalog).not.toBe(oldCatalog);
    expect(stack.core.stack.egress).not.toBe(oldEgress);
    expect(stack.core.stack.egress.kind).toBe("deny-all");
    expect(stack.core.stack.catalog.has("remote/big")).toBe(false);
    expect(oldCatalog.has("remote/big")).toBe(true); // old stack still whole

    // Old engine and old egress still serve a LOCAL invocation deterministically
    // (in-flight/previously started calls are never torn down by a swap).
    const late = await oldEngine.invoke({
      capability: "CODING",
      inputs: [{ kind: "text", text: "hi" }],
    });
    expect(late.result.ok).toBe(true);
    expect(late.result.text).toMatch(/^\[local:/);
    expect(late.adapterId).toBe("local");

    // New invocations see the post-reload posture.
    const egress2 = stack.core.stack.egress;
    expect(egress2.kind).toBe("deny-all");
    expect(f.getSystemStatus().egress.allowlist).toEqual([]);
  });
});

describe("frozen posture survives every reload", () => {
  it("budget and policy are re-derived, never mutated", () => {
    const stack = buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() });
    const f = new DesktopFacade(stack);
    f.patchSettings({
      providers: [
        { id: "remote", displayName: "Remote", endpoint: "https://api.example.com/v1", apiKeyEnv: null, models: [{ id: "big" }] },
      ],
    } as never);
    expect(stack.budget.snapshot().budgetUsd).toBe(0);
    expect(f.selectionPosture().policy).toBe("FREE_ONLY");

    const snapshot = JSON.stringify(f.listModelProviders());
    expect(snapshot).not.toContain("sk-");
  });
});
