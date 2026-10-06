/**
 * Tool Runtime contracts (D2).
 *
 * The Tool Runtime is the privileged half of the agent. The model and the UI
 * are both UNTRUSTED; every capability they can name must pass through the
 * executor's fixed pipeline before a single byte touches the filesystem or a
 * single process is spawned:
 *
 *   Tool Request
 *     -> Validation        (schema, before anything is touched)
 *     -> Permission check  (mode + permission class)
 *     -> Workspace boundary(resolved by the tool, inside a known root)
 *     -> Approval          (human, if the class requires it; never the model)
 *     -> Execution         (bounded by timeout + cancellation)
 *     -> Audit             (always, success and failure)
 *     -> Result
 *
 * A `Tool` never receives raw power: it receives a `ToolContext` whose only
 * filesystem view is the `WorkspaceManager`, and an abort signal it must honour.
 * Tools return structured `ToolOutput` values rather than throwing, so a tool
 * failure can never crash the runtime (error isolation by construction).
 */
import type { Schema } from "../specialists/validator.ts";
import type { SafetyMode } from "../safety/guard.ts";
import type { WorkspaceManager } from "./workspace.ts";

/**
 * The privilege class of a tool. This is the axis the permission policy and the
 * mode gate key off:
 *
 *   - read      : filesystem reads (read, list, search)
 *   - write     : filesystem writes (write, edit, patch)
 *   - execute   : process spawning (exec)
 *   - network   : outbound network beyond the browser engine's own host policy
 *   - capture   : browser capture; already confined by the frozen host policy
 */
export type PermissionClass = "read" | "write" | "execute" | "network" | "capture";

export const PERMISSION_CLASSES: readonly PermissionClass[] = [
  "read",
  "write",
  "execute",
  "network",
  "capture",
];

/**
 * A tool's declared contract. The `input` schema is the dependency-free subset
 * the specialist validator already understands, so validation needs no library
 * and behaves identically to structured-output validation elsewhere.
 */
export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly input: Schema;
  readonly permission: PermissionClass;
  /** Per-invocation hard timeout in milliseconds. Bounded by the executor. */
  readonly timeoutMs?: number;
}

/** Content a tool may return. Deliberately mirrors provider input shapes. */
export type ToolContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "json"; readonly json: unknown }
  | { readonly type: "image"; readonly artifactId: string; readonly contentType: string; readonly bytes: number }
  | { readonly type: "diff"; readonly path: string; readonly diff: string };

/**
 * A tool's outcome. Tools NEVER throw for an expected failure: they report
 * `{ ok: false, code, message }` so the executor can audit and route the
 * failure without a try/catch boundary that could swallow an abort.
 */
export type ToolOutput =
  | {
      readonly ok: true;
      readonly content: readonly ToolContent[];
      readonly metadata?: Readonly<Record<string, unknown>>;
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Everything a tool may touch. There is no path to Node, process, or the raw
 *  filesystem here except through the workspace manager. */
export interface ToolContext {
  readonly runId: string;
  readonly workspace: WorkspaceManager;
  readonly signal: AbortSignal;
}

export interface Tool {
  readonly schema: ToolSchema;
  execute(input: unknown, ctx: ToolContext): Promise<ToolOutput>;
}

/** A caller's request to run one tool. Originates from the model or the UI. */
export interface ToolRequest {
  readonly toolName: string;
  readonly input: unknown;
  readonly runId: string;
  /**
   * When set, the executor applies the mode gate: a write/execute/network tool
   * is refused outside a mode that grants `edit`. The agent runtime always sets
   * this; a direct UI invocation may omit it (approvals still apply).
   */
  readonly mode?: SafetyMode;
  /** Per-invocation timeout override; cannot exceed the executor's ceiling. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** The model's stated reason for the call, recorded verbatim in the audit. */
  readonly justification?: string;
}

/** The executor's settled result, always returned, never thrown. */
export interface ToolResult {
  readonly ok: boolean;
  readonly toolName: string;
  readonly auditId: string;
  readonly content: readonly ToolContent[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly code?: string;
  readonly message?: string;
  /** True when a human approval was required and granted for this call. */
  readonly approved: boolean;
  readonly durationMs: number;
}
