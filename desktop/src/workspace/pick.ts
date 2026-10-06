/**
 * Workspace root selection (D6).
 *
 * The native folder picker is the ONE place where a path can enter the set of
 * directories the tool runtime is confined to, so the rule is kept here as a
 * pure function rather than inline in the Electron handler:
 *
 *   - only a path the USER explicitly chose in the native dialog is ever added
 *     (a cancelled dialog adds nothing);
 *   - the same directory is never added twice;
 *   - REMOVAL is narrowing only — the root list can only ever lose an entry.
 *
 * This module is deliberately Electron-free so it is fully exercisable under
 * plain Node/vitest, exactly like the facade. It performs no IO: the caller
 * owns the dialog and the sanitized settings write, so the only thing this file
 * decides is WHICH list is correct given a chosen path.
 */

/** The outcome of a pick, as the renderer needs to render it. */
export interface WorkspacePickResult {
  /** True when a new root was actually added (false = cancelled or duplicate). */
  readonly added: boolean;
  /** The full root list after the pick — always the sanitized list to persist. */
  readonly roots: readonly string[];
  /** The directory the user chose, when they chose one. */
  readonly chosen?: string;
}

/**
 * Apply a directory the user selected in the native dialog.
 *
 * `chosen` is undefined when the dialog was cancelled. The result is a NEW
 * list; the input is never mutated, so a rejection by the settings store cannot
 * leave a half-applied state behind.
 */
export function applyPickedRoot(
  current: readonly string[],
  chosen: string | undefined,
): WorkspacePickResult {
  if (chosen === undefined || chosen.trim().length === 0) {
    return { added: false, roots: [...current] };
  }
  if (current.includes(chosen)) {
    return { added: false, roots: [...current], chosen };
  }
  return { added: true, roots: [...current, chosen], chosen };
}

/**
 * Remove one root. Narrowing only: the result is a subset of the input, never a
 * superset, so this can never widen the tool sandbox.
 */
export function removeRoot(current: readonly string[], target: string): readonly string[] {
  return current.filter((r) => r !== target);
}