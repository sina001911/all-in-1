/**
 * Usage store (D1). Accounts model invocations: tokens, cost, latency, outcome.
 *
 * Records hold no secret material. Provider-derived text is never stored here —
 * only accounting counters, which are safe by construction.
 */
import type { UsageRecord, UsageStore } from "./types.ts";
import { JsonFileStore } from "./json-store.ts";

interface UsageFile {
  readonly entries: readonly UsageRecord[];
}

export class FileUsageStore implements UsageStore {
  private readonly file: JsonFileStore<UsageFile>;
  private entries: UsageRecord[] = [];

  constructor(file: JsonFileStore<UsageFile>) {
    this.file = file;
    this.entries = [...(file.read()?.entries ?? [])];
  }

  record(entry: UsageRecord): void {
    this.entries = [...this.entries, entry];
  }

  list(): readonly UsageRecord[] {
    return [...this.entries].sort((a, b) => a.ts - b.ts);
  }

  totals(): { readonly invocations: number; readonly totalCostUsd: number; readonly totalTokens: number } {
    let cost = 0;
    let tokens = 0;
    for (const e of this.entries) {
      cost += Number.isFinite(e.costUsd) ? e.costUsd : 0;
      tokens += (e.promptTokens ?? 0) + (e.completionTokens ?? 0);
    }
    return { invocations: this.entries.length, totalCostUsd: cost, totalTokens: tokens };
  }

  clear(): void {
    this.entries = [];
  }

  save(): void {
    this.file.write({ entries: this.entries });
  }
}

export class MemoryUsageStore implements UsageStore {
  private entries: UsageRecord[] = [];

  record(entry: UsageRecord): void {
    this.entries = [...this.entries, entry];
  }
  list(): readonly UsageRecord[] {
    return [...this.entries].sort((a, b) => a.ts - b.ts);
  }
  totals(): { readonly invocations: number; readonly totalCostUsd: number; readonly totalTokens: number } {
    let cost = 0;
    let tokens = 0;
    for (const e of this.entries) {
      cost += Number.isFinite(e.costUsd) ? e.costUsd : 0;
      tokens += (e.promptTokens ?? 0) + (e.completionTokens ?? 0);
    }
    return { invocations: this.entries.length, totalCostUsd: cost, totalTokens: tokens };
  }
  clear(): void {
    this.entries = [];
  }
  save(): void {
    /* in-memory: no-op */
  }
}
