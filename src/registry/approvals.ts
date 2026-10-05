/**
 * Approval store. Paid/unknown-cost models require an explicit, recorded
 * approval BEFORE the router returns a usable decision. Approvals are scoped
 * (per-run or per-session), never global, and never silent.
 *
 * P1: in-memory store only. No persistence layer exists yet.
 */
export interface ApprovalRecord {
  readonly modelId: string; // "provider/model"
  readonly scope: "run" | "session";
  readonly grantedAt: number;
  readonly usdCap?: number;
  readonly note?: string;
}

export class ApprovalStore {
  private readonly records = new Map<string, ApprovalRecord>();

  grant(record: ApprovalRecord): void {
    this.records.set(record.modelId, record);
  }

  revoke(modelId: string): void {
    this.records.delete(modelId);
  }

  isApproved(modelId: string): boolean {
    return this.records.has(modelId);
  }

  get(modelId: string): ApprovalRecord | undefined {
    return this.records.get(modelId);
  }

  list(): readonly ApprovalRecord[] {
    return [...this.records.values()];
  }
}
