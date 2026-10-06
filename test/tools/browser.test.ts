/**
 * browser.capture tests (D2).
 *
 * The tool adds no browser capability: it delegates to the existing
 * `ScreenshotEngine`, which enforces the frozen host policy inside `open()`.
 * These tests pin that delegation — a capture never escapes the host policy,
 * and the tool returns an artifact reference rather than raw bytes.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildToolRuntime } from "../../src/tools/index.ts";
import { WorkspaceManager } from "../../src/tools/workspace.ts";
import { InMemoryToolAuditLog } from "../../src/tools/audit.ts";
import { AllowAllApprover } from "../../src/tools/approval.ts";
import { FakeBrowserEngine } from "../../src/browser/fake-engine.ts";
import { ScreenshotEngine } from "../../src/screenshot/engine.ts";
import { ArtifactStore } from "../../src/artifacts/store.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-browser-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runtime() {
  const engine = new FakeBrowserEngine({ hostPolicy: "localhost-only" });
  const screenshot = new ScreenshotEngine(engine, new ArtifactStore({ baseDir: join(dir, "artifacts"), retentionDays: 1, keepRuns: 5 }));
  return {
    engine,
    ...buildToolRuntime({
      workspace: new WorkspaceManager({ roots: () => [dir] }),
      audit: new InMemoryToolAuditLog(),
      approver: new AllowAllApprover(),
      screenshotEngine: screenshot,
    }),
  };
}

async function capture(input: unknown) {
  const r = runtime();
  const out = await r.executor.execute({ toolName: "browser.capture", input, runId: "run-1" });
  return { out, engine: r.engine };
}

describe("browser.capture", () => {
  it("captures a localhost page into the artifact store", async () => {
    const { out, engine } = await capture({ url: "http://localhost:3000" });
    expect(out.ok).toBe(true);
    expect(engine.navigations).toContain("http://localhost:3000");
    const image = out.content[0];
    expect(image?.type).toBe("image");
    expect((image as { artifactId: string }).artifactId).toMatch(/^screenshot\/[0-9a-f]{64}\.png$/);
  });

  it("returns the title and artifact metadata, not the bytes", async () => {
    const { out } = await capture({ url: "http://localhost:8080" });
    expect(out.metadata).toMatchObject({ title: "Fake Page", url: "http://localhost:8080" });
    expect(JSON.stringify(out.content)).not.toContain("base64-png-bytes");
  });

  it("refuses a non-localhost host via the engine's own policy", async () => {
    const { out } = await capture({ url: "https://evil.example" });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("SCREENSHOT_FAILED");
  });

  it("rejects a viewport outside the allowed range", async () => {
    const { out } = await capture({ url: "http://localhost:3000", width: 99999, height: 100 });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("TOOL_VALIDATION_FAILED");
  });

  it("is registered only when a screenshot engine is supplied", () => {
    const without = buildToolRuntime({
      workspace: new WorkspaceManager({ roots: () => [dir] }),
      audit: new InMemoryToolAuditLog(),
    });
    expect(without.registry.has("browser.capture")).toBe(false);
    const withEngine = runtime();
    expect(withEngine.registry.has("browser.capture")).toBe(true);
  });

  it("honours fullPage and viewport options", async () => {
    const { out, engine } = await capture({
      url: "http://localhost:3000",
      fullPage: true,
      width: 800,
      height: 600,
    });
    expect(out.ok).toBe(true);
    expect(engine.navigations).toHaveLength(1);
  });
});
