/**
 * D1 renderer-isolation tests.
 *
 * The renderer is the untrusted surface. These tests pin the hardening at the
 * source level: the preload exposes an enumerated API only (never `ipcRenderer`
 * itself, never Node), the window is created with nodeIntegration/contextIsolation/
 * sandbox, and the renderer page has no path to the engine or the filesystem.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IPC_CHANNELS } from "../src/ipc-channels.ts";

const SRC = join(process.cwd(), "desktop", "src");

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

describe("preload boundary", () => {
  const preload = () => read("preload.cjs");

  it("exposes exactly one bridge key, named allInOne", () => {
    expect(preload()).toMatch(/exposeInMainWorld\(\s*["']allInOne["']/);
    // No additional bridge exposures.
    expect((preload().match(/exposeInMainWorld/g) ?? []).length).toBe(1);
  });

  it("never hands ipcRenderer itself to the renderer", () => {
    const src = preload();
    expect(src).not.toMatch(/exposeInMainWorld\(\s*["']ipcRenderer["']/);
    // The api object exposes named functions only, each wrapping one invoke.
    expect(src).not.toMatch(/allInOne.*=.*ipcRenderer\b(?!["']\s*[,)])/);
  });

  it("exposes exactly one invoke per enumerated channel", () => {
    const src = preload();
    for (const channel of IPC_CHANNELS) {
      expect(src).toContain(`"${channel}"`);
    }
    // No invoke targets a channel outside the enumerated list.
    const invoked = [...src.matchAll(/invoke\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(invoked.sort()).toEqual([...IPC_CHANNELS].sort());
  });

  it("contains no filesystem, process, or engine access", () => {
    const src = preload();
    expect(src).not.toMatch(/require\(\s*["']node:/);
    expect(src).not.toMatch(/from\s+["']\.\.\/\.\.\/src\//);
  });
});

describe("main window hardening", () => {
  const main = () => read("main.ts");

  it("creates the renderer with nodeIntegration disabled", () => {
    expect(main()).toMatch(/nodeIntegration:\s*false/);
  });

  it("enables context isolation", () => {
    expect(main()).toMatch(/contextIsolation:\s*true/);
  });

  it("enables the sandbox", () => {
    expect(main()).toMatch(/sandbox:\s*true/);
  });

  it("registers handlers only for the enumerated channels", () => {
    const src = main();
    const handled = [...src.matchAll(/ipcMain\.handle\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(handled.sort()).toEqual([...IPC_CHANNELS].sort());
  });

  it("loads a packaged renderer file, not a remote URL", () => {
    expect(main()).toMatch(/loadFile\(/);
    expect(main()).not.toMatch(/loadURL\(\s*["']https?:/);
  });
});

describe("renderer page", () => {
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
});

describe("IPC channel list", () => {
  it("is unique and stable", () => {
    expect(new Set(IPC_CHANNELS).size).toBe(IPC_CHANNELS.length);
    for (const c of IPC_CHANNELS) expect(c.startsWith("all-in-1:")).toBe(true);
  });
});
