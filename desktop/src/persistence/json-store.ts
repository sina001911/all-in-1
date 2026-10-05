/**
 * Atomic JSON file store (D1).
 *
 * Writes go to a sibling temp file and are renamed into place, so a crash
 * mid-write can never leave a truncated store file: a reader either sees the
 * previous complete state or the new one, never a mix.
 *
 * All paths stay inside the directory passed to the constructor. A resolved
 * path that would escape it is refused, mirroring the core's own artifact-store
 * traversal discipline.
 */
import { writeFileSync, readFileSync, renameSync, existsSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { ensureDir } from "./paths.ts";

/**
 * Windows-safe atomic rename.
 *
 * `renameSync` can fail with EPERM when an antivirus scanner or the file system
 * briefly holds the destination open — a race that is rare in isolation and
 * common under load. A short bounded retry with backoff makes the write
 * reliable without weakening atomicity: each attempt is still a full rename,
 * so a reader never observes a partial file.
 */
function atomicRename(from: string, to: string, attempts = 5): void {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      lastErr = e;
      // Back off ~5ms, ~10ms, ~20ms, ~40ms before the final attempt.
      const delay = 5 * 2 ** i;
      const start = Date.now();
      while (Date.now() - start < delay) {
        /* busy-wait a few ms; keep the retry latency low */
      }
    }
  }
  throw lastErr;
}

export class JsonFileStore<T> {
  private readonly filePath: string;
  private readonly tmpPath: string;

  constructor(dir: string, fileName: string) {
    const resolved = resolve(dir, fileName);
    const rel = relative(resolve(dir), resolved);
    // The resolved path must remain inside `dir`.
    if (isAbsolute(rel) || rel.startsWith("..")) {
      throw new Error(`JsonFileStore path escapes its directory: ${fileName}`);
    }
    ensureDir(dir);
    this.filePath = resolved;
    this.tmpPath = `${resolved}.tmp`;
  }

  get path(): string {
    return this.filePath;
  }

  read(): T | undefined {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  /** Throw on unparseable content rather than silently returning undefined. */
  readStrict(): T {
    const raw = readFileSync(this.filePath, "utf8");
    return JSON.parse(raw) as T;
  }

  exists(): boolean {
    return existsSync(this.filePath);
  }

  write(value: T): void {
    writeFileSync(this.tmpPath, JSON.stringify(value, null, 2), "utf8");
    atomicRename(this.tmpPath, this.filePath);
  }

  update(fn: (current: T | undefined) => T): T {
    const next = fn(this.read());
    this.write(next);
    return next;
  }
}

/**
 * Append-only JSONL file, used by the log store. Each line is self-contained,
 * so a truncated tail only ever loses the last partial line.
 */
export class JsonlAppendStore {
  private readonly filePath: string;

  constructor(dir: string, fileName: string) {
    const resolved = resolve(dir, fileName);
    const rel = relative(resolve(dir), resolved);
    if (isAbsolute(rel) || rel.startsWith("..")) {
      throw new Error(`JsonlAppendStore path escapes its directory: ${fileName}`);
    }
    ensureDir(dir);
    this.filePath = resolved;
  }

  get path(): string {
    return this.filePath;
  }

  append(line: string): void {
    writeFileSync(this.filePath, line + "\n", { flag: "a", encoding: "utf8" });
  }

  readAll(): string[] {
    try {
      return readFileSync(this.filePath, "utf8")
        .split("\n")
        .filter((l) => l.length > 0);
    } catch {
      return [];
    }
  }

  clear(): void {
    writeFileSync(this.filePath, "", "utf8");
  }
}
