/**
 * Tool audit store (D2).
 *
 * Persists the privileged audit trail: every tool request, approval, refusal,
 * and outcome. The core audit log defines the record shape; this store only
 * appends and reads it back, so the trail survives a restart.
 *
 * Records carry no file contents and no secrets — the executor's summarizer
 * guarantees that before the record is ever built. As a second line of defence
 * this store drops any field whose name looks like a secret, exactly as the
 * D1 log store does.
 */
import type { ToolAuditRecord, ToolAuditLog } from "../../../src/tools/audit.ts";
import { JsonlAppendStore } from "../persistence/json-store.ts";

const SUSPECT_KEY = /(?:key|token|secret|password|credential|auth)/i;

export class FileToolAuditStore implements ToolAuditLog {
  private readonly store: JsonlAppendStore;

  constructor(store: JsonlAppendStore) {
    this.store = store;
  }

  record(rec: ToolAuditRecord): void {
    const fields = rec.inputSummary as Record<string, unknown> | undefined;
    const sanitized = fields
      ? Object.fromEntries(Object.entries(fields).filter(([k]) => !SUSPECT_KEY.test(k)))
      : undefined;
    this.store.append(
      JSON.stringify({ ...rec, inputSummary: sanitized ?? {} }),
    );
  }

  list(since?: number): readonly ToolAuditRecord[] {
    return this.store
      .readAll()
      .map((line) => {
        try {
          return JSON.parse(line) as ToolAuditRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is ToolAuditRecord => r !== null)
      .filter((r) => since === undefined || r.ts >= since)
      .sort((a, b) => a.ts - b.ts);
  }

  clear(): void {
    this.store.clear();
  }
}
