/**
 * Adapter suite: dev/build/test/URL/file contracts for generic, static, and
 * vite adapters, including package-manager detection.
 */
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { genericAdapter } from "../src/project/adapters/generic.ts";
import { staticAdapter } from "../src/project/adapters/static.ts";
import { viteAdapter, detectPackageManager } from "../src/project/adapters/vite.ts";

const FIXTURES = resolve(import.meta.dirname, "fixtures");

describe("vite adapter", () => {
  it("emits an npm dev command for the npm fixture", () => {
    const cmd = viteAdapter.getDevCommand(resolve(FIXTURES, "vite-basic"));
    expect(cmd).not.toBeNull();
    expect(cmd?.command).toBe("npm");
    expect(cmd?.args).toEqual(["run", "dev"]);
    expect(cmd?.readyPattern).toContain("Local:");
  });

  it("emits a pnpm dev command for the pnpm fixture", () => {
    const cmd = viteAdapter.getDevCommand(resolve(FIXTURES, "vite-pnpm"));
    expect(cmd?.command).toBe("pnpm");
  });

  it("discovers the dev URL from stdout", () => {
    const url = viteAdapter.getDevUrl(resolve(FIXTURES, "vite-basic"));
    expect(url?.kind).toBe("discovered");
    expect(url?.discovery).toBe("stdout");
  });

  it("maps relevant files, preferring a section guess", () => {
    const files = viteAdapter.getRelevantFiles(resolve(FIXTURES, "vite-basic"), {
      section: "hero",
    });
    expect(files).toContain("index.html");
  });

  it("detects the package manager from lockfiles", () => {
    expect(detectPackageManager(resolve(FIXTURES, "vite-pnpm"))).toBe("pnpm");
    expect(detectPackageManager(resolve(FIXTURES, "vite-basic"))).toBe("npm");
  });
});

describe("static adapter", () => {
  it("produces no build command", () => {
    expect(staticAdapter.getBuildCommand(resolve(FIXTURES, "static-basic"))).toBeNull();
  });

  it("lists static assets as relevant files", () => {
    const files = staticAdapter.getRelevantFiles(resolve(FIXTURES, "static-basic"));
    expect(files.some((f) => f.endsWith("index.html"))).toBe(true);
    expect(files.some((f) => f.endsWith("style.css"))).toBe(true);
  });
});

describe("generic adapter", () => {
  it("never claims a dev command it cannot prove", () => {
    expect(genericAdapter.getDevCommand(resolve(FIXTURES, "ambiguous"))).toBeNull();
  });

  it("still lists relevant files as the fallback", () => {
    const files = genericAdapter.getRelevantFiles(resolve(FIXTURES, "ambiguous"));
    expect(Array.isArray(files)).toBe(true);
  });
});
