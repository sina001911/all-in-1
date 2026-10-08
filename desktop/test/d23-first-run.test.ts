/**
 * D23: first-run onboarding surface. The card must exist, start local path
 * dismisses it in this app session, and adding a provider revisits Settings.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "desktop", "src");

describe("first-run onboarding", () => {
  it("renders a tiny first-run card in the agent view", () => {
    const html = readFileSync(join(SRC, "renderer", "index.html"), "utf8");
    expect(html).toContain('id="agent-first-run"');
    expect(html).toContain('id="first-run-local"');
    expect(html).toContain('id="first-run-provider"');
    expect(html).toContain('id="first-run-dismiss"');
  });

  it("renderer wires start offline and add provider buttons", () => {
    const renderer = readFileSync(join(SRC, "renderer", "renderer.js"), "utf8");
    expect(renderer).toContain("updateFirstRunCard");
    expect(renderer).toContain("firstRunDismissed");
    expect(renderer).toContain('showView("settings")');
    expect(renderer).toContain('el("first-run-local")');
  });

  it("no persistence or route/view additions are involved", () => {
    const main = readFileSync(join(SRC, "main.ts"), "utf8");
    const facade = readFileSync(join(SRC, "facade.ts"), "utf8");
    expect(main).not.toContain("firstRunDismissed");
    expect(facade).not.toContain("firstRunDismissed");
  });
});
