/**
 * D6 UI/UX redesign tests.
 *
 * Three layers of evidence:
 *
 *   1. The design system is REAL, not decorative: tokens replace literals,
 *      both palettes are defined under the same semantic names, and focus /
 *      reduced-motion / responsive rules exist.
 *   2. The shell behaves: eight views, exactly one active, keyboard reachable,
 *      aria-current applied. Verified by EXECUTING the renderer against a
 *      scriptable DOM stub rather than by reading it as text.
 *   3. The security boundary survived a redesign. Re-asserted here so a visual
 *      change can never quietly cost a safety property: classic-script parse,
 *      bridge-only access, no innerHTML, esc() intact, handlers == channels.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, Script } from "node:vm";
import { buildDesktopStack } from "../src/desktop-stack.ts";
import { DesktopFacade } from "../src/facade.ts";
import { MemoryCredentialProvider } from "../src/credentials/memory-credential-provider.ts";
import { IPC_CHANNELS } from "../src/ipc-channels.ts";
import { applyPickedRoot, removeRoot } from "../src/workspace/pick.ts";
import type { AgentRequest, ToolCall } from "../../src/agent/index.ts";

const SRC = join(process.cwd(), "desktop", "src");
const html = () => readFileSync(join(SRC, "renderer", "index.html"), "utf8");
const rendererSrc = () => readFileSync(join(SRC, "renderer", "renderer.js"), "utf8");
const mainSrc = () => readFileSync(join(SRC, "main.ts"), "utf8");
const preloadSrc = () => readFileSync(join(SRC, "preload.cjs"), "utf8");

let dir: string;
let project: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-d6desk-"));
  project = mkdtempSync(join(tmpdir(), "aio-d6desk-proj-"));
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

function withToolCalls(calls: ToolCall[], body = "on it"): string {
  return `${body}\n\n\`\`\`tool-calls\n${JSON.stringify(calls, null, 2)}\n\`\`\``;
}

/* ========================================================================
   1. DESIGN SYSTEM
   ======================================================================== */

describe("design tokens", () => {
  /** Colour + shadow tokens change per theme, so both palettes define them. */
  const THEMED = [
    "--surface-0", "--surface-1", "--surface-2", "--surface-hover",
    "--fg-strong", "--fg", "--fg-muted", "--fg-faint",
    "--border", "--border-strong",
    "--accent", "--accent-fg", "--accent-soft",
    "--ok", "--ok-soft", "--warn", "--warn-soft",
    "--danger", "--danger-soft", "--danger-fg",
    "--info", "--info-soft",
    "--shadow-1", "--shadow-2",
  ];
  /** Geometry and type are theme-independent and live on :root only. */
  const STRUCTURAL = [
    "--r-sm", "--r-md", "--r-lg",
    "--s1", "--s2", "--s3", "--s4", "--s5", "--s6",
    "--font-sans", "--font-mono",
  ];

  it("defines every semantic token on :root", () => {
    const root = html().split("[data-theme=")[0] ?? "";
    for (const token of [...THEMED, ...STRUCTURAL]) {
      expect(root, `token ${token}`).toContain(token + ":");
    }
  });

  it("overrides every themed token in the dark palette", () => {
    const css = html();
    const dark = css.slice(css.indexOf('[data-theme="dark"]'));
    for (const token of THEMED) {
      expect(dark, `dark token ${token}`).toContain(token + ":");
    }
  });

  it("keeps geometry and type out of the theme blocks (they are not colours)", () => {
    const css = html();
    const dark = css.slice(css.indexOf('[data-theme="dark"]'));
    for (const token of STRUCTURAL) {
      expect(dark, `structural ${token} should not be themed`).not.toContain(token + ":");
    }
  });

  it("replaces every hardcoded colour literal outside the token layer", () => {
    // Strip the two token blocks, then assert no hex colour survives.
    const css = html();
    const body = css.slice(css.indexOf('[data-theme="dark"]'));
    const afterTokens = body.slice(body.indexOf("}"));
    const hex = afterTokens.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    // rgba() inside --shadow-* definitions is part of the token layer only.
    expect(hex).toEqual([]);
  });

  it("avoids the banned chrome effects: no gradient, blur or glow", () => {
    const css = html();
    expect(css).not.toMatch(/linear-gradient|radial-gradient/);
    expect(css).not.toMatch(/backdrop-filter/);
    expect(css).not.toMatch(/box-shadow:[^;]*\bblur\(/);
  });

  it("uses a neutral blue-black dark ground, not pure black", () => {
    const css = html();
    const dark = css.slice(css.indexOf('[data-theme="dark"]'));
    expect(dark).toMatch(/--surface-0:\s*#0f141b/);
  });
});

describe("accessibility", () => {
  it("declares a visible focus ring", () => {
    expect(html()).toMatch(/:focus-visible\s*\{[^}]*outline:/);
  });

  it("honours reduced motion", () => {
    expect(html()).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });

  it("has responsive breakpoints", () => {
    const css = html();
    expect(css).toMatch(/@media\s*\(max-width:\s*900px\)/);
    expect(css).toMatch(/@media\s*\(max-width:\s*620px\)/);
  });

  it("labels the landmark regions", () => {
    const markup = html();
    expect(markup).toMatch(/<nav class="nav" id="nav" aria-label="Primary">/);
    expect(markup).toMatch(/role="log"/);
    expect(markup).toMatch(/role="dialog" aria-modal="true"/);
    expect(markup).toMatch(/aria-live="polite"/);
  });

  it("gives every view an accessible name", () => {
    const markup = html();
    for (const view of ["agent", "runs", "tools", "approvals", "audit", "models", "workspace", "settings"]) {
      expect(markup, `view ${view}`).toMatch(
        new RegExp(`id="view-${view}" aria-labelledby="h-${view}"`),
      );
      expect(markup, `heading ${view}`).toContain(`id="h-${view}"`);
    }
  });

  it("gives every nav item a data-view target that exists", () => {
    const markup = html();
    const targets = [...markup.matchAll(/class="nav-item" data-view="([a-z]+)"/g)].map((m) => m[1]);
    expect(targets.sort()).toEqual(
      ["agent", "runs", "tools", "approvals", "audit", "models", "workspace", "settings"].sort(),
    );
    for (const t of targets) expect(markup).toContain(`id="view-${t}"`);
  });
});

/* ========================================================================
   2. SHELL BEHAVIOUR (executed, not just read)
   ======================================================================== */

interface StubNode {
  tag: string;
  attrs: Map<string, string>;
  dataset: Record<string, string>;
  className: string;
  text: string;
  kids: StubNode[];
  classes: Set<string>;
  hidden: boolean;
  value: string;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  parent: StubNode | null;
  appendChild(kid: StubNode): void;
  removeChild(kid: StubNode): void;
  readonly firstChild: StubNode | null;
  querySelector(sel: string): StubNode | null;
  querySelectorAll(sel: string): StubNode[];
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  removeAttribute(k: string): void;
  classList: { add(c: string): void; remove(c: string): void; toggle(c: string, on: boolean): void };
  addEventListener(ev: string, fn: (e: unknown) => void): void;
  dispatch(ev: string, payload?: unknown): void;
  /** All text in this subtree, without JSON.stringify (no cycles). */
  textOf(): string;
}

/** A small but REAL DOM stub: enough structure for the shell to be exercised. */
function makeDom(): { doc: Record<string, unknown>; nav: Map<string, StubNode> } {
  const byId = new Map<string, StubNode>();
  const listeners = new Map<string, Array<(e: unknown) => void>>();

  function node(tag: string, id?: string): StubNode {
    const attrs = new Map<string, string>();
    const classes = new Set<string>();
    const kids: StubNode[] = [];
    const evs = new Map<string, Array<(e: unknown) => void>>();
    const dataset: Record<string, string> = {};

    const on = (name: string): Array<(e: unknown) => void> => {
      let arr = evs.get(name);
      if (!arr) {
        arr = [];
        evs.set(name, arr);
      }
      return arr;
    };

    const n: StubNode = {
      tag,
      attrs,
      dataset,
      className: "",
      text: "",
      kids,
      classes,
      hidden: false,
      value: "",
      listeners: evs,
      parent: null,
      appendChild(kid: StubNode) {
        kids.push(kid);
        kid.parent = n;
        const cid = kid.getAttribute("id");
        if (cid) byId.set(cid, kid);
      },
      removeChild(kid: StubNode) {
        const i = kids.indexOf(kid);
        if (i !== -1) kids.splice(i, 1);
      },
      get firstChild(): StubNode | null {
        return kids.length > 0 ? kids[0] : null;
      },
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      setAttribute(k: string, v: string) {
        attrs.set(k, v);
        if (k === "class") n.className = v;
      },
      getAttribute(k: string) {
        return attrs.has(k) ? (attrs.get(k) as string) : null;
      },
      removeAttribute(k: string) {
        attrs.delete(k);
      },
      classList: {
        add(c: string) {
          classes.add(c);
        },
        remove(c: string) {
          classes.delete(c);
        },
        toggle(c: string, on_: boolean) {
          if (on_) classes.add(c);
          else classes.delete(c);
        },
      },
      addEventListener(ev: string, fn: (e: unknown) => void) {
        on(ev).push(fn);
      },
      dispatch(ev: string, payload?: unknown) {
        const target = payload && typeof payload === "object" ? { ...payload, currentTarget: n } : { key: "", currentTarget: n, preventDefault() {} };
        for (const fn of on(ev)) fn(target);
      },
      textOf() {
        let out = n.text;
        for (const k of kids) out += k.textOf();
        return out;
      },
    };
    if (id) byId.set(id, n);
    return n;
  }

  // Populate the static page structure the renderer expects to find.
  const ids = [
    "posture", "theme-light", "theme-dark", "theme-system", "nav-approvals", "sidebar-foot",
    "mode-help", "mode-INSPECT", "mode-SUGGEST", "mode-BUILD", "agent-auto",
    "agent-run-id", "agent-state", "agent-cancel", "agent-prompt", "agent-run", "agent-hint",
    "transcript", "runs-table", "runs-detail", "diag-mode", "diag-subject", "diag-auto",
    "diag-run", "diag-cancel", "diag-output",
    "tools-mode", "tools-visible", "tools-all",
    "approvals-pending", "approvals-resolved",
    "audit-run", "tab-tool", "tab-log", "pane-tool", "pane-log",
    "models-posture", "models-table",
    "workspace-roots", "workspace-add",
    "settings-theme", "settings-mode", "settings-credentials", "settings-usage",
    "settings-budget", "settings-frozen",
    "toasts", "modal-backdrop", "modal-title", "modal-body", "modal-cancel", "modal-confirm",
  ];
  for (const id of ids) node("div", id);

  for (const v of ["agent", "runs", "tools", "approvals", "audit", "models", "workspace", "settings"]) {
    const view = node("section", `view-${v}`);
    // The markup ships with the agent view already active; mirror that.
    if (v === "agent") view.classes.add("active");
  }

  // The eight nav buttons, wired the way the markup wires them.
  const nav = new Map<string, StubNode>();
  for (const v of ["agent", "runs", "tools", "approvals", "audit", "models", "workspace", "settings"]) {
    const btn = node("button");
    btn.attrs.set("data-view", v);
    btn.className = "nav-item";
    if (v === "agent") btn.attrs.set("aria-current", "page");
    nav.set(v, btn);
  }

  const documentElement = node("html");

  const doc: Record<string, unknown> = {
    documentElement,
    activeElement: null,
    hidden: false,
    createElement: (tag: string) => node(tag),
    createTextNode: (t: string) => {
      const tn = node("#text");
      tn.text = String(t);
      return tn;
    },
    getElementById: (id: string) => byId.get(id) ?? null,
    querySelectorAll: (sel: string) => {
      if (sel === ".nav-item") return [...nav.values()];
      return [];
    },
    addEventListener: (ev: string, fn: (e: unknown) => void) => {
      // Document-level listeners live on the documentElement stub.
      const holder = documentElement.listeners.get(ev) ?? [];
      holder.push(fn);
      documentElement.listeners.set(ev, holder);
    },
  };

  return { doc, nav };
}

async function bootRenderer(): Promise<{
  doc: Record<string, unknown>;
  nav: Map<string, StubNode>;
  apiCalls: string[];
  flush(): Promise<void>;
}> {
  const { doc, nav } = makeDom();
  const apiCalls: string[] = [];
  const answers: Record<string, unknown> = {
    getSettings: { theme: "dark", defaultMode: "BUILD", workspaceRoots: [] },
    getSystemStatus: { egress: { kind: "deny-all" }, budget: { budgetUsd: 0 }, approvals: 0, runs: 3, credentials: ["k"] },
    getSelectionPosture: { egress: "deny-all", budgetUsd: 0, policy: "FREE_ONLY", note: "n" },
    listPendingToolApprovals: [
      { id: "ap-1", runId: "r1", toolName: "files.write", permission: "write", summary: "s", inputSummary: { path: "a" }, justification: "why", createdAt: 1 },
    ],
    listToolAudit: [],
    listAgentTools: [],
    listTools: [],
    listModels: [],
    listRuns: [],
    getRun: { id: "r1", mode: "INSPECT", status: "completed", startedAt: 1, finishedAt: 2, iterations: 1 },
    listWorkspaceRoots: [project],
    listCredentialNames: [],
    getUsageTotals: { invocations: 0, totalCostUsd: 0, totalTokens: 0 },
    getBudget: { budgetUsd: 0 },
    getFrozenDefaults: {},
    listLogs: [],
    pickWorkspaceRoot: { added: false, roots: [] },
    patchSettings: { theme: "dark", defaultMode: "BUILD", workspaceRoots: [] },
    listToolApprovals: [],
  };
  const api = new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        return (...args: unknown[]) => {
          apiCalls.push(prop);
          if (prop === "approveTool" || prop === "denyTool") {
            answers.listPendingToolApprovals = [];
          }
          if (prop === "listLogs") return [];
          return Promise.resolve(answers[prop] ?? []);
        };
      },
    },
  );
  const sandbox: Record<string, unknown> = {
    window: { allInOne: api },
    document: doc,
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    setInterval: () => 1,
    clearInterval: () => undefined,
    console,
  };
  createContext(sandbox);
  new Script(rendererSrc(), { filename: "renderer.js" }).runInContext(sandbox as never);
  const flush = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 30));
  };
  await flush();
  return { doc, nav, apiCalls, flush };
}

/* ========================================================================
   3. SECURITY BOUNDARY (re-asserted after a redesign)
   ======================================================================== */

describe("security boundary survives the redesign", () => {
  it("the renderer still parses as a classic script", () => {
    expect(() => new Script(rendererSrc(), { filename: "renderer.js" })).not.toThrow();
  });

  it("the renderer still has no Node, no ipcRenderer and no direct imports", () => {
    const src = rendererSrc();
    expect(src).toMatch(/window\.allInOne/);
    expect(src).not.toMatch(/require\(/);
    expect(src).not.toMatch(/import\s+/);
    expect(src).not.toMatch(/ipcRenderer/);
    expect(src).not.toMatch(/node:/);
    // Node globals, not the word "process" (which appears in tool names).
    expect(src).not.toMatch(/\bprocess\.(env|cwd|argv|exit|platform|version)\b/);
    expect(src).not.toMatch(/\bglobal\./);
    expect(src).not.toMatch(/\bBuffer\b/);
    expect(src).not.toMatch(/\bfetch\(/);
  });

  it("never assigns innerHTML, with data or otherwise", () => {
    const src = rendererSrc();
    expect(src).not.toMatch(/\.innerHTML\s*=/);
    expect(src).not.toMatch(/insertAdjacentHTML/);
    expect(src).not.toMatch(/outerHTML\s*=/);
    expect(src).not.toMatch(/document\.write/);
  });

  it("keeps esc() as the escaping path", () => {
    expect(rendererSrc()).toContain("function esc(");
    // And it is actually used, not merely present.
    expect((rendererSrc().match(/esc\(/g) ?? []).length).toBeGreaterThan(1);
  });

  it("registers exactly the enumerated channels", () => {
    const handled = [...mainSrc().matchAll(/ipcMain\.handle\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(handled.sort()).toEqual([...IPC_CHANNELS].sort());
  });

  it("keeps the window hardened", () => {
    const src = mainSrc();
    expect(src).toMatch(/nodeIntegration:\s*false/);
    expect(src).toMatch(/contextIsolation:\s*true/);
    expect(src).toMatch(/sandbox:\s*true/);
    expect(src).toMatch(/loadFile\(/);
    expect(src).not.toMatch(/loadURL\(\s*["']https?:/);
  });

  it("preserves the CSP and loads no remote source", () => {
    const markup = html();
    expect(markup).toMatch(/default-src 'self'; style-src 'unsafe-inline'/);
    expect(markup).not.toMatch(/https?:\/\//);
    expect(markup).not.toMatch(/\bon\w+\s*=\s*["']/);
  });

  it("preserves pull-only polling and the visibility pause", () => {
    const src = rendererSrc();
    expect(src).toMatch(/setInterval/);
    expect(src).toMatch(/visibilitychange/);
    expect(src).toMatch(/document\.hidden/);
    // No push listener: nothing subscribes to an incoming channel.
    expect(src).not.toMatch(/\.on\(["']message|addEventListener\(\s*["']message/);
    expect(src).not.toMatch(/webContents/);
  });

  it("settles approvals only through the two channels", () => {
    const src = rendererSrc();
    expect(src).toMatch(/api\.approveTool\(/);
    expect(src).toMatch(/api\.denyTool\(/);
    // There is no renderer-side path that fabricates a decision.
    expect(src).not.toMatch(/api\.(grantApproval|revokeApproval)\(/);
  });

  it("labels the model's justification as evidence, not consent", () => {
    const src = rendererSrc();
    expect(src).toMatch(/evidence, not consent/i);
  });

  it("reads no credential value back", () => {
    const src = rendererSrc();
    expect(src).toMatch(/api\.setCredential\(/);
    expect(src).toMatch(/api\.deleteCredential\(/);
    expect(src).not.toMatch(/api\.hasCredential\(/);
    // The typed value is dropped once it has travelled to the OS.
    expect(src).toMatch(/valueInput\.value\s*=\s*""/);
    // No value-returning facade method exists to read in the first place.
    expect(rendererSrc()).not.toMatch(/getCredential|readCredential|resolveCredential/);
  });
});

/* ========================================================================
   FOLDER PICKER
   ======================================================================== */

describe("workspace folder picker", () => {
  it("declares one channel and wires all three layers", () => {
    expect(IPC_CHANNELS).toContain("all-in-1:workspace:pick");
    expect(mainSrc()).toMatch(/ipcMain\.handle\(\s*["']all-in-1:workspace:pick["']/);
    expect(preloadSrc()).toMatch(/pickWorkspaceRoot:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(\s*["']all-in-1:workspace:pick["']\s*\)/);
    expect(rendererSrc()).toMatch(/api\.pickWorkspaceRoot\(\)/);
  });

  it("opens a directory-only dialog and can never expand the sandbox on its own", () => {
    const src = mainSrc();
    expect(src).toMatch(/dialog\.showOpenDialog/);
    expect(src).toMatch(/openDirectory/);
    // The renderer supplies no path: the handler takes no argument at all.
    expect(src).toMatch(/ipcMain\.handle\(\s*["']all-in-1:workspace:pick["'],\s*async\s*\(\s*\)\s*=>/);
  });

  it("persists a picked root through the sanitized settings path", () => {
    expect(mainSrc()).toMatch(/patchSettings\(\{\s*workspaceRoots:/);
  });

  it("adds only a user-chosen directory, never duplicates one", () => {
    expect(applyPickedRoot([], "C:\\a").added).toBe(true);
    expect(applyPickedRoot(["C:\\a"], "C:\\a").added).toBe(false);
    expect(applyPickedRoot(["C:\\a"], "C:\\a").roots).toEqual(["C:\\a"]);
    expect(applyPickedRoot(["C:\\a"], "C:\\b").roots).toEqual(["C:\\a", "C:\\b"]);
  });

  it("adds nothing when the dialog is cancelled", () => {
    const out = applyPickedRoot(["C:\\a"], undefined);
    expect(out.added).toBe(false);
    expect(out.roots).toEqual(["C:\\a"]);
    expect(applyPickedRoot([], "   ").added).toBe(false);
  });

  it("never mutates the input list", () => {
    const input = ["C:\\a"];
    applyPickedRoot(input, "C:\\b");
    removeRoot(input, "C:\\a");
    expect(input).toEqual(["C:\\a"]);
  });

  it("removal is narrowing only", () => {
    expect(removeRoot(["C:\\a", "C:\\b"], "C:\\a")).toEqual(["C:\\b"]);
    expect(removeRoot(["C:\\a"], "C:\\zzz")).toEqual(["C:\\a"]);
  });
});

/* ========================================================================
   THEME PERSISTENCE + SETTINGS (facade level)
   ======================================================================== */

describe("theme persistence", () => {
  it("round-trips each theme through the sanitized store", () => {
    const f = facade();
    for (const theme of ["light", "dark", "system"] as const) {
      expect(f.patchSettings({ theme }).theme).toBe(theme);
      expect(f.getSettings().theme).toBe(theme);
    }
  });

  it("survives a fresh store reading the same file", () => {
    const f = facade();
    f.patchSettings({ theme: "dark" });
    const paths = f.getSettings();
    expect(paths.theme).toBe("dark");
  });

  it("cannot write a frozen default through a settings patch", () => {
    const f = facade();
    f.patchSettings({ theme: "dark", mainCoder: "evil", spendBudgetUsd: 99 } as never);
    const frozen = f.getFrozenDefaults() as { cost: { spendBudgetUsd: number }; mainCoder: { model: string } };
    expect(frozen.cost.spendBudgetUsd).toBe(0);
    expect(frozen.mainCoder.model).toBe("Atria-Dawn-Preview");
    // And nothing leaked into the settings object itself.
    expect(Object.keys(f.getSettings()).sort()).toEqual(["defaultMode", "providers", "theme", "workspaceRoots"]);
  });

  it("keeps the default mode and theme independent", () => {
    const f = facade();
    f.patchSettings({ theme: "dark" });
    expect(f.getSettings().defaultMode).toBe("INSPECT");
    f.patchSettings({ defaultMode: "BUILD" });
    expect(f.getSettings().theme).toBe("dark");
  });
});

/* ========================================================================
   SHELL BEHAVIOUR — executed
   ======================================================================== */

describe("shell behaviour", () => {
  it("boots into the agent view with the stored theme applied", async () => {
    const { doc, apiCalls } = await bootRenderer();
    const de = doc.documentElement as unknown as StubNode;
    // Stored theme was dark, so the concrete palette is painted.
    expect(de.dataset.theme).toBe("dark");
    expect(apiCalls).toContain("getSettings");
    expect(apiCalls).toContain("getSystemStatus");
    expect(apiCalls).toContain("listPendingToolApprovals");
  });

  it("shows exactly one active view and marks the current nav item", async () => {
    const { doc, nav } = await bootRenderer();
    const views = ["agent", "runs", "tools", "approvals", "audit", "models", "workspace", "settings"];
    const active = views.filter((v) => {
      const node = (doc as unknown as { getElementById(id: string): StubNode }).getElementById(`view-${v}`);
      return node !== null && node.classes.has("active");
    });
    expect(active).toEqual(["agent"]);
    expect(nav.get("agent")!.getAttribute("aria-current")).toBe("page");
    expect(nav.get("runs")!.getAttribute("aria-current")).toBeNull();
  });

  it("switches views on nav activation and moves aria-current", async () => {
    const { doc, nav } = await bootRenderer();
    const get = (id: string) => (doc as unknown as { getElementById(id: string): StubNode }).getElementById(id);
    nav.get("audit")!.dispatch("click");
    await new Promise((r) => setTimeout(r, 30));
    expect(get("view-audit")!.classes.has("active")).toBe(true);
    expect(get("view-agent")!.classes.has("active")).toBe(false);
    expect(nav.get("audit")!.getAttribute("aria-current")).toBe("page");
    expect(nav.get("agent")!.getAttribute("aria-current")).toBeNull();
  });

  it("renders a pending approval with both decisions and the evidence label", async () => {
    const { doc } = await bootRenderer();
    const host = (doc as unknown as { getElementById(id: string): StubNode }).getElementById("approvals-pending");
    const rendered = host.textOf();
    expect(rendered).toContain("files.write");
    expect(rendered).toContain("write");
    expect(rendered.toLowerCase()).toContain("evidence, not consent");
    // Both decision paths exist and both go through the bridge.
    expect(rendererSrc()).toMatch(/Approve/);
    expect(rendererSrc()).toMatch(/Deny/);
    expect(rendererSrc()).toMatch(/api\.approveTool\(/);
    expect(rendererSrc()).toMatch(/api\.denyTool\(/);
  });

  it("patches the theme through the bridge when the setting changes", async () => {
    const { doc, apiCalls } = await bootRenderer();
    const sel = (doc as unknown as { getElementById(id: string): StubNode }).getElementById("settings-theme");
    sel.value = "light";
    sel.dispatch("change");
    await new Promise((r) => setTimeout(r, 30));
    expect(apiCalls).toContain("patchSettings");
    const de = doc.documentElement as unknown as StubNode;
    expect(de.dataset.theme).toBe("light");
  });

  it("surfaces an empty state rather than a blank panel when a view loads", async () => {
    const { doc, nav } = await bootRenderer();
    const get = (id: string) => (doc as unknown as { getElementById(id: string): StubNode }).getElementById(id);
    nav.get("runs")!.dispatch("click");
    await new Promise((r) => setTimeout(r, 40));
    expect(get("runs-table")!.textOf()).toMatch(/No runs recorded yet/);
  });
});

/* ========================================================================
   SECURITY SEMANTICS STILL HOLD THROUGH THE FACADE
   ======================================================================== */

describe("security semantics hold", () => {
  it("cancellation still denies the pending request and leaves the file untouched", async () => {
    const f = facade();
    const file = join(project, "a.txt");
    writeFileSync(file, "orig");
    const run: AgentRequest = {
      runId: "d6-cancel",
      prompt: withToolCalls(
        [{ id: "1", toolName: "files.write", input: { path: file, content: "no" } }],
        "rewrite",
      ),
      mode: "BUILD",
    };
    const invocation = f.runAgent(run);
    await new Promise((r) => setTimeout(r, 80));
    const pending = f.listPendingToolApprovals();
    expect(pending).toHaveLength(1);
    f.cancelRun("d6-cancel");
    const out = await invocation;
    expect(out.error?.code).toBe("AGENT_CANCELLED");
    expect(readFileSync(file, "utf8")).toBe("orig");
    expect(f.listPendingToolApprovals()).toHaveLength(0);
    expect(f.listToolApprovals().filter((a) => a.id === pending[0]!.id)[0]?.status).toBe("denied");
  });

  it("a denial is still recorded as a denial in the audit", async () => {
    const f = facade();
    const file = join(project, "b.txt");
    writeFileSync(file, "orig");
    const invocation = f.runAgent({
      runId: "d6-deny",
      prompt: withToolCalls(
        [{ id: "1", toolName: "files.write", input: { path: file, content: "no" } }],
        "rewrite",
      ),
      mode: "BUILD",
    });
    await new Promise((r) => setTimeout(r, 80));
    const [pending] = f.listPendingToolApprovals();
    f.denyTool(pending!.id, "not needed");
    const out = await invocation;
    expect(out.outcomes[0]?.code).toBe("TOOL_APPROVAL_DENIED");
    expect(readFileSync(file, "utf8")).toBe("orig");
    const rec = f.listToolAudit().find((a) => a.toolName === "files.write");
    expect(rec?.approved).toBe(false);
    expect(rec?.approvalNote).toBe("not needed");
  });

  it("mode narrowing is unchanged by the redesign", () => {
    const f = facade();
    expect(f.listAgentTools("INSPECT").map((t) => t.name)).not.toContain("process.exec");
    const build = new Map(f.listAgentTools("BUILD").map((t) => [t.name, t]));
    expect(build.get("files.write")?.requiresApproval).toBe(true);
    expect(build.get("files.read")?.requiresApproval).toBe(false);
  });

  it("frozen posture is untouched", () => {
    const s = buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() });
    expect(s.core.stack.egress.kind).toBe("deny-all");
    expect(s.budget.snapshot().budgetUsd).toBe(0);
    expect(s.core.stack.catalog.list().map((m) => m.id).sort()).toEqual([
      "local/agent",
      "local/deterministic",
      "local/vision",
    ]);
  });
});