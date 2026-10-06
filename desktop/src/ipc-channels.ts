/**
 * The fixed IPC channel list (D1 + D2).
 *
 * One source of truth for the channel names so main and preload cannot drift.
 * The renderer can invoke ONLY these channels; main registers ONLY these
 * handlers. There is no generic "call" channel, so the IPC surface is an
 * enumerated boundary rather than an open proxy into the core.
 *
 * D2 adds the tool surface: the renderer may list tools, invoke one, and
 * resolve the approval a privileged tool requested. It can never approve its
 * own request — the approval channel is the human's answer to a request the
 * executor raised.
 */

export const IPC_CHANNELS = [
  "all-in-1:frozen-defaults",
  "all-in-1:system-status",
  "all-in-1:budget",
  "all-in-1:runs:list",
  "all-in-1:run:get",
  "all-in-1:run:diagnostic",
  "all-in-1:run:cancel",
  "all-in-1:approvals:list",
  "all-in-1:approvals:grant",
  "all-in-1:approvals:revoke",
  "all-in-1:usage:list",
  "all-in-1:usage:totals",
  "all-in-1:logs:list",
  "all-in-1:settings:get",
  "all-in-1:settings:patch",
  "all-in-1:credentials:names",
  "all-in-1:credentials:has",
  "all-in-1:credentials:set",
  "all-in-1:credentials:delete",
  // D2 tool runtime
  "all-in-1:tools:list",
  "all-in-1:tools:invoke",
  "all-in-1:tools:audit:list",
  "all-in-1:tools:approvals:pending",
  "all-in-1:tools:approve",
  "all-in-1:tools:deny",
  // D4 agent runtime
  "all-in-1:agent:tools",
  "all-in-1:agent:run",
] as const;

export type IpcChannel = (typeof IPC_CHANNELS)[number];
