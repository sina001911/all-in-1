/**
 * Interactive tool approver (D2).
 *
 * The human's side of the tool-approval contract. When the executor needs a
 * decision for a privileged tool, this approver records the request as PENDING
 * and waits. Nothing resolves it but the two channels the renderer holds:
 * `approve` or `deny`. The renderer cannot fabricate a request (it can only
 * answer what the executor raised), and the model holds no reference to this
 * object at all — it is constructed in the main process and handed to the
 * executor, never to the agent.
 *
 * Safety properties:
 *   - a pending request has no default answer: forgetting it is a denial on
 *     disposal, never an approval;
 *   - an answer may only be given once, and only for a request that exists;
 *   - an answer carries the decision time and optional note for the audit.
 */
import type {
  ToolApprovalDecision,
  ToolApprovalRequest,
  ToolApprover,
} from "../../../src/tools/approval.ts";

export interface PendingApproval extends ToolApprovalRequest {
  readonly status: "pending";
}

export interface ResolvedApproval extends ToolApprovalRequest {
  readonly status: "approved" | "denied";
  readonly decidedAt: number;
  readonly note?: string;
}

export type ApprovalRecord = PendingApproval | ResolvedApproval;

export class InteractiveToolApprover implements ToolApprover {
  private readonly pending = new Map<string, { resolve: (d: ToolApprovalDecision) => void }>();
  private readonly history: ApprovalRecord[] = [];

  /** The requests awaiting a human decision, oldest first. */
  listPending(): readonly PendingApproval[] {
    return this.history.filter((r): r is PendingApproval => r.status === "pending");
  }

  /** Every request, answered or not. */
  listAll(): readonly ApprovalRecord[] {
    return [...this.history];
  }

  async request(req: ToolApprovalRequest): Promise<ToolApprovalDecision> {
    const record: PendingApproval = { ...req, status: "pending" };
    this.history.push(record);
    return new Promise<ToolApprovalDecision>((resolve) => {
      this.pending.set(req.id, { resolve });
    });
  }

  /** The human approved. Returns false when the request is unknown or already answered. */
  approve(id: string, note?: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    this.markResolved(id, "approved", note);
    entry.resolve({ approved: true, note });
    return true;
  }

  /** The human denied, or the request was disposed of (a denial, never an approval). */
  deny(id: string, reason?: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    const note = reason ?? "denied by the user";
    this.markResolved(id, "denied", note);
    entry.resolve({ approved: false, reason: note });
    return true;
  }

  /** Every unanswered request is denied; used on shutdown and run cancellation. */
  denyAll(reason: string): void {
    for (const id of [...this.pending.keys()]) this.deny(id, reason);
  }

  /** True when a decision has been recorded for this request id. */
  isResolved(id: string): boolean {
    return !this.pending.has(id) && this.history.some((r) => r.id === id);
  }

  private markResolved(id: string, status: "approved" | "denied", note?: string): void {
    const index = this.history.findIndex((r) => r.id === id && r.status === "pending");
    if (index === -1) return;
    const found = this.history[index] as PendingApproval;
    this.history[index] = {
      ...found,
      status,
      decidedAt: Date.now(),
      note,
    };
  }
}
