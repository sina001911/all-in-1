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
}

export class PersistentBudgetLedger extends BudgetLedger {
  private readonly file: JsonFileStore<PersistedBudget> | undefined;
  private shadowReserved = 0;
  private shadowSpent = 0;

  constructor(
    budgetUsd: number,
    initial?: Partial<PersistedBudget>,
    file?: JsonFileStore<PersistedBudget>,
  ) {
    super(budgetUsd);
    this.file = file;
    const restored = initial ?? file?.read();
    this.shadowReserved = Math.max(0, restored?.reservedUsd ?? 0);
    this.shadowSpent = Math.max(0, restored?.spentUsd ?? 0);
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
    });
  }
}
