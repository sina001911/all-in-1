/**
 * Persistent approval store (D1).
 *
 * Subclasses the core `ApprovalStore` so the engine keeps holding the exact
 * type it always has; no core module is modified. State is written through on
 * every mutation and hydrated on construction, so approvals survive a restart.
 *
 * Existing in-memory behaviour is untouched: callers that construct a plain
 * `ApprovalStore` (the default stack, the existing tests) see no difference.
 */
import { ApprovalStore } from "../../../src/registry/approvals.ts";
import type { ApprovalRecord } from "../../../src/registry/approvals.ts";
import { JsonFileStore } from "./json-store.ts";

export interface PersistedApprovals {
  readonly records: readonly ApprovalRecord[];
}

export class PersistentApprovalStore extends ApprovalStore {
  private readonly file: JsonFileStore<PersistedApprovals> | undefined;

  constructor(
    hydrate?: readonly ApprovalRecord[],
    file?: JsonFileStore<PersistedApprovals>,
  ) {
    super();
    this.file = file;
    const initial = hydrate ?? file?.read()?.records ?? [];
    for (const record of initial) {
      super.grant(record);
    }
  }

  override grant(record: ApprovalRecord): void {
    super.grant(record);
    this.persist();
  }

  override revoke(modelId: string): void {
    super.revoke(modelId);
    this.persist();
  }

  private persist(): void {
    this.file?.write({ records: this.list() });
  }
}
