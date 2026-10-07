/**
 * D9: the Models view reports the registered providers honestly.
 *
 * Pinned properties:
 * - listModelProviders exposes only JSON-safe descriptors: locality, cost
 *   class, model ids, whether the engine registered the adapter, and
 *   whether the named key is present — never a value;
 * - the selection posture note changes when providers exist: it no longer
 *   claims "egress is deny-all" while the engine has allowlisted a host;
 * - the new channel is enumerated and mirrored by main and preload.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDesktopStack } from "../src/desktop-stack.ts";
import { DesktopFacade } from "../src/facade.ts";
import { MemoryCredentialProvider } from "../src/credentials/memory-credential-provider.ts";
import { IPC_CHANNELS } from "../src/ipc-channels.ts";

const SRC = join(process.cwd(), "desktop", "src");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-d9desk-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("listModelProviders", () => {
  it("is empty under the frozen defaults", () => {
    const s = buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() });
    expect(new DesktopFacade(s).listModelProviders()).toEqual([]);
  });

  it("describes a registered local provider without any secret", () => {
    const s = buildDesktopStack({
      baseDir: dir,
      credentials: new MemoryCredentialProvider(),
      overrides: undefined,
    });
    s.settingsStore.patch({
      providers: [
        { id: "ollama", displayName: "Ollama", endpoint: "http://127.0.0.1:11434/v1", apiKeyEnv: null, models: [{ id: "llama3" }] },
      ],
    } as never);
    // The running stack was built BEFORE the patch — that is the honest
    // restart contract — so rebuild to read the new posture.
    const s2 = buildDesktopStack({
      baseDir: dir,
      credentials: new MemoryCredentialProvider(),
    });
    const f = new DesktopFacade(s2);
    const providers = f.listModelProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe("ollama");
    expect(providers[0].locality).toBe("local");
    expect(providers[0].costClass).toBe("FREE");
    expect(providers[0].credentialPresent).toBeNull();
    expect(providers[0].registered).toBe(true);
    expect(providers[0].models).toEqual(["llama3"]);
  });

  it("reports credential presence without revealing a value", () => {
    const credentials = new MemoryCredentialProvider();
    const s = buildDesktopStack({ baseDir: dir, credentials });
    credentials.set("REMOTE_KEY", "sk-should-never-leave-main");
    s.settingsStore.patch({
      providers: [
        { id: "remote", displayName: "Remote", endpoint: "https://api.example.com/v1", apiKeyEnv: "REMOTE_KEY", models: [{ id: "big", costPer1MUsd: { input: 5, output: 15 } }] },
      ],
    } as never);
    const s2 = buildDesktopStack({ baseDir: dir, credentials });
    const f = new DesktopFacade(s2);
    const p = f.listModelProviders()[0];
    expect(p.credentialPresent).toBe(true);
    expect(p.costClass).toBe("PAID");
    expect(p.locality).toBe("remote");
    expect(JSON.stringify(f.listModelProviders())).not.toContain("sk-should-never-leave-main");
  });
});

describe("selection posture is honest", () => {
  it("still claims deny-all when nothing is registered", () => {
    const s = buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() });
    const posture = new DesktopFacade(s).selectionPosture();
    expect(posture.egress).toBe("deny-all");
    expect(posture.note).toMatch(/deny-all/);
  });

  it("reports the allowlist the engine actually enforces", () => {
    const credentials = new MemoryCredentialProvider();
    const first = buildDesktopStack({ baseDir: dir, credentials });
    first.settingsStore.patch({
      providers: [
        { id: "remote", displayName: "Remote", endpoint: "https://api.example.com/v1", apiKeyEnv: "REMOTE_KEY", models: [{ id: "big" }] },
      ],
    } as never);
    const second = buildDesktopStack({ baseDir: dir, credentials });
    const posture = new DesktopFacade(second).selectionPosture();
    expect(posture.egress).toBe("explicit-allowlist");
    expect(posture.note).toContain("api.example.com");
    expect(posture.note).not.toMatch(/egress is deny-all/);
  });
});

describe("the new channel is wired", () => {
  it("is enumerated, handled, and preloaded", () => {
    expect(IPC_CHANNELS).toContain("all-in-1:models:providers");
    const main = readFileSync(join(SRC, "main.ts"), "utf8");
    expect(main).toContain('ipcMain.handle("all-in-1:models:providers"');
    const preload = readFileSync(join(SRC, "preload.cjs"), "utf8");
    expect(preload).toContain("listModelProviders");
    const html = readFileSync(join(SRC, "renderer", "index.html"), "utf8");
    expect(html).toContain('id="models-providers"');
  });
});
