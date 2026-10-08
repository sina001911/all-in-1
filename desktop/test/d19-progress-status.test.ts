/**
 * D19: agent stream markers mirror the diagnostic workflow markers. No core,
 * IPC, or persistence change — progress state is rendered only, and a caller
 * must not claim `paused` unless the product lifecycle really supports it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "desktop", "src");

describe("unified progress rendering", () => {
  it("agent stream markers match workflow stream markers", () => {
    const renderer = readFileSync(join(SRC, "renderer", "renderer.js"), "utf8");
    expect(renderer).toContain("[workflow tool fragment] ");
    expect(renderer).toContain("[usage:");
    expect(renderer).toContain("[finish");
    expect(renderer.match(/\[workflow tool fragment\] /g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("final result still replaces the live progress row", () => {
    const renderer = readFileSync(join(SRC, "renderer", "renderer.js"), "utf8");
    expect(renderer).toContain("text(out, result.text)");
    expect(renderer).toContain("renderTranscript(result)");
  });
});
