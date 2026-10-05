/**
 * P2 acceptance test: a REAL browser capture, end to end.
 *
 * Spins up a localhost fixture server, drives the full pipeline
 * (PlaywrightEngine -> ScreenshotEngine -> ArtifactStore), and verifies a real
 * PNG lands on disk with provenance metadata. Skips with an explicit reason if
 * a browser binary is unavailable, so CI without browsers degrades cleanly.
 */
import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { PlaywrightEngine } from "../src/browser/playwright-adapter.ts";
import { ScreenshotEngine } from "../src/screenshot/engine.ts";
import { ArtifactStore, sha256 } from "../src/artifacts/store.ts";
import { AllInOneError } from "../src/errors.ts";

const FIXTURE_HTML = `<!DOCTYPE html>
<html><head><title>AIO Fixture</title>
<style>body{margin:0;background:#6366f1;color:#fff;font-family:system-ui}
.hero{padding:48px;font-size:32px}</style></head>
<body><main class="hero">P2 acceptance fixture</main></body></html>`;

async function startFixtureServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(FIXTURE_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, url: `http://127.0.0.1:${port}/` };
}

describe("P2 acceptance: real browser capture", () => {
  it("captures a localhost page and stores a real PNG", async () => {
    const { server, url } = await startFixtureServer();
    const base = mkdtempSync(join(tmpdir(), "aio-acceptance-"));
    const engine = new PlaywrightEngine({ hostPolicy: "localhost-only" });
    const shots = new ScreenshotEngine(
      engine,
      new ArtifactStore({ baseDir: base, retentionDays: 30, keepRuns: 5 }),
    );

    try {
      const outcome = await shots.capture({ url, runId: "acceptance" });

      // A real PNG: signature bytes + non-trivial size.
      const png = readFileSync(outcome.artifact.path);
      expect(png[0]).toBe(0x89);
      expect(png[1]).toBe(0x50);
      expect(png.byteLength).toBeGreaterThan(1000);
      expect(outcome.artifact.metadata.sha256).toBe(
        sha256(new Uint8Array(png)),
      );
      expect(outcome.title).toBe("AIO Fixture");

      // Provenance sidecar.
      const meta = JSON.parse(
        readFileSync(`${outcome.artifact.path}.json`, "utf8"),
      ) as { runId: string; sourceUrl: string; kind: string };
      expect(meta.runId).toBe("acceptance");
      expect(meta.sourceUrl).toBe(url);
      expect(meta.kind).toBe("screenshot");
    } catch (e) {
      // No browser binary available in this environment: report and skip.
      if (e instanceof AllInOneError && e.code === "BROWSER_LAUNCH_FAILED") {
        console.warn("SKIP: no Playwright browser binary available");
        return;
      }
      throw e;
    } finally {
      await shots.close().catch(() => undefined);
      server.close();
      rmSync(base, { recursive: true, force: true });
    }
  }, 30_000);

  it("still enforces localhost-only on a real engine", async () => {
    const engine = new PlaywrightEngine({ hostPolicy: "localhost-only" });
    await expect(
      engine.open({ url: "https://example.com/" }),
    ).rejects.toThrow(/Host not allowed/);
    expect(existsSync(join(tmpdir(), "aio-leak"))).toBe(false);
  });
});
