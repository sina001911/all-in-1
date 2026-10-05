/**
 * Detector suite: vite (npm + pnpm), static, and the generic fallback for
 * ambiguous projects. No project is ever left unsupported.
 */
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { detectProject } from "../src/project/detector.ts";
import { AdapterRegistry } from "../src/project/registry.ts";
import { genericAdapter } from "../src/project/adapters/generic.ts";
import { staticAdapter } from "../src/project/adapters/static.ts";
import { viteAdapter } from "../src/project/adapters/vite.ts";

const FIXTURES = resolve(import.meta.dirname, "fixtures");

function registry(): AdapterRegistry {
  const reg = new AdapterRegistry();
  reg.register(viteAdapter);
  reg.register(staticAdapter);
  reg.registerFallback(genericAdapter);
  return reg;
}

describe("project detection", () => {
  it("detects a Vite + React (npm) project", () => {
    const { adapter, detection } = detectProject(registry(), resolve(FIXTURES, "vite-basic"));
    expect(adapter.id).toBe("vite");
    expect(detection.confidence).toBeGreaterThan(0.6);
    expect(detection.evidence.some((e) => e.includes("vite.config"))).toBe(true);
  });

  it("detects a Vite + Vue project with pnpm lockfile", () => {
    const { adapter, detection } = detectProject(registry(), resolve(FIXTURES, "vite-pnpm"));
    expect(adapter.id).toBe("vite");
    expect(detection.evidence.some((e) => e.includes("personality: vue"))).toBe(true);
  });

  it("detects a plain static project", () => {
    const { adapter, detection } = detectProject(registry(), resolve(FIXTURES, "static-basic"));
    expect(adapter.id).toBe("static");
    expect(detection.confidence).toBeGreaterThan(0.5);
  });

  it("falls back to generic for ambiguous projects", () => {
    const { adapter, detection } = detectProject(registry(), resolve(FIXTURES, "ambiguous"));
    expect(adapter.id).toBe("generic");
    expect(detection.confidence).toBeLessThan(0.5);
  });

  it("always resolves — detection never throws for a real project", () => {
    const { adapter } = detectProject(registry(), resolve(FIXTURES, "static-basic"));
    expect(adapter).toBeDefined();
  });
});
