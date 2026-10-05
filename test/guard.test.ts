/**
 * Guard suite: mode matrix (edit denied in INSPECT/SUGGEST), HITL default,
 * --auto hard caps, and escalation always pausing for the human.
 */
import { describe, expect, it } from "vitest";
import {
  assertCanAnalyze,
  assertCanEdit,
  assertCanPlan,
  assertAutoBounds,
  DEFAULT_AUTO_OPTIONS,
  MODE_PERMISSIONS,
  mustPauseForHuman,
  ModeViolationError,
  type IterationState,
} from "../src/safety/guard.ts";

function state(over: Partial<IterationState> = {}): IterationState {
  return { iteration: 0, edits: 0, dryRunCompleted: false, escalated: false, ...over };
}

describe("safety modes", () => {
  it("denies edits in INSPECT and SUGGEST", () => {
    expect(() => assertCanEdit("INSPECT")).toThrow(ModeViolationError);
    expect(() => assertCanEdit("SUGGEST")).toThrow(ModeViolationError);
    expect(() => assertCanEdit("BUILD")).not.toThrow();
  });

  it("denies planning in INSPECT but allows analysis everywhere", () => {
    expect(() => assertCanPlan("INSPECT")).toThrow(ModeViolationError);
    expect(() => assertCanPlan("SUGGEST")).not.toThrow();
    for (const mode of ["INSPECT", "SUGGEST", "BUILD"] as const) {
      expect(() => assertCanAnalyze(mode)).not.toThrow();
    }
  });

  it("never allows iteration outside BUILD", () => {
    expect(MODE_PERMISSIONS.INSPECT.iterate).toBe(false);
    expect(MODE_PERMISSIONS.SUGGEST.iterate).toBe(false);
    expect(MODE_PERMISSIONS.BUILD.iterate).toBe(true);
  });
});

describe("--auto bounds", () => {
  it("is opt-in and never a default", () => {
    expect(DEFAULT_AUTO_OPTIONS.auto).toBe(false);
  });

  it("enforces the lowered iteration cap", () => {
    expect(() =>
      assertAutoBounds({ ...DEFAULT_AUTO_OPTIONS, auto: true }, state({ iteration: 5 })),
    ).toThrow(/maxIterations/);
  });

  it("enforces the edit cap", () => {
    expect(() =>
      assertAutoBounds({ ...DEFAULT_AUTO_OPTIONS, auto: true }, state({ edits: 20 })),
    ).toThrow(/maxEdits/);
  });

  it("requires a dry-run first iteration before any edit", () => {
    expect(() =>
      assertAutoBounds({ ...DEFAULT_AUTO_OPTIONS, auto: true }, state({ edits: 1 })),
    ).toThrow(/dry-run/);
  });

  it("refuses iteration without --auto", () => {
    expect(() => assertAutoBounds(DEFAULT_AUTO_OPTIONS, state())).toThrow(/without --auto/);
  });

  it("always pauses for the human when escalated", () => {
    expect(mustPauseForHuman(DEFAULT_AUTO_OPTIONS, state({ escalated: true }))).toBe(true);
    expect(
      mustPauseForHuman({ ...DEFAULT_AUTO_OPTIONS, auto: true }, state({ escalated: false })),
    ).toBe(false);
  });
});
