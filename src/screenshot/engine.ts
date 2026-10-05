/**
 * Screenshot engine. Bridges the browser engine and artifact storage: navigate,
 * capture, store, and return a stored artifact with provenance metadata.
 *
 * Determinism: identical (url, viewport, fullPage) inputs on unchanged content
 * produce identical bytes, hence an identical content-addressed artifact id.
 */
import type { BrowserEngine } from "../browser/types.ts";
import type { ArtifactStore, StoredArtifact } from "../artifacts/store.ts";
import type { ScreenshotRequest } from "../browser/types.ts";

export interface ScreenshotJob {
  readonly url: string;
  readonly fullPage?: boolean;
  readonly viewport?: { width: number; height: number };
  readonly waitForSelector?: string;
  readonly runId: string;
  readonly labels?: Record<string, string>;
}

export interface ScreenshotOutcome {
  readonly artifact: StoredArtifact;
  readonly title: string;
  readonly contentType: "image/png";
  readonly bytes: number;
}

export class ScreenshotEngine {
  private readonly engine: BrowserEngine;
  private readonly store: ArtifactStore;

  constructor(engine: BrowserEngine, store: ArtifactStore) {
    this.engine = engine;
    this.store = store;
  }

  async capture(job: ScreenshotJob): Promise<ScreenshotOutcome> {
    const page = await this.engine.open({
      url: job.url,
      fullPage: job.fullPage,
      viewport: job.viewport,
      navigation: {
        waitForSelector: job.waitForSelector,
        waitUntil: "load",
      },
    });
    try {
      const shot = await this.engine.capture(page, job.fullPage ?? false);
      const artifact = this.store.store({
        kind: "screenshot",
        bytes: shot.bytes,
        contentType: "image/png",
        runId: job.runId,
        sourceUrl: job.url,
        labels: job.labels,
      });
      return {
        artifact,
        title: shot.title,
        contentType: "image/png",
        bytes: shot.bytes.byteLength,
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  /** Batch capture with a single browser session; failures are per-job. */
  async captureAll(
    jobs: readonly ScreenshotJob[],
  ): Promise<ReadonlyArray<{ job: ScreenshotJob; outcome?: ScreenshotOutcome; error?: unknown }>> {
    const results: { job: ScreenshotJob; outcome?: ScreenshotOutcome; error?: unknown }[] = [];
    for (const job of jobs) {
      try {
        results.push({ job, outcome: await this.capture(job) });
      } catch (e) {
        results.push({ job, error: e });
      }
    }
    return results;
  }

  close(): Promise<void> {
    return this.engine.close();
  }
}

export type { ScreenshotRequest };
