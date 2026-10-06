/**
 * Tool permission policy (D2).
 *
 * Two independent questions are answered here, and they must stay independent:
 *
 *   1. Does this tool's privilege class require a HUMAN approval before it may
 *      run? This is the "the model must never approve its own request" rule:
 *      the answer is a property of the class, not of the caller, so no request
 *      shape can talk the runtime out of asking a human.
 *   2. Does the current safety MODE permit this class at all? Reuses the frozen
 *      `MODE_PERMISSIONS` from the existing guard: INSPECT may analyze, SUGGEST
 *      may plan, BUILD may edit. A write tool in INSPECT is refused before the
 *      approval question is ever reached.
 *
 * Frozen defaults under this policy: reads and captures need no approval (a
 * capture is already confined to localhost by the browser engine's own host
 * policy); writes, process execution, and network calls always do.
 */
import type { PermissionClass, ToolSchema } from "./types.ts";
import { MODE_PERMISSIONS, type SafetyMode } from "../safety/guard.ts";

export interface ClassPolicy {
  readonly requiresApproval: boolean;
}

export const DEFAULT_TOOL_POLICIES: Readonly<Record<PermissionClass, ClassPolicy>> = {
  read: { requiresApproval: false },
  capture: { requiresApproval: false },
  write: { requiresApproval: true },
  execute: { requiresApproval: true },
  network: { requiresApproval: true },
};

/**
 * The classes a mode must explicitly permit. Mapped onto the frozen mode
 * permissions so this policy cannot invent a privilege the guard does not have.
 */
const CLASS_MODE_PERMISSION: Readonly<Record<PermissionClass, keyof typeof MODE_PERMISSIONS["BUILD"]>> = {
  read: "analyze",
  capture: "capture",
  write: "edit",
  execute: "edit",
  network: "edit",
};

export class ToolPermissionPolicy {
  private readonly policies: Readonly<Record<PermissionClass, ClassPolicy>>;

  constructor(overrides?: Partial<Record<PermissionClass, Partial<ClassPolicy>>>) {
    const merged: Record<PermissionClass, ClassPolicy> = { ...DEFAULT_TOOL_POLICIES };
    if (overrides) {
      for (const [key, val] of Object.entries(overrides)) {
        const cls = key as PermissionClass;
        merged[cls] = { ...merged[cls], ...val };
      }
    }
    this.policies = merged;
  }

  /** True when a human must approve this tool before it executes. */
  requiresApproval(tool: ToolSchema): boolean {
    return (this.policies[tool.permission] ?? DEFAULT_TOOL_POLICIES[tool.permission]).requiresApproval;
  }

  /**
   * True when the mode permits this tool's class. A tool the mode does not
   * permit is refused outright — approval would be meaningless.
   */
  allowsMode(tool: ToolSchema, mode: SafetyMode): boolean {
    return MODE_PERMISSIONS[mode][CLASS_MODE_PERMISSION[tool.permission]];
  }

  /** The frozen defaults, for display and audit. */
  get defaults(): Readonly<Record<PermissionClass, ClassPolicy>> {
    return this.policies;
  }
}
