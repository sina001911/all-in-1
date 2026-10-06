/**
 * Tool approval seam (D2).
 *
 * The approval decision belongs to a HUMAN, never to the model and never to the
 * runtime itself. This interface is the only place a decision can be produced,
 * and the executor holds no reference to any other path.
 *
 * The contract is deliberately raceable: the executor passes the run's abort
 * signal, so an approval pending on a cancelled run settles as cancelled rather
 * than hanging the run forever.
 */
import type { PermissionClass } from "./types.ts";

export interface ToolApprovalRequest {
  readonly id: string;
  readonly runId: string;
  readonly toolName: string;
  readonly permission: PermissionClass;
  /** Human-readable statement of what will happen, e.g. "write 128 bytes to <path>". */
  readonly summary: string;
  /** Sanitized input: paths and commands only, never file contents or secrets. */
  readonly inputSummary: Readonly<Record<string, unknown>>;
  readonly justification?: string;
  readonly createdAt: number;
}

export type ToolApprovalDecision =
  | { readonly approved: true; readonly note?: string }
  | { readonly approved: false; readonly reason: string };

export interface ToolApprover {
  request(req: ToolApprovalRequest, signal?: AbortSignal): Promise<ToolApprovalDecision>;
}

/**
 * The safe default: denies everything that requires approval. Used when no human
 * approver is wired (e.g. a headless run), so privileged tools fail closed
 * rather than silently succeeding unapproved.
 */
export class DenyAllApprover implements ToolApprover {
  async request(req: ToolApprovalRequest): Promise<ToolApprovalDecision> {
    return { approved: false, reason: `${req.toolName} requires human approval; no approver is configured` };
  }
}

/**
 * Approves everything. TEST ONLY — it stands in for a human who always says yes
 * so the tool pipeline can be exercised end to end without a UI. It is never
 * wired by the desktop stack or the agent runtime.
 */
export class AllowAllApprover implements ToolApprover {
  async request(_req?: ToolApprovalRequest): Promise<ToolApprovalDecision> {
    return { approved: true, note: "test approver" };
  }
}

/**
 * Approves by class, according to a policy map. Useful in tests that want to
 * approve reads-equivalents while asserting a privileged class is still asked
 * about; never used in production wiring.
 */
export class ClassRuleApprover implements ToolApprover {
  private readonly allow: ReadonlySet<PermissionClass>;
  constructor(allow: readonly PermissionClass[]) {
    this.allow = new Set(allow);
  }
  async request(req: ToolApprovalRequest): Promise<ToolApprovalDecision> {
    return this.allow.has(req.permission)
      ? { approved: true }
      : { approved: false, reason: `${req.permission} is not on the test allow list` };
  }
}
