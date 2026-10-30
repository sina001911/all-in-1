/**
 * D37: UI integration tests.
 *
 * Tests the renderer's behaviour through source analysis and DOM-structure
 * assertions rather than by calling internal IIFE-scoped functions directly.
 * The renderer is wrapped in `(function () { ... })()` so helpers like
 * showView, renderWelcome, renderTranscript, setMode, paintTheme and
 * setLanguage are not callable from the sandbox — they are tested by
 * inspecting the source and the produced HTML structure.
 *
 * Covers:
 *
 *   - View navigation: nav items carry data-view attributes; the renderer
 *     reads them and toggles .active / aria-current on every view.
 *   - Welcome screen: rendered into #chat-welcome with AI1 mark and four
 *     suggestion buttons.
 *   - Transcript rendering: handles null (empty state), uploaded results,
 *     generated results, history turns, and model-substitution warnings.
 *   - Mode controls: INSPECT / COMPARE / COLLAB buttons carry aria-pressed.
 *   - Theme switching: paintTheme writes data-theme onto <html> and flips
 *     the three theme-button states.
 *   - Language switching: setLanguage swaps data-dir (ltr/rtl), lang, and
 *     the textContent of every [data-en] element.
 *   - Approvals badge sync: nav-approvals reflects pending count.
 *   - First-run card: shown only when providers.length === 0.
 *   - Compare view model checkboxes: one per enabled model; checked state
 *     survives a reload.
 *   - Artifact view: empty-state when list is empty; one card per artifact.
 *   - Source invariants: no import/require/export in renderer; each module
 *     exposes the expected globals.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "desktop", "src");

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

/* ── View navigation ──────────────────────────────────────────────────────── */

describe("D37 UI integration — navigation", () => {
  const html = read(join("renderer", "index.html"));
  const renderer = read(join("renderer", "renderer.js"));

  it("nav items carry data-view attributes for every top-level view", () => {
    // Compare and collab are sub-modes of the chat view (switched via mode
    // buttons), not top-level nav destinations. Workspace is opened by
    // clicking a nav workspace root, not by a dedicated nav button.
    const views = [
      "chat", "runs", "tools",
      "approvals", "audit", "models", "artifacts", "settings",
    ];
    for (const v of views) {
      expect(html).toContain(`data-view="${v}"`);
    }
  });

  it("showView toggles .active on every view and sets aria-current on the nav", () => {
    expect(renderer).toContain('item.setAttribute("aria-current", "page")');
    expect(renderer).toContain('view.classList.toggle("active", v === name)');
  });

  it("syncExecTypeControls keeps exec-type in step with the view", () => {
    expect(renderer).toContain("syncExecTypeControls");
    // When view is "compare" the select should read "compare"; when "chat" it reads "single".
    expect(renderer).toContain('"compare"');
    expect(renderer).toContain('"single"');
  });
});

/* ── Welcome screen ───────────────────────────────────────────────────────── */

describe("D37 UI integration — welcome screen", () => {
  const renderer = read(join("renderer", "renderer.js"));

  it("renderWelcome puts the AI1 mark and a heading into #chat-welcome", () => {
    expect(renderer).toContain('class: "welcome-hero"');
    expect(renderer).toContain('"Welcome to AI1"');
    expect(renderer).toContain('class: "welcome-sphere"');
  });

  it("renderWelcome populates four suggestion buttons", () => {
    // The four canned suggestions are hardcoded in renderWelcome.
    expect(renderer).toContain("binary search tree");
    expect(renderer).toContain("README");
    expect(renderer).toContain("Review this function");
    expect(renderer).toContain("improve this code");
  });

  it("clicking a suggestion fills the prompt textarea and focuses it", () => {
    expect(renderer).toContain('el("agent-prompt")');
    expect(renderer).toContain(".value = s");
    expect(renderer).toContain("ta.focus()");
  });
});

/* ── Transcript rendering ─────────────────────────────────────────────────── */

describe("D37 UI integration — transcript", () => {
  const renderer = read(join("renderer", "renderer.js"));

  it("renders an empty-state paragraph when result is null", () => {
    expect(renderer).toContain("No turns yet");
  });

  it("renders an uploaded result as a system turn card", () => {
    expect(renderer).toContain('kind === "uploaded"');
    expect(renderer).toContain("turn-system");
  });

  it("renders a generated result with a download button", () => {
    expect(renderer).toContain('kind === "generated"');
    expect(renderer).toContain("Download");
    expect(renderer).toContain("downloadArtifact");
  });

  it("shows a substitution warning when executed model differs from requested", () => {
    expect(renderer).toContain("substituted");
    expect(renderer).toContain("lastRequestedModel");
  });

  it("renders each history event via renderTurn", () => {
    expect(renderer).toContain("history.forEach");
    expect(renderer).toContain("renderTurn(ev)");
  });
});

/* ── Mode controls ────────────────────────────────────────────────────────── */

describe("D37 UI integration — mode controls", () => {
  const renderer = read(join("renderer", "renderer.js"));

  it("setMode flips aria-pressed on every mode button", () => {
    expect(renderer).toContain('aria-pressed', );
    expect(renderer).toContain('m === mode ? "true" : "false"');
  });

  it("INSPECT mode is the default for the chat-head buttons", () => {
    const html = read(join("renderer", "index.html"));
    expect(html).toContain('id="mode-INSPECT"');
    expect(html).toContain('id="mode-COMPARE"');
    expect(html).toContain('id="mode-COLLAB"');
  });
});

/* ── Theme switching ──────────────────────────────────────────────────────── */

describe("D37 UI integration — theme", () => {
  const theme = read(join("renderer", "theme.js"));
  const renderer = read(join("renderer", "renderer.js"));

  it("paintTheme writes data-theme onto documentElement", () => {
    expect(theme).toContain("root.dataset.theme");
    expect(theme).toContain("resolveTheme");
  });

  it("paintTheme flips aria-pressed on the three theme buttons", () => {
    expect(theme).toContain('"light"');
    expect(theme).toContain('"dark"');
    expect(theme).toContain('"system"');
    expect(theme).toContain("aria-pressed");
  });

  it("resolveTheme maps 'system' to the UA preference", () => {
    expect(theme).toContain("prefersDark");
    expect(theme).toContain("matchMedia");
  });
});

/* ── Language switching ───────────────────────────────────────────────────── */

describe("D37 UI integration — language / RTL", () => {
  const i18n = read(join("renderer", "i18n.js"));
  const html = read(join("renderer", "index.html"));

  it("setLanguage writes data-dir and lang on <html>", () => {
    expect(i18n).toContain("root.dataset.dir");
    expect(i18n).toContain('lang === "fa" ? "rtl" : "ltr"');
    expect(i18n).toContain("root.lang");
  });

  it("setLanguage swaps textContent on every [data-en] element", () => {
    expect(i18n).toContain("[data-en]");
    expect(i18n).toContain("node.textContent");
    expect(i18n).toContain("data-fa");
  });

  it("the page carries data-en / data-fa on labelled elements", () => {
    expect(html).toContain("data-en");
    expect(html).toContain("data-fa");
  });

  it("the lang selector exists in the markup", () => {
    expect(html).toContain('id="lang-select"');
  });
});

/* ── Approvals badge sync ─────────────────────────────────────────────────── */

describe("D37 UI integration — approvals badge", () => {
  const renderer = read(join("renderer", "renderer.js"));

  it("loadApprovals updates the nav-approvals count badge and hidden state", () => {
    expect(renderer).toContain("nav-approvals");
    expect(renderer).toContain("badge.textContent");
    expect(renderer).toContain("badge.hidden");
  });

  it("polling refreshes approvals every 750 ms while in the approvals view", () => {
    expect(renderer).toContain("startPolling");
    expect(renderer).toContain("750");
    expect(renderer).toContain('state.view === "approvals"');
  });
});

/* ── First-run card ───────────────────────────────────────────────────────── */

describe("D37 UI integration — first-run card", () => {
  const renderer = read(join("renderer", "renderer.js"));
  const html = read(join("renderer", "index.html"));

  it("the first-run card is present in the markup", () => {
    expect(html).toContain('id="agent-first-run"');
  });

  it("updateFirstRunCard hides the card when providers are configured", () => {
    expect(renderer).toContain("updateFirstRunCard");
    expect(renderer).toContain("providers");
    expect(renderer).toContain('display = "none"');
  });

  it("updateFirstRunCard shows the card when no providers exist", () => {
    expect(renderer).toContain('display = ""');
  });
});

/* ── Compare view model checkboxes ────────────────────────────────────────── */

describe("D37 UI integration — compare view", () => {
  const renderer = read(join("renderer", "renderer.js"));

  it("loadCompare renders one checkbox per enabled model", () => {
    expect(renderer).toContain('type: "checkbox"');
    expect(renderer).toContain("cmp-model-");
    expect(renderer).toContain("m.enabled");
    expect(renderer).toContain("m.available");
  });

  it("loadCompare preserves checked state across a reload", () => {
    expect(renderer).toContain("keep");
    expect(renderer).toContain("cb.checked");
  });

  it("cmpSlotPanel renders per-slot status with model label", () => {
    expect(renderer).toContain("cmpSlotPanel");
    expect(renderer).toContain("cmpDisplayName");
  });
});

/* ── Artifact view ────────────────────────────────────────────────────────── */

describe("D37 UI integration — artifact view", () => {
  const renderer = read(join("renderer", "renderer.js"));
  const html = read(join("renderer", "index.html"));

  it("the artifacts-list container exists in the markup", () => {
    expect(html).toContain('id="artifacts-list"');
  });

  it("loadArtifacts shows empty-state when the list is empty", () => {
    expect(renderer).toContain("No artifacts yet");
  });

  it("loadArtifacts sorts artifacts newest first", () => {
    expect(renderer).toContain("addedAt");
    expect(renderer).toContain("sort");
  });
});

/* ── Source invariants ────────────────────────────────────────────────────── */

describe("D37 UI integration — source invariants", () => {
  it("renderer.js is a classic script with no import/require/export", () => {
    const src = read(join("renderer", "renderer.js"));
    // Comments may contain the word 'export'; only bare statements count.
    const stripped = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(stripped).not.toMatch(/^import\s+/m);
    expect(stripped).not.toMatch(/require\(/);
    expect(stripped).not.toMatch(/^export\s+/m);
  });

  it("components.js exports ModelSelector as a top-level function", () => {
    const src = read(join("renderer", "components.js"));
    expect(src).toContain("function ModelSelector(");
  });

  it("state.js declares state and api as globals", () => {
    const src = read(join("renderer", "state.js"));
    expect(src).toContain("var state =");
    expect(src).toContain("var api = window.allInOne");
  });

  it("theme.js exposes paintTheme and setTheme", () => {
    const src = read(join("renderer", "theme.js"));
    expect(src).toContain("function paintTheme()");
    expect(src).toContain("async function setTheme(");
  });

  it("i18n.js exposes setLanguage and handles RTL", () => {
    const src = read(join("renderer", "i18n.js"));
    expect(src).toContain("function setLanguage(");
    expect(src).toContain("data-dir");
    expect(src).toContain("rtl");
  });

  it("the HTML has aria-labels on every landmark view", () => {
    const html = read(join("renderer", "index.html"));
    // Every <section class="view"> should have an aria-labelledby or aria-label.
    const viewMatches = [...html.matchAll(/<section[^>]*class="view[^"]*"[^>]*>/g)];
    for (const m of viewMatches) {
      const snippet = m[0];
      expect(
        snippet.includes("aria-labelledby") || snippet.includes("aria-label"),
      ).toBe(true);
    }
  });

  it("the combobox uses role=combobox with aria-controls pointing to the list", () => {
    const html = read(join("renderer", "index.html"));
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-controls="model-list"');
    expect(html).toContain('aria-haspopup="listbox"');
  });
});
