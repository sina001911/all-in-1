/**
 * D35: the artifact surface, end to end.
 *
 * The artifact store is content-addressed and confined to a base directory.
 * This file drives the desktop wiring — the facade methods, the IPC channel
 * boundary, and the collab-progress poll — without a window:
 *
 *   - `listArtifacts` returns every stored artifact, newest first;
 *   - `getArtifact` reads bytes by id, and a malformed id is refused;
 *   - `uploadFile` persists user-supplied bytes under a content-addressed id;
 *   - `downloadArtifact` returns the on-disk path plus the payload;
 *   - `getCollabProgress` maps live stream frames back to the participants
 *     declared on the run record, so a poll mid-flight shows per-participant
 *     status without the renderer re-issuing the whole request.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDesktopStack } from "../src/desktop-stack.ts";
import { DesktopFacade } from "../src/facade.ts";
import { MemoryCredentialProvider } from "../src/credentials/memory-credential-provider.ts";

let dir: string;
let project: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-d35-"));
  project = mkdtempSync(join(tmpdir(), "aio-d35-proj-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function stack(): DesktopFacade {
  const s = buildDesktopStack({
    baseDir: dir,
    credentials: new MemoryCredentialProvider(),
  });
  s.settingsStore.patch({ workspaceRoots: [project] });
  return new DesktopFacade(s);
}

describe("ArtifactStore — content-addressed confinement", () => {
  it("stores a capture and returns a content-addressed id", () => {
    const f = stack();
    const { artifactId } = f.uploadFile({
      bytes: new Uint8Array([1, 2, 3, 4]),
      contentType: "image/png",
      runId: "run-1",
    });
    expect(artifactId).toMatch(/^capture\/[0-9a-f]{64}\.png$/);
  });

  it("dedups identical content: two uploads of the same bytes share one id", () => {
    const f = stack();
    const a = f.uploadFile({
      bytes: new Uint8Array([10, 20, 30]),
      contentType: "application/octet-stream",
      runId: "run-1",
    });
    const b = f.uploadFile({
      bytes: new Uint8Array([10, 20, 30]),
      contentType: "application/octet-stream",
      runId: "run-2",
    });
    expect(a.artifactId).toBe(b.artifactId);
    expect(f.listArtifacts()).toHaveLength(1);
  });

  it("lists every stored artifact, newest first", () => {
    const f = stack();
    f.uploadFile({
      bytes: new Uint8Array([1]),
      contentType: "image/png",
      runId: "run-1",
    });
    f.uploadFile({
      bytes: new Uint8Array([2]),
      contentType: "image/png",
      runId: "run-2",
    });
    const list = f.listArtifacts();
    expect(list).toHaveLength(2);
    expect(list[0]!.runId).toBe("run-2");
    expect(list[1]!.runId).toBe("run-1");
  });

  it("reads an artifact's bytes back by id", () => {
    const f = stack();
    const { artifactId } = f.uploadFile({
      bytes: new Uint8Array([7, 8, 9]),
      contentType: "image/png",
      runId: "run-1",
    });
    const artifact = f.getArtifact(artifactId);
    expect(Array.from(artifact.bytes)).toEqual([7, 8, 9]);
    expect(artifact.metadata.kind).toBe("capture");
    expect(artifact.metadata.runId).toBe("run-1");
  });

  it("refuses a malformed artifact id", () => {
    const f = stack();
    expect(() => f.getArtifact("not-an-id")).toThrow();
    expect(() => f.getArtifact("../escape")).toThrow();
    expect(() => f.getArtifact("capture/../../etc/passwd")).toThrow();
  });

  it("returns the on-disk path plus the payload for download", () => {
    const f = stack();
    const { artifactId } = f.uploadFile({
      bytes: new Uint8Array([42]),
      contentType: "image/png",
      runId: "run-1",
    });
    const dl = f.downloadArtifact(artifactId);
    expect(dl.artifactId).toBe(artifactId);
    expect(dl.path).toContain("artifacts");
    expect(dl.path).toContain("capture");
    expect(Array.from(dl.bytes)).toEqual([42]);
  });
});

describe("Collab progress", () => {
  it("reports running with no participants when the run is unknown", () => {
    const f = stack();
    const progress = f.getCollabProgress("does-not-exist");
    expect(progress.status).toBe("running");
    expect(progress.participants).toHaveLength(0);
  });

  it("maps declared participants to live stream frames", async () => {
    const f = stack();
    // Drive a collab run with two participants; the orchestrator is the real
    // one, so this exercises the full pipeline and the progress poll at once.
    const result = await f.runCollab({
      task: "say hi",
      participants: [
        { id: "p1", provider: "local", modelId: "deep", role: "DEEP_REASONING", task: "say hi" },
        { id: "p2", provider: "local", modelId: "review", role: "CODE_REVIEWER", task: "say hi" },
      ],
      strategy: "parallel",
      mode: "INSPECT",
      streaming: true,
    });
    expect(result.ok).toBe(true);
    const progress = f.getCollabProgress(result.runId);
    expect(progress.status).toBe("completed");
    expect(progress.participants.map((p) => p.participantId)).toEqual(["p1", "p2"]);
    for (const p of progress.participants) {
      expect(p.ok).toBe(true);
    }
  });
});

/**
 * A minimal 1x1 RGBA PNG. The fake vision provider decodes dimensions from
 * the IHDR chunk, so the bytes must be a structurally valid PNG — not just
 * any array. Generated once and frozen so the test stays deterministic.
 */
const MINIMAL_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
);

describe("Image analysis (D35)", () => {
  it("analyzes an uploaded PNG through the deterministic fake", async () => {
    const f = stack();
    const { artifactId } = f.uploadFile({
      bytes: MINIMAL_PNG,
      contentType: "image/png",
      runId: "run-1",
    });
    const outcome = (await f.analyzeImage(artifactId)) as {
      analysis: { provider: string; imageDimensions: { width: number; height: number } };
      providerId: string;
    };
    expect(outcome.providerId).toBe("fake-vision");
    expect(outcome.analysis.provider).toBe("fake-vision");
    expect(outcome.analysis.imageDimensions).toEqual({ width: 1, height: 1 });
  });

  it("rejects an analysis request for a non-image artifact", async () => {
    const f = stack();
    const { artifactId } = f.uploadFile({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "text/plain",
      runId: "run-1",
    });
    await expect(f.analyzeImage(artifactId)).rejects.toThrow();
  });
});

describe("File analysis (D35)", () => {
  const TEXT = new TextEncoder().encode("hello world\nsecond line");
  const BINARY = new Uint8Array([0x00, 0x01, 0x02, 0xff]);

  it("analyzes a text/plain upload locally, with no network call", async () => {
    const f = stack();
    const { artifactId } = f.uploadFile({
      bytes: TEXT,
      contentType: "text/plain",
      runId: "run-1",
    });
    const analysis = (await f.analyzeFile(artifactId)) as {
      provider: string;
      charset: string;
      lines: number;
      firstLine: string;
      summary: string;
    };
    expect(analysis.provider).toBe("local-text");
    expect(analysis.charset).toBe("ascii");
    expect(analysis.lines).toBe(2);
    expect(analysis.firstLine).toBe("hello world");
    expect(analysis.summary).toContain("hello world");
  });

  it("reports a binary upload as binary, never analyzed", async () => {
    const f = stack();
    const { artifactId } = f.uploadFile({
      bytes: BINARY,
      contentType: "application/octet-stream",
      runId: "run-1",
    });
    const analysis = (await f.analyzeFile(artifactId)) as {
      charset: string;
      warnings: readonly string[];
    };
    expect(analysis.charset).toBe("binary");
    expect(analysis.warnings).toContain("content type is neither image/* nor text/*");
  });

  it("routes an image/* upload through the VISION path", async () => {
    const f = stack();
    const { artifactId } = f.uploadFile({
      bytes: MINIMAL_PNG,
      contentType: "image/png",
      runId: "run-1",
    });
    const analysis = (await f.analyzeFile(artifactId)) as {
      providerId: string;
      analysis: { provider: string; imageDimensions: { width: number; height: number } };
    };
    expect(analysis.providerId).toBe("fake-vision");
    expect(analysis.analysis.provider).toBe("fake-vision");
    expect(analysis.analysis.imageDimensions).toEqual({ width: 1, height: 1 });
  });
});