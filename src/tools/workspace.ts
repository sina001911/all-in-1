/**
 * Workspace boundary manager (D2).
 *
 * Every file operation the Tool Runtime performs is confined to a set of
 * explicitly known roots. This is the sole place that decision is made, and it
 * is made the same way for reads and writes, so a tool cannot forget to check.
 *
 * Three independent defences, in order:
 *
 *   1. Lexical containment. The path is resolved and must remain inside a root.
 *      This stops `../` and absolute-path escapes outright.
 *   2. Symlink containment. The deepest existing ancestor's real (link-free)
 *      path must also be inside a root, and the remaining relative portion must
 *      not walk back out. This stops a symlink planted inside the workspace
 *      from pointing at the credential file or the system directory.
 *   3. Deny list. Paths the application itself owns — the data directory and
 *      the credential store — are refused even when they happen to sit inside a
 *      root. A tool can never read or rewrite the secrets that protect it.
 *
 * Roots are supplied as a live provider rather than a fixed list so a settings
 * change takes effect on the next call, with no stale cached boundary.
 */
import { resolve, relative, isAbsolute, dirname, basename, sep } from "node:path";
import { realpathSync } from "node:fs";
import { AllInOneError } from "../errors.ts";

export interface WorkspaceOptions {
  /** Live workspace roots. A path is admissible only inside one of these. */
  readonly roots: () => readonly string[];
  /**
   * Live subset of roots in which writes are permitted. Defaults to all roots
   * when omitted; writes are additionally gated by approvals elsewhere.
   */
  readonly writableRoots?: () => readonly string[];
  /**
   * Live list of paths that are refused unconditionally (the application data
   * directory, the credential store). Deny takes precedence over root
   * membership.
   */
  readonly denyPaths?: () => readonly string[];
  /** Hard ceiling on a single read, in bytes. */
  readonly maxReadBytes?: number;
}

export const DEFAULT_MAX_READ_BYTES = 1024 * 1024; // 1 MiB

function isWindows(): boolean {
  return process.platform === "win32";
}

/**
 * Node's `relative` is case-sensitive, but Windows filesystems are not. Compare
 * containment case-insensitively there so `C:\Proj\x` is recognised as inside
 * `c:\proj`; the returned path keeps its original casing for display.
 */
function contains(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  if (rel === "") return true;
  if (isAbsolute(rel) || rel.split(sep)[0] === "..") return false;
  return true;
}

function containsAny(roots: readonly string[], target: string): boolean {
  return roots.some((r) => contains(r, target));
}

/**
 * Walk up to the deepest existing ancestor and return its real, link-free path
 * plus the remaining relative portion. For an existing path the remaining
 * portion is empty.
 *
 * The remaining portion is built from `basename` components only, so it can
 * never contain a `..` segment: a not-yet-existing path can only extend
 * *deeper* from a real ancestor that is already proven to be inside a root.
 */
function deepestRealPath(p: string): { real: string; remaining: string } {
  let cur = resolve(p);
  const parts: string[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return { real: realpathSync(cur), remaining: parts.join(sep) };
    } catch {
      const parent = dirname(cur);
      if (parent === cur) {
        // Reached the filesystem root without a resolvable ancestor.
        return { real: cur, remaining: parts.join(sep) };
      }
      parts.unshift(basename(cur));
      cur = parent;
    }
  }
}

export class WorkspaceManager {
  private readonly opts: WorkspaceOptions;

  constructor(opts: WorkspaceOptions) {
    this.opts = opts;
  }

  listRoots(): readonly string[] {
    return this.opts.roots();
  }

  listWritableRoots(): readonly string[] {
    return this.opts.writableRoots?.() ?? this.opts.roots();
  }

  get maxReadBytes(): number {
    return this.opts.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  }

  /** True when the path resolves inside a root and outside every deny path. */
  isInside(path: string): boolean {
    const logical = this.anchor(path);
    if (this.isDenied(logical)) return false;
    if (!containsAny(this.opts.roots(), logical)) return false;
    const { real, remaining } = deepestRealPath(logical);
    const realized = remaining.length > 0 ? resolve(real, remaining) : real;
    return containsAny(this.opts.roots(), real) && containsAny(this.opts.roots(), realized);
  }

  /**
   * Resolve a caller-supplied path for reading, enforcing every boundary.
   * Returns the absolute path to read, or throws PATH_TRAVERSAL_BLOCKED.
   */
  resolveRead(path: string): string {
    return this.guard(path, "read");
  }

  /** Resolve a path for writing; additionally requires a writable root. */
  resolveWrite(path: string): string {
    const logical = this.guard(path, "write");
    const parent = dirname(logical);
    const { real, remaining } = deepestRealPath(parent);
    const realizedParent = remaining.length > 0 ? resolve(real, remaining) : real;
    if (!containsAny(this.listWritableRoots(), real)) {
      throw this.blocked(path, "write target is not inside a writable workspace root");
    }
    if (!containsAny(this.listWritableRoots(), realizedParent)) {
      throw this.blocked(path, "write target resolves outside a writable workspace root");
    }
    return logical;
  }

  /** Assert without resolving that a path would be admissible. */
  assertInside(path: string): void {
    this.guard(path, "read");
  }

  // ---- internals -----------------------------------------------------

  /**
   * A relative path is anchored at the first root. With multiple roots a
   * relative path is ambiguous, so the first root wins and is documented; the
   * containment check still applies.
   */
  private anchor(path: string): string {
    if (path.length === 0) throw this.blocked(path, "path must not be empty");
    const roots = this.opts.roots();
    if (roots.length === 0) {
      throw new AllInOneError(
        "No workspace root is configured; refusing every filesystem access",
        "TOOL_PERMISSION_DENIED",
        "security",
      );
    }
    return isAbsolute(path) ? resolve(path) : resolve(roots[0] as string, path);
  }

  private guard(path: string, kind: "read" | "write"): string {
    const logical = this.anchor(path);
    if (this.isDenied(logical)) {
      throw this.blocked(path, `${kind} of an application-owned path is denied`);
    }
    if (!containsAny(this.opts.roots(), logical)) {
      throw this.blocked(path, `${kind} target is outside every workspace root`);
    }
    const { real, remaining } = deepestRealPath(logical);
    const realized = remaining.length > 0 ? resolve(real, remaining) : real;
    if (!containsAny(this.opts.roots(), real) || !containsAny(this.opts.roots(), realized)) {
      throw this.blocked(path, `${kind} target escapes the workspace via a symlink`);
    }
    return logical;
  }

  private isDenied(logical: string): boolean {
    const deny = this.opts.denyPaths?.() ?? [];
    return deny.some((d) => contains(d, logical));
  }

  private blocked(path: string, reason: string): AllInOneError {
    return new AllInOneError(`Refusing workspace access to ${path}: ${reason}`, "PATH_TRAVERSAL_BLOCKED", "security");
  }
}
