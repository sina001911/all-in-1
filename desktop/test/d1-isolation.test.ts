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

  it("denies popups and refuses to navigate off the app", () => {
    const src = main();
    expect(src).toMatch(/setWindowOpenHandler\([\s\S]{0,80}?action:\s*["']deny["']/);
    expect(src).toMatch(/on\(\s*["']will-navigate["']/);
    expect(src).toMatch(/preventDefault\(\)/);
  });

  it("switches the webview tag off", () => {
    expect(main()).toMatch(/webviewTag:\s*false/);
  });

  it("denies every browser permission request", () => {
    const src = main();
    expect(src).toMatch(/setPermissionRequestHandler\(/);
    expect(src).toMatch(/setPermissionCheckHandler\(/);
    expect(src).toMatch(/callback\(false\)/);
  });
});

describe("renderer content security policy", () => {
  const csp = (): string => {
    const html = read(join("renderer", "index.html"));
    // The value is double-quoted and is full of single quotes, so the capture
    // must exclude only the double quote that terminates the attribute.
    const match = html.match(
      /http-equiv=["']Content-Security-Policy["'][\s\S]*?content="([^"]+)"/,
    );
    if (!match?.[1]) throw new Error("the renderer declares no Content-Security-Policy");
    return match[1];
  };

  const directive = (name: string): string =>
    csp()
      .split(";")
      .map((d) => d.trim())
      .find((d) => d === name || d.startsWith(`${name} `)) ?? "";

  it("keeps scripts same-origin only — no inline, no eval", () => {
    // Pinned exactly, so widening this directive has to be a deliberate edit.
    expect(directive("script-src")).toBe("script-src 'self'");
    expect(csp()).not.toMatch(/'unsafe-eval'/);
  });

  it("gives the renderer no network capability at all", () => {
    // The renderer reaches the core only through the contextBridge, which is
    // IPC and not governed by CSP. It therefore needs no connect source, and
    // this is what leaves an injected page with no channel to exfiltrate over.
    expect(directive("connect-src")).toBe("connect-src 'none'");
  });

  it("closes the plugin, frame, worker and media sinks", () => {
    for (const name of ["object-src", "frame-src", "worker-src", "media-src", "manifest-src"]) {
      expect(directive(name)).toBe(`${name} 'none'`);
    }
  });

  it("pins the document base and form target", () => {
    expect(directive("base-uri")).toBe("base-uri 'none'");
    expect(directive("form-action")).toBe("form-action 'none'");
  });

  it("omits the directives a <meta> policy cannot deliver", () => {
    // Chromium ignores frame-ancestors (and report-uri/sandbox) when the policy
    // arrives in a <meta> element, and logs a warning on every startup. Keeping
    // one here would be configuration that reads like protection while
    // enforcing nothing, so the absence is pinned instead. The equivalent
    // control is structural: no webview, no frame, and main denies popups and
    // off-app navigation.
    for (const ignored of ["frame-ancestors", "report-uri", "sandbox"]) {
      expect(directive(ignored)).toBe("");
    }
  });

  it("holds the invariants that make script-src 'self' sufficient", () => {
    const html = read(join("renderer", "index.html"));
    // Every script element is a same-origin file reference — no inline code,
    // no remote URL. The renderer now loads as several classic scripts in
    // dependency order (components → state → theme → i18n → renderer), which
    // is still `script-src 'self'`: each one is a same-origin file.
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) {
      expect(s).toMatch(/src=["'][^"']+\.js["']/);
      expect(s).not.toMatch(/src=["']https?:/);
    }
    // No inline event-handler attribute anywhere in the markup.
    expect(html).not.toMatch(/\son[a-z]+\s*=/);
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
    // The escaping path lives in the shared components module (B1 split), so
    // assert it there rather than in the main renderer body.
    expect(read(join("renderer", "components.js"))).toContain("function esc(");
  });
});

describe("IPC channel list", () => {
  it("is unique and stable", () => {
    expect(new Set(IPC_CHANNELS).size).toBe(IPC_CHANNELS.length);
    for (const c of IPC_CHANNELS) expect(c.startsWith("all-in-1:")).toBe(true);
  });
});
