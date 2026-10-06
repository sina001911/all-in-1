/**
 * Tool Runtime assembly (D2).
 *
 * Wires the closed tool set into the executor with the frozen permission
 * policy. The default approver is `DenyAllApprover` — privileged tools fail
 * closed until a host wires a real human approver (the desktop wires its IPC
 * approver; tests may inject an allow-list approver). No default here grants a
 * privileged tool without a human.
 */
import { ToolRegistry } from "./registry.ts";
import { ToolExecutor, type ToolExecutorOptions } from "./executor.ts";
import { ToolPermissionPolicy } from "./permissions.ts";
import { DenyAllApprover, type ToolApprover } from "./approval.ts";
import { InMemoryToolAuditLog, type ToolAuditLog } from "./audit.ts";
import { WorkspaceManager } from "./workspace.ts";
import { readTool } from "./files/read.ts";
import { listTool } from "./files/list.ts";
import { searchTool } from "./files/search.ts";
import { writeTool } from "./files/write.ts";
import { editTool } from "./files/edit.ts";
import { patchTool } from "./files/patch.ts";
import { createExecTool, type ExecToolOptions } from "./process/exec.ts";
import { createBrowserCaptureTool } from "./browser/capture.ts";
import type { ScreenshotEngine } from "../screenshot/engine.ts";
import type { Tool } from "./types.ts";

export interface ToolRuntimeOptions {
  readonly workspace: WorkspaceManager;
  readonly approver?: ToolApprover;
  readonly audit?: ToolAuditLog;
  readonly policy?: ToolPermissionPolicy;
  readonly maxTimeoutMs?: number;
  readonly defaultTimeoutMs?: number;
  /** Executable allowlist override for the process tool. */
  readonly execAllowlist?: readonly string[];
  /** Browser engine; when absent the capture tool is simply not registered. */
  readonly screenshotEngine?: ScreenshotEngine;
  /** Additional tools, validated and registered after the built-in set. */
  readonly extraTools?: readonly Tool[];
}

export interface ToolRuntime {
  readonly registry: ToolRegistry;
  readonly executor: ToolExecutor;
  readonly audit: ToolAuditLog;
  readonly policy: ToolPermissionPolicy;
  readonly workspace: WorkspaceManager;
  readonly approver: ToolApprover;
}

/** Register the filesystem tools (read, list, search, write, edit, patch). */
export function registerFileTools(registry: ToolRegistry): void {
  registry.register(readTool);
  registry.register(listTool);
  registry.register(searchTool);
  registry.register(writeTool);
  registry.register(editTool);
  registry.register(patchTool);
}

/** Register the process execution tool with an optional allowlist override. */
export function registerProcessTool(registry: ToolRegistry, opts?: ExecToolOptions): void {
  registry.register(createExecTool(opts ?? {}));
}

/** Register the browser capture tool. Requires the existing screenshot engine. */
export function registerBrowserTool(registry: ToolRegistry, engine: ScreenshotEngine): void {
  registry.register(createBrowserCaptureTool(engine));
}

export function buildToolRuntime(opts: ToolRuntimeOptions): ToolRuntime {
  const registry = new ToolRegistry();
  const policy = opts.policy ?? new ToolPermissionPolicy();
  const approver = opts.approver ?? new DenyAllApprover();
  const audit = opts.audit ?? new InMemoryToolAuditLog();

  registerFileTools(registry);
  registerProcessTool(registry, { allowlist: opts.execAllowlist });
  if (opts.screenshotEngine) registerBrowserTool(registry, opts.screenshotEngine);
  for (const tool of opts.extraTools ?? []) registry.register(tool);

  const executor = new ToolExecutor({
    registry,
    policy,
    approver,
    audit,
    workspace: opts.workspace,
    maxTimeoutMs: opts.maxTimeoutMs,
    defaultTimeoutMs: opts.defaultTimeoutMs,
  } satisfies ToolExecutorOptions);

  return { registry, executor, audit, policy, workspace: opts.workspace, approver };
}

export * from "./types.ts";
export * from "./workspace.ts";
export * from "./permissions.ts";
export * from "./approval.ts";
export * from "./audit.ts";
export * from "./registry.ts";
export * from "./summary.ts";
