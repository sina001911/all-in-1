/**
 * Artifact storage. Screenshots and other captured media land here.
 *
 * Design:
 * - Content-addressed by SHA-256 (`<base>/<kind>/<sha256>.<ext>`), so identical
 *   captures are stored once and the filename is unforgeable.
 * - A metadata sidecar (`<sha256>.json`) records provenance: url, capturedAt,
 *   kind, bytes, contentType, and the run that produced it.
 * - Writes are confined to `base`: any resolved path escaping it raises
 *   PATH_TRAVERSAL_BLOCKED. This holds even when a caller supplies a crafted id.
 * - Retention is a best-effort sweep: it prunes oldest artifacts beyond
 *   `keepRuns`/`retentionDays`. Failure to prune is reported, never fatal.
 */
import { createHash } from "node:crypto";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { AllInOneError } from "../errors.ts";

export const ARTIFACT_KINDS = ["screenshot", "diff", "capture"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface ArtifactMetadata {
  readonly artifactId: string;
  readonly kind: ArtifactKind;
  readonly sha256: string;
  readonly contentType: string;
  readonly bytes: number;
  readonly createdAt: number;
  readonly runId: string;
  readonly sourceUrl?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface StoreOptions {
  readonly baseDir: string;
  readonly retentionDays: number;
  readonly keepRuns: number;
  /** Hard ceiling on a single write, in bytes. */
  readonly maxBytes?: number;
}

export interface StoredArtifact {
  readonly metadata: ArtifactMetadata;
  readonly path: string;
}

export interface ReadArtifact extends StoredArtifact {
  readonly bytes: Uint8Array;
}

/** Content-addressed ids are always `kind/<sha256>.<ext>` — nothing else. */
const ARTIFACT_ID_RE = /^[a-z]+\/[0-9a-f]{64}(?:\.[a-z0-9]+)?$/;

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // 25 MiB per artifact

export class ArtifactStore {
  private readonly opts: StoreOptions;
  private runCounter = 0;

  constructor(opts: StoreOptions) {
    this.opts = { maxBytes: DEFAULT_MAX_BYTES, ...opts };
  }

  /** Store raw bytes under a content-addressed path. */
  store(input: {
    kind: ArtifactKind;
    bytes: Buffer | Uint8Array;
    contentType: string;
    runId: string;
    sourceUrl?: string;
    labels?: Record<string, string>;
  }): StoredArtifact {
    const buf = Buffer.from(input.bytes);
    const sha = sha256(buf);
    const ext = extensionFor(input.contentType);
    const dir = join(this.opts.baseDir, input.kind);
    const fileName = `${sha}${ext}`;
    const target = resolve(join(dir, fileName));

    this.assertInsideBase(target);

    if (this.opts.maxBytes !== undefined && buf.byteLength > this.opts.maxBytes) {
      throw new AllInOneError(
        `Artifact of ${buf.byteLength} bytes exceeds the ${this.opts.maxBytes} byte limit`,
        "ARTIFACT_TOO_LARGE",
        "artifact",
      );
    }

    try {
      mkdirSync(dir, { recursive: true });
      if (!existsSync(target)) writeFileSync(target, buf);
    } catch (e) {
      throw new AllInOneError(
        `Failed to write artifact ${fileName}: ${describeCause(e)}`,
        "ARTIFACT_WRITE_FAILED",
        "artifact",
        { cause: e, retryable: true },
      );
    }

    const metadata: ArtifactMetadata = {
      artifactId: `${input.kind}/${fileName}`,
      kind: input.kind,
      sha256: sha,
      contentType: input.contentType,
      bytes: buf.byteLength,
      createdAt: Date.now(),
      runId: input.runId,
      sourceUrl: input.sourceUrl,
      labels: input.labels,
    };
    this.writeSidecar(target, metadata);

    this.runCounter += 1;
    return { metadata, path: target };
  }

  read(artifactId: string): ReadArtifact {
    assertValidArtifactId(artifactId);
    const meta = this.readMetadata(artifactId);
    const path = resolve(join(this.opts.baseDir, `${artifactId}`));
    this.assertInsideBase(path);
    if (!existsSync(path)) {
      throw new AllInOneError(
        `Artifact ${artifactId} not found`,
        "ARTIFACT_NOT_FOUND",
        "artifact",
      );
    }
    try {
      const bytes = new Uint8Array(readFileSync(path));
      return { metadata: meta, path, bytes };
    } catch (e) {
      throw new AllInOneError(
        `Failed to read artifact ${artifactId}: ${describeCause(e)}`,
        "ARTIFACT_READ_FAILED",
        "artifact",
        { cause: e, retryable: true },
      );
    }
  }

  readMetadata(artifactId: string): ArtifactMetadata {
    assertValidArtifactId(artifactId);
    const file = resolve(join(this.opts.baseDir, `${artifactId}.json`));
    this.assertInsideBase(file);
    if (!existsSync(file)) {
      throw new AllInOneError(
        `Metadata for ${artifactId} not found`,
        "ARTIFACT_NOT_FOUND",
        "artifact",
      );
    }
    try {
      const raw = readFileSync(file, "utf8");
      return JSON.parse(raw) as ArtifactMetadata;
    } catch (e) {
      throw new AllInOneError(
        `Failed to read metadata for ${artifactId}: ${describeCause(e)}`,
        "ARTIFACT_READ_FAILED",
        "artifact",
        { cause: e },
      );
    }
  }

  /**
   * Best-effort retention sweep. Prunes artifacts older than `retentionDays`,
   * keeping at least `keepRuns` most recent per kind. Pruning errors are
   * collected and returned; they never abort the sweep.
   */
  enforceRetention(now: number = Date.now()): ReadonlyArray<{ artifactId: string; reason: string }> {
    const pruned: { artifactId: string; reason: string }[] = [];
    const failures: { artifactId: string; reason: string }[] = [];

    for (const kind of ARTIFACT_KINDS) {
      const dir = join(this.opts.baseDir, kind);
      if (!existsSync(dir)) continue;

      const entries: { id: string; createdAt: number; path: string }[] = [];
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".png") && !name.endsWith(".jpg") && !name.endsWith(".jpeg")) continue;
        const path = join(dir, name);
        const id = `${kind}/${name}`;
        let createdAt = 0;
        try {
          createdAt = statSync(path).mtimeMs;
        } catch {
          continue;
        }
        entries.push({ id, createdAt, path });
      }
      // newest first
      entries.sort((a, b) => b.createdAt - a.createdAt);

      const cutoff = now - this.opts.retentionDays * 24 * 60 * 60 * 1000;
      entries.forEach((entry, index) => {
        const tooOld = entry.createdAt < cutoff;
        const beyondKeep = index >= this.opts.keepRuns;
        if (!(tooOld || beyondKeep)) return;

        const metaPath = `${entry.path}.json`;
        for (const p of [entry.path, metaPath]) {
          try {
            rmSync(p, { force: true });
          } catch (e) {
            failures.push({
              artifactId: entry.id,
              reason: describeCause(e),
            });
            return;
          }
        }
        pruned.push({
          artifactId: entry.id,
          reason: tooOld ? `older than ${this.opts.retentionDays}d` : `beyond keepRuns=${this.opts.keepRuns}`,
        });
      });
    }

    if (failures.length > 0) {
      throw new AllInOneError(
        `Retention sweep failed for ${failures.length} artifact(s): ${failures[0]?.reason}`,
        "RETENTION_ENFORCEMENT_FAILED",
        "artifact",
        { cause: failures, retryable: true },
      );
    }
    return pruned;
  }

  private writeSidecar(artifactPath: string, metadata: ArtifactMetadata): void {
    const sidecar = `${artifactPath}.json`;
    try {
      writeFileSync(sidecar, JSON.stringify(metadata, null, 2));
    } catch (e) {
      throw new AllInOneError(
        `Failed to write artifact metadata: ${describeCause(e)}`,
        "ARTIFACT_WRITE_FAILED",
        "artifact",
        { cause: e, retryable: true },
      );
    }
  }

  /**
   * Reject any resolved path that escapes `baseDir`. Second line of defence
   * behind strict id validation.
   */
  private assertInsideBase(path: string): void {
    const base = resolve(this.opts.baseDir);
    const rel = relative(base, resolve(path));
    const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    if (!inside) {
      throw new AllInOneError(
        `Refusing path outside artifact base: ${path}`,
        "PATH_TRAVERSAL_BLOCKED",
        "security",
      );
    }
  }
}

function assertValidArtifactId(artifactId: string): void {
  if (!ARTIFACT_ID_RE.test(artifactId)) {
    throw new AllInOneError(
      `Refusing malformed artifact id: ${artifactId}`,
      "PATH_TRAVERSAL_BLOCKED",
      "security",
    );
  }
}

export function sha256(bytes: Buffer | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function extensionFor(contentType: string): string {
  const ct = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (ct === "image/png") return ".png";
  if (ct === "image/jpeg") return ".jpg";
  if (ct === "image/webp") return ".webp";
  if (ct === "application/pdf") return ".pdf";
  return ".bin";
}

function describeCause(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
