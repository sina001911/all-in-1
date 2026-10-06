/**
 * Tool visibility (D3).
 *
 * Defense in depth for the mode gate. The executor already refuses a tool whose
 * class the mode does not permit (MODE_VIOLATION); visibility removes the
 * attempt as well: in INSPECT the model is never even told that `files.write`
 * exists. A model cannot ask for a capability it has never been offered.
 *
 * The filter is a NARROWING only. The mode decides the ceiling, the caller's
 * `tools` list may lower it further, and neither can raise it — the two sets are
 * intersected, never unioned.
 */
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolPermissionPolicy } from "../tools/permissions.ts";
import type { SafetyMode } from "../safety/guard.ts";
import type { ToolSchema } from "../tools/types.ts";

export function toolsVisibleInMode(
  registry: ToolRegistry,
  policy: ToolPermissionPolicy,
  mode: SafetyMode,
  allowed?: readonly string[],
): readonly ToolSchema[] {
  const ceiling = allowed ? new Set(allowed) : null;
  const visible: ToolSchema[] = [];
  for (const tool of registry.list()) {
    if (!policy.allowsMode(tool.schema, mode)) continue;
    if (ceiling && !ceiling.has(tool.schema.name)) continue;
    visible.push(tool.schema);
  }
  return visible;
}

/** True when the class of this tool is privileged in this mode. Null-safe: an
 * unknown tool is never privileged (and never reaches the count). */
export function isPrivilegedInMode(
  schema: ToolSchema | null,
  policy: ToolPermissionPolicy,
  mode: SafetyMode,
): boolean {
  return schema !== null && policy.requiresApproval(schema) && policy.allowsMode(schema, mode);
}
