/**
 * Workspace root resolution (D2).
 *
 * The tool runtime's boundary is only as trustworthy as its root list, so the
 * roots are derived from the one place the user actually expressed intent: the
 * desktop settings. A directory is a root because the user opened it — never
 * because a tool or a model asked for it.
 *
 * The application's own data directory is always DENIED, even when it happens
 * to sit inside a root: a tool must never be able to read the credential store
 * or rewrite its own audit trail. Both lists are re-read on every resolution,
 * so a settings change takes effect immediately with no cached boundary.
 */
import { resolve } from "node:path";
import type { SettingsStore } from "../persistence/types.ts";
import { WorkspaceManager } from "../../../src/tools/workspace.ts";

export class DesktopWorkspaceRoots {
  private readonly settings: SettingsStore;
  /** The application data directory — denied to every tool, unconditionally. */
  private readonly dataDir: string;

  constructor(settings: SettingsStore, dataDir: string) {
    this.settings = settings;
    this.dataDir = resolve(dataDir);
  }

  /** The roots the user opened, resolved absolute. */
  roots(): readonly string[] {
    return this.settings
      .get()
      .workspaceRoots.map((r) => resolve(r))
      .filter((r, index, all) => all.indexOf(r) === index);
  }

  /** The workspace manager bound to those roots. */
  manager(): WorkspaceManager {
    return new WorkspaceManager({
      roots: () => this.roots(),
      denyPaths: () => [this.dataDir],
    });
  }

  /** The data directory, for display and diagnostics. */
  get dataDirectory(): string {
    return this.dataDir;
  }

  /** True when the user has opened at least one root. */
  hasRoots(): boolean {
    return this.roots().length > 0;
  }
}
