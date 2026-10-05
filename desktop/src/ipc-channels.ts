/**
 * The fixed IPC channel list (D1).
 *
 * One source of truth for the channel names so main and preload cannot drift.
 * The renderer can invoke ONLY these channels; main registers ONLY these
 * handlers. There is no generic "call" channel, so the IPC surface is an
 * enumerated boundary rather than an open proxy into the core.
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
] as const;

export type IpcChannel = (typeof IPC_CHANNELS)[number];
