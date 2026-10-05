/**
 * The P6 edit boundary.
 *
 * P5's workflow loop intentionally never asserted `assertCanEdit`: it has no edit
 * action, so asserting it there would wrongly refuse INSPECT and SUGGEST. P6 is
 * the point at which an edit surface first becomes conceivable — a BUILD command
 * can hand back a plan that describes edits — so this is where the frozen guard
 * is asserted: at the moment an edit-capable plan is produced, not later.
 *
 * all_in_1 still never writes a file. The only file writers are the OpenCode
 * tools (architecture row 4); this plugin binds commands, not writers. What the
 * gate guarantees is that a plan which could drive edits can only ever be
 * produced in a mode that holds the edit permission — BUILD — and that INSPECT
 * and SUGGEST cannot yield one by construction.
 */
import { assertCanEdit, type SafetyMode } from "../safety/guard.ts";

/**
 * Refuse to produce an edit-capable plan outside BUILD. Throws the frozen
 * `ModeViolationError`, whose message names the mode and the action.
 */
export function assertEditPlanAllowed(mode: SafetyMode): void {
  assertCanEdit(mode);
}

/**
 * The disclaimer attached to every edit-capable deliverable so the recipient
 * (the session agent and the human behind it) knows the plan is not an edit and
 * who is allowed to apply it. Stated rather than assumed.
 */
export function editPlanDisclaimer(): string {
  return [
    "This is a plan, not an edit. all_in_1 never writes files.",
    "Apply it with the OpenCode write/edit/patch tools under human supervision.",
  ].join(" ");
}
