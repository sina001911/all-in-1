/**
 * Budget suite: frozen default 0 blocks all spend; reserve/check/release
 * semantics; over-budget reservations fail.
 */
import { describe, expect, it } from "vitest";
import { BudgetLedger } from "../src/registry/budget.ts";

describe("budget ledger", () => {
  it("defaults to zero budget and blocks any positive reservation", () => {
    const ledger = new BudgetLedger(0);
    expect(ledger.reserve(0.01)).toBe(false);
    expect(ledger.snapshot()).toEqual({ budgetUsd: 0, reservedUsd: 0, spentUsd: 0 });
  });

  it("allows zero reservations for free models", () => {
    const ledger = new BudgetLedger(0);
    expect(ledger.reserve(0)).toBe(true);
    expect(ledger.remaining()).toBe(0);
  });

  it("reserves, releases, and commits within budget", () => {
    const ledger = new BudgetLedger(1);
    expect(ledger.reserve(0.4)).toBe(true);
    expect(ledger.remaining()).toBe(0.6);
    ledger.release(0.1);
    expect(ledger.remaining()).toBeCloseTo(0.7);
    ledger.commit(0.3);
    expect(ledger.snapshot().spentUsd).toBeCloseTo(0.3);
  });

  it("refuses reservations that would exceed the budget", () => {
    const ledger = new BudgetLedger(1);
    expect(ledger.reserve(0.6)).toBe(true);
    expect(ledger.reserve(0.5)).toBe(false);
  });

  it("ignores non-finite and negative amounts", () => {
    const ledger = new BudgetLedger(1);
    expect(ledger.reserve(Number.NaN)).toBe(false);
    expect(ledger.reserve(-1)).toBe(false);
  });
});
