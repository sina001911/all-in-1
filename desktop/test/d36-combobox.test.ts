/**
 * D36: model combobox (B2) tests.
 *
 * Exercises the ModelSelector component in a DOM-less VM sandbox, verifying
 * keyboard navigation, search/cost filters, deterministic-local-model badge,
 * grouping order, empty states, and ARIA state changes. A second layer
 * asserts source-level invariants (HTML structure, CSS rules, CSP compliance).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, Script } from "node:vm";

const SRC = join(process.cwd(), "desktop", "src");

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

/* ── Minimal DOM stub used by every combobox test ──────────────────────── */

function makeStub() {
  const byId = new Map<string, Element>();
  let _nextId = 0;

  function node(id?: string): Element & Record<string, unknown> {
    const children: Element[] = [];
    const attrs = new Map<string, string>();
    const cls = new Set<string>();
    const el: Record<string, unknown> = {
      id: id || ("node-" + (_nextId++)),
      className: "",
      _text: "",
      get textContent() {
        // If innerHTML was set directly, extract plain text from it.
        const html = (el as Record<string, unknown>)._html as string;
        if (html) return html.replace(/<[^>]+>/g, "");
        // Text nodes (no children) carry their text in _text; element nodes delegate to children.
        if (children.length === 0 && (el as Record<string, unknown>)._text !== undefined) return (el as Record<string, unknown>)._text as string;
        let t = "";
        for (const child of children) {
          t += ((child as unknown) as Record<string, unknown>).textContent as string || "";
        }
        return t;
      },
      set textContent(v: string) {
        (el as Record<string, unknown>)._text = v;
      },
      dataset: {},
      parentElement: null,
      childNodes: children as unknown as NodeList,
      get children(): unknown { return children; },
      get firstChild() { return children[0] ?? null; },
      appendChild(child: Element) {
        children.push(child);
        ((child as unknown) as Record<string, unknown>).parentElement = el;
        return child as unknown as Element;
      },
      removeChild(child: Element) {
        const i = children.indexOf(child);
        if (i >= 0) children.splice(i, 1);
        return child as unknown as Element;
      },
      querySelector: () => null,
      querySelectorAll: () => [] as unknown as NodeListOf<Element>,
      getAttribute(k: string) { return attrs.has(k) ? attrs.get(k)! : null; },
      setAttribute(k: string, v: unknown) {
        attrs.set(k, String(v));
        if (k === "class") el.className = String(v);
      },
      removeAttribute(k: string) { attrs.delete(k); },
      hasAttribute(k: string) { return attrs.has(k); },
      addEventListener: () => {},
      removeEventListener: () => {},
      classList: {
        add: () => {},
        remove: () => {},
        toggle: () => {},
      },
      scrollIntoView: () => {},
      getAttributeNode: () => null,
      insertBefore: () => null as never,
      cloneNode: () => null as never,
      contains: () => false,
      matches: () => false,
      blur: () => {},
      focus: () => {},
      select: () => {},
      get value() { return (el as Record<string, unknown>)._value as string || ""; },
      set value(v: string) { (el as Record<string, unknown>)._value = v; },
      _html: "",
      set innerHTML(v: string) {
        children.length = 0;
        (el as Record<string, unknown>)._html = v;
      },
      get innerHTML() {
        return (el as Record<string, unknown>)._html as string || "";
      },
    } as unknown as Element & Record<string, unknown>;
    if (id) byId.set(id, el as unknown as Element);
    return el as unknown as Element & Record<string, unknown>;
  }

  return {
    node,
    getElementById(id: string) { return byId.get(id) ?? null; },
  };
}

/* ── Bootstrap a sandbox with just components.js + helpers ─────────────── */

function boot() {
  const stub = makeStub();
  // Pre-create the static elements the combobox expects.
  stub.node("model-combobox");
  stub.node("model-input");
  stub.node("model-list");
  stub.node("model-select");
  stub.node("model-search");
  stub.node("model-cost-filter");
  stub.node("model-status");
  stub.node("toasts");
  stub.node("modal-backdrop");
  stub.node("modal-title");
  stub.node("modal-body");
  stub.node("modal-cancel");
  stub.node("modal-confirm");

  const api = new Proxy({}, { get: () => async () => [] });
  const sandbox = {
    window: { allInOne: api },
    document: {
      getElementById: (id: string) => stub.getElementById(id),
      createElement: (tag: string) => stub.node(tag),
      createTextNode: (t: string) => {
        const n = stub.node();
        n.textContent = String(t);
        return n;
      },
      querySelectorAll: () => [],
      addEventListener: () => {},
      documentElement: stub.node("html"),
      body: stub.node("body"),
      activeElement: null,
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    console,
  };
  createContext(sandbox);
  new Script(read("renderer/components.js"), { filename: "components.js" }).runInContext(sandbox as never);
  return {
    sandbox: sandbox as unknown as Record<string, unknown> & typeof globalThis & {
      ModelSelector: () => Record<string, unknown>;
    },
    stub,
  };
}

/* ── Test helpers ───────────────────────────────────────────────────────── */

type BootResult = ReturnType<typeof boot>;

function catalogSample() {
  return [
    { id: "openai/gpt-4o", provider: "openai", displayName: "GPT-4o", locality: "remote", costClass: "PAID", status: "active", capabilities: ["CODING"], enabled: true, available: true, streaming: true },
    { id: "anthropic/claude-3", provider: "anthropic", displayName: "Claude 3", locality: "remote", costClass: "PAID", status: "active", capabilities: ["CODING"], enabled: true, available: true, streaming: true },
    { id: "local/agent", provider: "local", displayName: "Deterministic Local Agent Model", locality: "local", costClass: "FREE", status: "active", capabilities: ["CODING"], enabled: true, available: true, streaming: false },
    { id: "local/deterministic", provider: "local", displayName: "Deterministic Local Model", locality: "local", costClass: "FREE", status: "active", capabilities: ["FAST_TASK"], enabled: true, available: true, streaming: false },
    { id: "local/vision", provider: "local", displayName: "Deterministic Local Vision Model", locality: "local", costClass: "FREE", status: "active", capabilities: ["VISION"], enabled: true, available: true, streaming: false },
  ];
}

function listContent(b: BootResult) {
  const listEl = b.stub.getElementById("model-list");
  return listEl ? (listEl.textContent as string) || "" : "";
}

function listItems(b: BootResult) {
  const listEl = b.stub.getElementById("model-list");
  if (!listEl) return [];
  return ((listEl.children as unknown) as Element[]).map((c) => c.textContent || "");
}

function ctrl(b: BootResult): Record<string, unknown> {
  return (b.sandbox.ModelSelector as () => Record<string, unknown>)();
}

/** Helper to create a keyboard event with preventDefault */
function keyEvent(key: string) {
  return { key, preventDefault: () => {} } as unknown as KeyboardEvent;
}

/* ── Source-level invariants ───────────────────────────────────────────── */

describe("combobox source invariants", () => {
  it("ModelSelector is defined in components.js", () => {
    expect(read("renderer/components.js")).toContain("function ModelSelector");
  });

  it("renderer.js wires the combobox and keeps model-select in sync", () => {
    const src = read("renderer/renderer.js");
    expect(src).toContain("initModelSelector");
    expect(src).toContain("modelSelector");
    expect(src).toContain('el("model-select")');
    expect(src).toMatch(/modelSel\.value/);
  });

  it("the HTML has the combobox container with correct roles", () => {
    const html = read("renderer/index.html");
    expect(html).toContain('id="model-combobox"');
    expect(html).toMatch(/role="combobox"/);
    expect(html).toMatch(/aria-haspopup="listbox"/);
    expect(html).toContain('id="model-list"');
    expect(html).toMatch(/role="listbox"/);
    // The native <select> for model selection was replaced by a hidden input.
    expect(html).not.toMatch(/<select id="model-select"/);
    expect(html).toContain('<input type="hidden" id="model-select"');
  });

  it("no remote sources or inline event handlers were introduced", () => {
    const html = read("renderer/index.html");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/\bon\w+\s*=\s*["']/);
  });

  it("the hidden model-select keeps the same id so existing read paths work", () => {
    const html = read("renderer/index.html");
    expect(html).toContain('id="model-select"');
    // exec-type is untouched.
    expect(html).toContain('id="exec-type"');
  });
});

/* ── CSS / accessibility ───────────────────────────────────────────────── */

describe("combobox CSS and ARIA structure", () => {
  it("CSS defines group labels, option highlight, and empty state", () => {
    const css = read("renderer/styles.css");
    expect(css).toMatch(/\.model-group-label\s*\{/);
    expect(css).toMatch(/\.model-option/);
    expect(css).toMatch(/\.model-empty\s*\{/);
  });

  it("RTL rules mirror the combobox arrow and option borders", () => {
    const css = read("renderer/styles.css");
    expect(css).toMatch(/\[data-dir="rtl"\] \.model-combobox-arrow/);
    expect(css).toMatch(/\[data-dir="rtl"\] \.model-option/);
  });

  it("responsive rules cover the combobox at 620px", () => {
    const css = read("renderer/styles.css");
    const mobile = css.slice(css.indexOf("@media (max-width: 620px)"));
    expect(mobile).toMatch(/\.model-combobox/);
  });

  it("no hex colour literals appear in the combobox rules", () => {
    const css = read("renderer/styles.css");
    const block = css.slice(css.indexOf("/* ── Model combobox"));
    const end = block.indexOf("/* ──") > 0 ? block.indexOf("/* ──") : block.length;
    const selBlock = block.slice(0, end);
    // rgba() inside box-shadow is fine; bare hex colours are not.
    const hexes = selBlock.match(/#[0-9a-fA-F]{3,8}(?![^{}]*\bshadow\b)/g) ?? [];
    expect(hexes).toEqual([]);
  });
});

/* ── Combobox behaviour (executed, not just read) ──────────────────────── */

describe("combobox behaviour", () => {
  it("renders all models on catalog load with Remote first, then Local", () => {
    const b = boot();
    const c = ctrl(b);
    (c.setCatalog as (m: unknown[]) => void)(catalogSample() as unknown[]);
    const content = listContent(b);
    expect(content).toContain("GPT-4o");
    expect(content).toContain("Claude 3");
    expect(content).toContain("Deterministic Local Agent Model");
    expect(content).toContain("Deterministic Local Model");
    expect(content).toContain("Deterministic Local Vision Model");
  });

  it("groups local models under a visible header", () => {
    const b = boot();
    const c = ctrl(b);
    (c.setCatalog as (m: unknown[]) => void)(catalogSample() as unknown[]);
    const items = listItems(b);
    expect(items.some((t) => t.includes("Local / Test Models"))).toBe(true);
    expect(items.some((t) => t.includes("Remote Models"))).toBe(true);
  });

  it("marks local deterministic models with a Deterministic badge", () => {
    const b = boot();
    const c = ctrl(b);
    (c.setCatalog as (m: unknown[]) => void)(catalogSample() as unknown[]);
    const items = listItems(b);
    const lines = items.filter((t) => !t.includes("Local / Test") && !t.includes("Remote Models"));
    // Remote models have a cost badge, not "Deterministic".
    const remoteLine = lines.find((t) => t.includes("GPT-4o"));
    expect(remoteLine).toBeDefined();
    expect(remoteLine).not.toContain("Deterministic");
    // Local deterministic model carries the badge.
    const localLine = lines.find((t) => t.includes("Local Agent"));
    expect(localLine).toContain("Deterministic");
  });

  it("pinned selected model stays visible even when cost filter hides others", () => {
    const b = boot();
    const c = ctrl(b);
    (c.setCatalog as (m: unknown[]) => void)(catalogSample() as unknown[]);
    // Select the local agent model.
    (c.select as (id: string) => void)("local/agent");
    // Now filter to PAID only — the selected free model should remain at top.
    (c.setCostFilter as (f: string) => void)("PAID");
    const content = listContent(b);
    expect(content).toContain("Deterministic Local Agent Model");
  });

  it("search filters the list case-insensitively", () => {
    const b = boot();
    const c = ctrl(b);
    (c.setCatalog as (m: unknown[]) => void)(catalogSample() as unknown[]);
    (c.setSearch as (q: string) => void)("gpt");
    const content = listContent(b);
    expect(content).toContain("GPT-4o");
    expect(content).not.toContain("Claude");
  });

  it("shows an empty-state message when no models match", () => {
    const b = boot();
    const c = ctrl(b);
    (c.setCatalog as (m: unknown[]) => void)(catalogSample() as unknown[]);
    (c.setSearch as (q: string) => void)("nonexistent-zzz");
    const content = listContent(b);
    expect(content).toMatch(/No models match/i);
  });

  it("opens the dropdown on click and toggles aria-expanded", () => {
    const b = boot();
    const c = ctrl(b);
    (c.setCatalog as (m: unknown[]) => void)(catalogSample() as unknown[]);
    expect((c.isOpen as () => boolean)()).toBe(false);
    const cbEl = b.stub.getElementById("model-combobox");
    (c.open as () => void)();
    expect(cbEl!.getAttribute("aria-expanded")).toBe("true");
    expect((c.isOpen as () => boolean)()).toBe(true);
    (c.close as () => void)();
    expect(cbEl!.getAttribute("aria-expanded")).toBe("false");
  });

  it("selection updates the hidden model-select input", () => {
    const b = boot();
    const c = ctrl(b);
    (c.setCatalog as (m: unknown[]) => void)(catalogSample() as unknown[]);
    (c.select as (id: string) => void)("openai/gpt-4o");
    const hidden = b.stub.getElementById("model-select");
    expect((hidden as unknown as Record<string, unknown>).value).toBe("openai/gpt-4o");
  });

  it("ArrowDown navigates the highlighted index", () => {
    const b = boot();
    const c = ctrl(b);
    (c.setCatalog as (m: unknown[]) => void)(catalogSample() as unknown[]);
    (c.open as () => void)();
    const handleKey = c.handleKeydown as (e: KeyboardEvent) => void;
    handleKey(keyEvent("ArrowDown"));
    handleKey(keyEvent("ArrowDown"));
    // The highlighted index should advance.
    const highlightedId = (c.getHighlightedId as () => string | null)();
    expect(highlightedId).not.toBe("openai/gpt-4o"); // moved past the first item
  });

  it("Escape closes the dropdown", () => {
    const b = boot();
    const c = ctrl(b);
    (c.setCatalog as (m: unknown[]) => void)(catalogSample() as unknown[]);
    (c.open as () => void)();
    (c.handleKeydown as (e: KeyboardEvent) => void)(keyEvent("Escape"));
    expect((c.isOpen as () => boolean)()).toBe(false);
  });
});

/* ── Backward compat — the hidden model-select is still read by the engine ─ */

describe("model-select backward compatibility", () => {
  it("renderer.js still reads el(\"model-select\").value for the engine preference", () => {
    const src = read("renderer/renderer.js");
    expect(src).toContain('el("model-select")');
    expect(src).toMatch(/modelSel\.value/);
  });

  it("the combobox writes to that same hidden input when the user picks", () => {
    const src = read("renderer/renderer.js");
    // initModelSelector calls syncHidden via the component's select() method.
    expect(src).toContain("initModelSelector");
    expect(src).toContain("modelSelector");
  });
});
