/**
 * Data-directory resolution (D1).
 *
 * Deliberately free of any Electron import: the base directory is *injected*
 * so the whole persistence layer is testable without a live application. The
 * Electron main process supplies `app.getPath("userData")`; tests and the CLI
 * supply a temp directory.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface DataPaths {
  /** Root directory, created on demand. */
  readonly root: string;
  readonly runs: string;
  readonly usage: string;
  readonly approvals: string;
  readonly budget: string;
  readonly settings: string;
  readonly logs: string;
  readonly credentials: string;
}

export function resolveDataPaths(baseDir: string, subdir = "all-in-1"): DataPaths {
  const root = join(baseDir, subdir);
  const paths: DataPaths = {
    root,
    runs: join(root, "runs.json"),
    usage: join(root, "usage.json"),
    approvals: join(root, "approvals.json"),
    budget: join(root, "budget.json"),
    settings: join(root, "settings.json"),
    logs: join(root, "logs.jsonl"),
    credentials: join(root, "credentials.json"),
  };
  ensureDir(root);
  return paths;
}

/** Create a directory if missing; never throws when it already exists. */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
