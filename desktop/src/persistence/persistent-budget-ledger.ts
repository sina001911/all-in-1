/**
 * Persistent budget ledger (D1).
 *
 * Subclasses the core `BudgetLedger` so the engine keeps holding the exact type
 * it always has; no core module is modified.
 *
 * The core ledger's counters are private and not restorable through its public
 * API, so this subclass shadows them with its own fields and re-implements the
 * *same* arithmetic (the frozen reserve/release/commit rules are copied
 * verbatim, not reinterpreted). Reserved and spent state is written through on
 * every mutation and hydrated on construction, so the ledger survives a
 * restart — and, critically, so does the reservation-release guarantee: the
 * shadow is only ever advanced through the same guarded methods.
 */
import { BudgetLedger } from "../../../src/registry/budget.ts";
import type { BudgetSnapshot } from "../../../src/registry/budget.ts";
import { JsonFileStore } from "./json-store.ts";

export interface PersistedBudget {
  readonly budgetUsd: number;
  readonly reservedUsd: number;
  readonly spentUsd: number;
  /**
   * D35: media generations settled so far. Distinct from `spentUsd` because a
   * free generation still consumes a slot under `maxMediaGenerations`.
   */
  readonly spentGenerations?: number;
}

export class PersistentBudgetLedger extends BudgetLedger {
  private readonly file: JsonFileStore<PersistedBudget> | undefined;
  private shadowReserved = 0;
  private shadowSpent = 0;
  private shadowGenerations = 0;

  constructor(
    budgetUsd: number,
    initial?: Partial<PersistedBudget>,
    file?: JsonFileStore<PersistedBudget>,
  ) {
    super(budgetUsd);
    this.file = file;
    let restored: PersistedBudget | undefined;
    try {
      // `initial` is partial (a patch), so merge it onto the stored record
      // rather than assigning it directly: the shadow fields are all
      // required, and a partial must not silently leave one undefined.
      const stored = file?.read();
      restored = stored ? { ...stored, ...initial } : initial as PersistedBudget | undefined;
    } catch (e) {
      // The budget ledger is the most consequential of the persistent stores:
      // a silent reset here would lose the spend tracking with no warning.
      // Surface the error and start from zero — the operator will see it in
      // the log and can recover the state from the usage store if needed.
      console.error("budget ledger: starting from zero because the persisted file is unreadable", e);
    }
    this.shadowReserved = Math.max(0, restored?.reservedUsd ?? 0);
    this.shadowSpent = Math.max(0, restored?.spentUsd ?? 0);
    this.shadowGenerations = Math.max(0, restored?.spentGenerations ?? 0);
  }

  override reserve(amount: number): boolean {
    if (!Number.isFinite(amount) || amount < 0) return false;
    if (this.shadowReserved + this.shadowSpent + amount > this.budgetUsd) return false;
    this.shadowReserved += amount;
    this.persist();
    return true;
  }

  override release(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.shadowReserved = Math.max(0, this.shadowReserved - amount);
    this.persist();
  }

  override commit(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    const move = Math.min(this.shadowReserved, amount);
    this.shadowReserved -= move;
    this.shadowSpent += amount;
    this.persist();
  }

  override remaining(): number {
    return Math.max(0, this.budgetUsd - this.shadowReserved - this.shadowSpent);
  }

  override incrementGeneration(): void {
    this.shadowGenerations += 1;
    this.persist();
  }

  override get spentGenerationsCount(): number {
    return this.shadowGenerations;
  }

  override snapshot(): BudgetSnapshot {
    return {
      budgetUsd: this.budgetUsd,
      reservedUsd: this.shadowReserved,
      spentUsd: this.shadowSpent,
    };
  }

  private persist(): void {
    this.file?.write({
      budgetUsd: this.budgetUsd,
      reservedUsd: this.shadowReserved,
      spentUsd: this.shadowSpent,
      spentGenerations: this.shadowGenerations,
    });
  }
}
