/**
 * Spend budget ledger. Frozen default: spendBudgetUsd = 0.
 *
 * The ledger only tracks monetary budget. Token/media counters live in the
 * workflow layer (P5). Reservation semantics: reserve() is checked *before*
 * any call is made; release() returns the reservation when a call fails or is
 * cancelled; commit() is not needed in P1 because no call is ever made.
 */
export interface BudgetSnapshot {
  readonly budgetUsd: number;
  readonly reservedUsd: number;
  readonly spentUsd: number;
}

export class BudgetLedger {
  private reserved = 0;
  private spent = 0;
  readonly budgetUsd: number;

  constructor(budgetUsd: number) {
    this.budgetUsd = budgetUsd;
  }

  /**
   * Reserve `amount`. Returns false when the reservation would exceed the
   * remaining budget. Zero reservations always succeed (free models).
   */
  reserve(amount: number): boolean {
    if (!Number.isFinite(amount) || amount < 0) return false;
    if (this.reserved + this.spent + amount > this.budgetUsd) return false;
    this.reserved += amount;
    return true;
  }

  release(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.reserved = Math.max(0, this.reserved - amount);
  }

  /** Convert a reservation into actual spend. */
  commit(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    const move = Math.min(this.reserved, amount);
    this.reserved -= move;
    this.spent += amount;
  }

  remaining(): number {
    return Math.max(0, this.budgetUsd - this.reserved - this.spent);
  }

  snapshot(): BudgetSnapshot {
    return { budgetUsd: this.budgetUsd, reservedUsd: this.reserved, spentUsd: this.spent };
  }
}
