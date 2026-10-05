/**
 * Safety guard: mode enforcement + human-in-the-loop rules.
 *
 * INSPECT: analysis only. SUGGEST: analysis + plan. BUILD: approved edits,
 * HITL by default. `--auto` is an explicit per-run opt-in and remains bounded
 * by every hard iteration/cost/safety limit.
 */
export const SAFETY_MODES = ["INSPECT", "SUGGEST", "BUILD"] as const;
export type SafetyMode = (typeof SAFETY_MODES)[number];

export interface ModePermissions {
  readonly analyze: boolean;
  readonly capture: boolean;
  readonly plan: boolean;
  readonly edit: boolean;
  readonly iterate: boolean;
}

export const MODE_PERMISSIONS: Readonly<Record<SafetyMode, ModePermissions>> = {
  INSPECT: { analyze: true, capture: true, plan: false, edit: false, iterate: false },
  SUGGEST: { analyze: true, capture: true, plan: true, edit: false, iterate: false },
  BUILD: { analyze: true, capture: true, plan: true, edit: true, iterate: true },
};

export class ModeViolationError extends Error {
  readonly mode: SafetyMode;
  readonly action: string;
  constructor(mode: SafetyMode, action: string) {
    super(`Action "${action}" is not permitted in ${mode} mode`);
    this.name = "ModeViolationError";
    this.mode = mode;
    this.action = action;
  }
}

export interface AutoOptions {
  /** Explicit per-run opt-in. Never a default. */
  readonly auto: boolean;
  readonly maxIterations: number;
  readonly maxEdits: number;
  /** First iteration must be a dry-run (diff only, no writes). */
  readonly dryRunFirst: boolean;
}

export const DEFAULT_AUTO_OPTIONS: AutoOptions = {
  auto: false,
  maxIterations: 5,
  maxEdits: 20,
  dryRunFirst: true,
};

export interface IterationState {
  readonly iteration: number;
  readonly edits: number;
  readonly dryRunCompleted: boolean;
  readonly escalated: boolean;
}

export function assertCanAnalyze(mode: SafetyMode): void {
  if (!MODE_PERMISSIONS[mode].analyze) throw new ModeViolationError(mode, "analyze");
}
export function assertCanCapture(mode: SafetyMode): void {
  if (!MODE_PERMISSIONS[mode].capture) throw new ModeViolationError(mode, "capture");
}
export function assertCanPlan(mode: SafetyMode): void {
  if (!MODE_PERMISSIONS[mode].plan) throw new ModeViolationError(mode, "plan");
}
export function assertCanEdit(mode: SafetyMode): void {
  if (!MODE_PERMISSIONS[mode].edit) throw new ModeViolationError(mode, "edit");
}

/** `--auto` hard bounds. Violations are failures, not warnings. */
export function assertAutoBounds(opts: AutoOptions, state: IterationState): void {
  if (!opts.auto) throw new ModeViolationError("BUILD", "iterate without --auto");
  if (state.iteration >= opts.maxIterations)
    throw new Error(`--auto hard limit reached: maxIterations=${opts.maxIterations}`);
  if (state.edits >= opts.maxEdits)
    throw new Error(`--auto hard limit reached: maxEdits=${opts.maxEdits}`);
  if (opts.dryRunFirst && !state.dryRunCompleted && state.iteration === 0 && state.edits > 0)
    throw new Error("--auto requires a dry-run first iteration before any edit");
}

/**
 * Escalation pauses the loop for the human even under `--auto`. This is the one
 * condition that overrides autonomy unconditionally.
 */
export function mustPauseForHuman(opts: AutoOptions, state: IterationState): boolean {
  if (state.escalated) return true;
  return false;
}
