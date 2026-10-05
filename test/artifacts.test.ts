/**
 * Artifact store suite: content addressing, metadata sidecars, traversal
 * safety, size limits, and retention.
 */
import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore, sha256 } from "../src/artifacts/store.ts";
import { AllInOneError } from "../src/errors.ts";

function tmpBase(): string {
  return mkdtempSync(join(tmpdir(), "aio-artifacts-"));
}

describe("artifact store", () => {
  it("stores bytes content-addressed and writes a metadata sidecar", () => {
    const base = tmpBase();
    const store = new ArtifactStore({ baseDir: base, retentionDays: 30, keepRuns: 5 });
    const bytes = Buffer.from("hello world");

    const { metadata, path } = store.store({
      kind: "screenshot",
      bytes,
      contentType: "image/png",
      runId: "run-1",
      sourceUrl: "http://localhost:5173/",
    });

    expect(metadata.sha256).toBe(sha256(bytes));
    expect(metadata.artifactId).toBe(`screenshot/${sha256(bytes)}.png`);
    expect(path).toContain(join(base, "screenshot"));
    expect(readFileSync(path, "utf8")).toBe("hello world");

    const sidecar = `${path}.json`;
    const parsed = JSON.parse(readFileSync(sidecar, "utf8")) as { runId: string; sourceUrl: string };
    expect(parsed.runId).toBe("run-1");
    expect(parsed.sourceUrl).toBe("http://localhost:5173/");

    rmSync(base, { recursive: true, force: true });
  });

  it("is idempotent for identical content", () => {
    const base = tmpBase();
    const store = new ArtifactStore({ baseDir: base, retentionDays: 30, keepRuns: 5 });
    const a = store.store({
      kind: "screenshot",
      bytes: Buffer.from("same"),
      contentType: "image/png",
      runId: "r1",
    });
    const b = store.store({
      kind: "screenshot",
      bytes: Buffer.from("same"),
      contentType: "image/png",
      runId: "r2",
    });
    expect(b.metadata.artifactId).toBe(a.metadata.artifactId);
    rmSync(base, { recursive: true, force: true });
  });

  it("reads back bytes and metadata", () => {
    const base = tmpBase();
    const store = new ArtifactStore({ baseDir: base, retentionDays: 30, keepRuns: 5 });
    const { metadata } = store.store({
      kind: "screenshot",
      bytes: Buffer.from([1, 2, 3, 4]),
      contentType: "image/png",
      runId: "r1",
    });
    const read = store.read(metadata.artifactId);
    expect([...read.bytes ?? []]).toEqual([1, 2, 3, 4]);
    expect(read.metadata.runId).toBe("r1");
    rmSync(base, { recursive: true, force: true });
  });

  it("throws ARTIFACT_NOT_FOUND for a well-formed but missing id", () => {
    const base = tmpBase();
    const store = new ArtifactStore({ baseDir: base, retentionDays: 30, keepRuns: 5 });
    const missing = "screenshot/" + "0".repeat(64);
    try {
      store.read(missing);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AllInOneError);
      expect((e as AllInOneError).code).toBe("ARTIFACT_NOT_FOUND");
    }
    rmSync(base, { recursive: true, force: true });
  });

  it("rejects oversized writes", () => {
    const base = tmpBase();
    const store = new ArtifactStore({
      baseDir: base,
      retentionDays: 30,
      keepRuns: 5,
      maxBytes: 4,
    });
    try {
      store.store({
        kind: "screenshot",
        bytes: Buffer.from("this is way too long"),
        contentType: "image/png",
        runId: "r1",
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as AllInOneError).code).toBe("ARTIFACT_TOO_LARGE");
      expect((e as AllInOneError).category).toBe("artifact");
    }
    rmSync(base, { recursive: true, force: true });
  });

  it("blocks path traversal via a crafted artifact id", () => {
    const base = tmpBase();
    const store = new ArtifactStore({ baseDir: base, retentionDays: 30, keepRuns: 5 });
    const attempts = [
      "screenshot/../../etc/passwd",
      "screenshot/..%2f..%2fetc/passwd",
      "screenshot/./../../escape.png",
    ];
    for (const id of attempts) {
      try {
        store.read(id);
        throw new Error(`should have blocked ${id}`);
      } catch (e) {
        expect((e as AllInOneError).code).toBe("PATH_TRAVERSAL_BLOCKED");
        expect((e as AllInOneError).category).toBe("security");
      }
    }
    expect(existsSync(join(base, "..", "passwd"))).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });
});

describe("retention", () => {
  it("prunes artifacts beyond keepRuns even when not expired", () => {
    const base = tmpBase();
    const store = new ArtifactStore({ baseDir: base, retentionDays: 365, keepRuns: 2 });
    for (let i = 0; i < 4; i++) {
      store.store({
        kind: "screenshot",
        bytes: Buffer.from(`capture-${i}`),
        contentType: "image/png",
        runId: `r${i}`,
      });
    }
    // Assign ascending mtimes so ordering is deterministic regardless of fs timing.
    const dir = join(base, "screenshot");
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".png"))
      .sort();
    const epoch = new Date("2020-01-01T00:00:00Z");
    files.forEach((f, i) => {
      const when = new Date(epoch.getTime() + i * 60_000);
      utimesSync(join(dir, f), when, when);
    });
    const pruned = store.enforceRetention(new Date("2020-02-01").getTime());
    expect(pruned.length).toBeGreaterThan(0);
    rmSync(base, { recursive: true, force: true });
  });

  it("prunes expired artifacts by retentionDays", () => {
    const base = tmpBase();
    const store = new ArtifactStore({ baseDir: base, retentionDays: 1, keepRuns: 99 });
    const { metadata } = store.store({
      kind: "screenshot",
      bytes: Buffer.from("old"),
      contentType: "image/png",
      runId: "r1",
    });
    const future = Date.now() + 10 * 24 * 60 * 60 * 1000;
    const pruned = store.enforceRetention(future);
    expect(pruned.some((p) => p.artifactId === metadata.artifactId)).toBe(true);
    rmSync(base, { recursive: true, force: true });
  });
});
