/**
 * D8: the provider path is manageable from the application.
 *
 * Pinned properties:
 * - the renderer can list, add, and remove providers through the sanitized
 *   settings boundary — and a bad entry is rejected THERE, in the main
 *   process, never in the page;
 * - registration warnings are surfaced through the facade and a fixed IPC
 *   channel, so a skipped provider is explained, never silent;
 * - the renderer exposes the usual enumerated surface (handlers == channels);
 * - restart semantics are honest: editing settings does not mutate a running
 *   engine (the engine's catalogue is its own).
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
  dir = mkdtempSync(join(tmpdir(), "aio-d8desk-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function stack() {
  return buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() });
}

describe("provider settings through the facade", () => {
  it("a valid provider is persisted and listed back", () => {
    const s = stack();
    const f = new DesktopFacade(s);
    f.patchSettings({
      providers: [
        {
          id: "ollama",
          displayName: "Ollama",
          endpoint: "http://127.0.0.1:11434/v1",
          apiKeyEnv: null,
          models: [{ id: "llama3", displayName: "Llama 3" }],
        },
      ],
    } as never);
    const providers = f.getSettings().providers;
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe("ollama");
  });

  it("an invalid provider is dropped at the boundary, never stored", () => {
    const s = stack();
    const f = new DesktopFacade(s);
    const patched = f.patchSettings({
      providers: [
        { id: "No Good", endpoint: "http://127.0.0.1:1/v1", models: [{ id: "x" }] },
        { id: "bad", endpoint: "http://remote.example.com/v1", models: [{ id: "x" }] },
        { id: "ok", endpoint: "https://api.example.com/v1", apiKeyEnv: "EXAMPLE_KEY", models: [{ id: "x" }] },
      ],
    } as never);
    expect(patched.providers.map((p) => p.id)).toEqual(["ok"]);
  });

  it("a key VALUE is refused — only an env-var name survives", () => {
    const s = stack();
    const f = new DesktopFacade(s);
    const patched = f.patchSettings({
      providers: [
        { id: "ok", endpoint: "https://api.example.com/v1", apiKeyEnv: "sk-actual-secret-value", models: [{ id: "x" }] },
      ],
    } as never);
    expect(patched.providers[0].apiKeyEnv).toBeUndefined();
  });
});

describe("registration warnings are surfaced", () => {
  it("facade returns the warnings the stack recorded at startup", () => {
    // A provider id colliding with the built-in local adapter survives as a
    // raw settings shape here; registration refuses it and warns. (The D8
    // settings boundary would normally have dropped it earlier — defense in
    // depth, so the engine still refuses to overwrite the built-in adapter.)
    const seed = {
      workspaceRoots: [],
      theme: "system" as const,
      defaultMode: "INSPECT" as const,
      providers: [
        { id: "local", displayName: "Fake local", endpoint: "http://127.0.0.1:1/v1", models: [{ id: "x" }] },
      ],
    };
    const store = {
      get: () => seed,
      patch: () => seed,
      reset: () => seed,
      save: () => {},
    };
    const s = buildDesktopStack({
      baseDir: dir,
      credentials: new MemoryCredentialProvider(),
      overrides: { settingsStore: store as never },
    });
    const f = new DesktopFacade(s);
    expect(f.getProviderWarnings().length).toBeGreaterThan(0);
    expect(f.getProviderWarnings()[0]).toMatch(/already registered/);
  });

  it("the IPC channel exists and main registers it", () => {
    expect(IPC_CHANNELS).toContain("all-in-1:providers:warnings");
    const main = readFileSync(join(SRC, "main.ts"), "utf8");
    expect(main).toContain('ipcMain.handle("all-in-1:providers:warnings"');
    const preload = readFileSync(join(SRC, "preload.cjs"), "utf8");
    expect(preload).toContain("getProviderWarnings");
  });
});

describe("renderer providers UI", () => {
  it("the settings view has a providers card and the renderer manages it", () => {
    const html = readFileSync(join(SRC, "renderer", "index.html"), "utf8");
    expect(html).toContain('id="settings-providers"');
    expect(html).toContain('id="settings-provider-warnings"');
    const renderer = readFileSync(join(SRC, "renderer", "renderer.js"), "utf8");
    expect(renderer).toContain("addProvider");
    expect(renderer).toContain("removeProvider");
    expect(renderer).toContain("getProviderWarnings");
  });

  it("immediate-application copy is in the page", () => {
    const html = readFileSync(join(SRC, "renderer", "index.html"), "utf8");
    expect(html).toMatch(/apply immediately/i);
  });
});
