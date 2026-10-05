/**
 * Screenshot engine suite: capture -> store pipeline, determinism, batch
 * isolation, and resource cleanup, all without a real browser.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScreenshotEngine } from "../src/screenshot/engine.ts";
import { ArtifactStore } from "../src/artifacts/store.ts";
import { FakeBrowserEngine, fakePng } from "../src/browser/fake-engine.ts";
import { sha256 } from "../src/artifacts/store.ts";

function harness() {
  const base = mkdtempSync(join(tmpdir(), "aio-shot-"));
  const engine = new FakeBrowserEngine({ hostPolicy: "localhost-only" });
  const store = new ArtifactStore({ baseDir: base, retentionDays: 30, keepRuns: 5 });
  return { base, shots: new ScreenshotEngine(engine, store), engine, store };
}

const URL = "http://localhost:5173/";

describe("screenshot engine", () => {
  it("captures, stores, and records provenance", async () => {
    const { base, shots } = harness();
    const outcome = await shots.capture({ url: URL, runId: "run-1" });

    expect(outcome.contentType).toBe("image/png");
    expect(outcome.bytes).toBeGreaterThan(0);
    expect(outcome.artifact.metadata.kind).toBe("screenshot");
    expect(outcome.artifact.metadata.runId).toBe("run-1");
    expect(outcome.artifact.metadata.sourceUrl).toBe(URL);
    expect(outcome.artifact.metadata.sha256).toBe(sha256(fakePng(URL)));
    rmSync(base, { recursive: true, force: true });
  });

  it("is deterministic for the same url", async () => {
    const { base, shots } = harness();
    const a = await shots.capture({ url: URL, runId: "r1" });
    const b = await shots.capture({ url: URL, runId: "r2" });
    expect(b.artifact.metadata.artifactId).toBe(a.artifact.metadata.artifactId);
    rmSync(base, { recursive: true, force: true });
  });

  it("isolates per-job failures in a batch", async () => {
    const { base, engine, shots } = harness();
    engine.failNavigation = true;
    const results = await shots.captureAll([
      { url: URL, runId: "r1" },
      { url: "http://localhost:3000/", runId: "r2" },
    ]);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.error !== undefined)).toBe(true);
    expect(results.every((r) => r.outcome === undefined)).toBe(true);
    rmSync(base, { recursive: true, force: true });
  });

  it("closes the underlying engine", async () => {
    const { base, engine, shots } = harness();
    await shots.capture({ url: URL, runId: "r1" });
    await shots.close();
    expect(engine.isActive()).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });

  it("refuses non-localhost targets through the pipeline", async () => {
    const { base, shots } = harness();
    await expect(
      shots.capture({ url: "https://example.com/", runId: "r1" }),
    ).rejects.toThrow(/Host not allowed/);
    rmSync(base, { recursive: true, force: true });
  });
});
