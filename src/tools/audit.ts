/**
 * Tool audit log (D2).
 *
 * Every tool invocation is recorded, regardless of outcome: started, approved,
 * denied, succeeded, failed, timed out, cancelled. The audit is the evidence
 * trail the operations UI (D6) renders, and it is written even when the tool
 * never executes, so a refused request is as visible as a successful one.
 *
 * What is recorded: the tool name, its privilege class, the sanitized input
 * summary (paths and commands), the model's justification, the approval
 * decision, and the outcome with duration.
 *
 * What is NEVER recorded: file contents, command output, secrets. The input
 * summary is built by the executor from the request, not from the tool's
 * results, so a large file body or a chunk of provider text can never reach the
 * trail.
 */
import type { PermissionClass } from "./types.ts";
import type { ToolApprovalDecision } from "./approval.ts";

export type ToolAuditStatus = "started" | "ok" | "failed" | "denied" | "cancelled" | "timeout";

export interface ToolAuditRecord {
  readonly id: string;
  readonly runId: string;
  readonly ts: number;
  readonly toolName: string;
  readonly permission: PermissionClass;
  readonly inputSummary: Readonly<Record<string, unknown>>;
  readonly justification?: string;
  readonly approved: boolean;
  readonly approvalNote?: string;
  readonly status: ToolAuditStatus;
  readonly errorCode?: string;
  readonly message?: string;
  readonly durationMs?: number;
}

export interface ToolAuditLog {
  record(rec: ToolAuditRecord): void;
  list(since?: number): readonly ToolAuditRecord[];
  clear(): void;
}

export class InMemoryToolAuditLog implements ToolAuditLog {
  private records: ToolAuditRecord[] = [];

  record(rec: ToolAuditRecord): void {
    this.records = [...this.records, rec];
  }

  list(since?: number): readonly ToolAuditRecord[] {
    return this.records
      .filter((r) => since === undefined || r.ts >= since)
      .sort((a, b) => a.ts - b.ts);
  }

  clear(): void {
    this.records = [];
  }
}

/**
 * Collapse an approval decision into the audit fields, keeping the reason out of
 * the record when a request is approved (a note is informational; a denial
 * reason is evidence).
 */
export function decisionFields(decision: ToolApprovalDecision): {
  approved: boolean;
  approvalNote?: string;
} {
  if (decision.approved) {
    return { approved: true, approvalNote: decision.note };
  }
  return { approved: false, approvalNote: decision.reason };
}
