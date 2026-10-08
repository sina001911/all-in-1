/**
 * D22 packaging foundation: the desktop has a scripts path for building a real
 * artifact, and electron is a declared runtime dependency.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

describe("desktop package foundation", () => {
  it("package.json declares electron and desktop scripts", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Record<string, unknown> & { scripts: Record<string, string>; devDependencies: Record<string, string> };
    expect(pkg.devDependencies.electron).toBeDefined();
    expect(pkg.scripts["desktop:dist"]).toBeDefined();
    expect(pkg.scripts["desktop:dev"]).toBeDefined();
    expect(pkg.scripts["desktop:selftest"]).toBeDefined();
  });

  it("the built artifacts exist after bundling", () => {
    expect(existsSync(join(ROOT, "dist", "desktop", "main.mjs"))).toBe(true);
    expect(existsSync(join(ROOT, "dist", "desktop", "preload.cjs"))).toBe(true);
    expect(existsSync(join(ROOT, "dist", "desktop", "renderer", "index.html"))).toBe(true);
  });

  it("source still has the first-run hint and the bottoms stay open", () => {
    const html = readFileSync(join(ROOT, "desktop", "src", "renderer", "index.html"), "utf8");
    expect(html).toContain("First run?");
    expect(html).toContain("Settings");
  });
});
