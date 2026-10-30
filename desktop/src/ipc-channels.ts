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
  // D24: per-run cost/token accounting. With no argument it reports every run;
  // a run id reports that run alone. Read-only, like the rest of this list.
  "all-in-1:run:usage",
  "all-in-1:run:diagnostic",
  "all-in-1:run:cancel",
  // D35: run management — rename, delete, and search. The id is the run's own
  // content-addressed key; a rename is cosmetic and a delete never touches the
  // artifact store or the usage ledger.
  "all-in-1:run:rename",
  "all-in-1:run:delete",
  "all-in-1:run:search",
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
  "all-in-1:agent:stream",
  // Compare: N independent gated agent runs for one prompt, bounded
  // concurrency, per-model isolation. Each run is a full 7-gate execution
  // with its own runId (cmp-<base>-<i>) — no path around the pipeline.
  "all-in-1:agent:many",
  // D16: workflow stream mirrors agent bridge contract with a distinct run namespace.
  // D34: collab reuses this channel for participant stream frames (via getWorkflowStream).
  "all-in-1:workflow:stream",
  // D34: Collaborate — configurable multi-model orchestration (run + stream reuse).
  "all-in-1:collab:run",
  // D5 read-only model/provider and workspace views
  "all-in-1:models:list",
  "all-in-1:models:posture",
  "all-in-1:models:providers",
  "all-in-1:workspace:roots",
  // D6: the native folder picker. The renderer may ASK main to let the user
  // choose a directory; it can never name one itself. Main owns the dialog and
  // performs the sanitized settings write, so a compromised renderer cannot
  // expand the tool sandbox by guessing a path.
  // D7: the user may register providers; the renderer sees the warnings
  // registration produced (surfaced, never silently swallowed).
  "all-in-1:providers:warnings",
  // D21: explicit provider-config validation before save.
  "all-in-1:providers:test",
  // D7: pull the catalogue a gateway advertises, without registering anything.
  "all-in-1:providers:discover",
  "all-in-1:workspace:pick",
  // D35: the artifact surface. The renderer lists, reads, and downloads
  // artifacts by id; it never sees the base path, only ids the facade hands
  // back. The id is content-addressed and regex-validated on the store side,
  // so a crafted id cannot escape the artifact directory.
  "all-in-1:artifacts:list",
  "all-in-1:artifacts:read",
  "all-in-1:artifacts:download",
  // D35: analyze an uploaded image. The renderer supplies the artifact id
  // (never raw bytes); the facade reads the bytes from the store and routes
  // the VISION role through the frozen PREFERRED_FREE policy.
  "all-in-1:artifacts:analyze",
  // D35: analyze an uploaded file by content type. image/* routes through the
  // VISION path; text/* is decoded and summarized locally; anything else is
  // reported as binary. No external API is called for any branch.
  "all-in-1:artifacts:analyze-file",
  // D35: the renderer may upload a file the user picked in the OS dialog.
  // Main owns the dialog and the bytes; the renderer supplies nothing but
  // the resulting id, and the store confines the write to paths.artifacts.
  "all-in-1:upload:file",
  // D35: the renderer may upload bytes it already has (a <input type=file>
  // pick). The bytes cross the bridge as a plain array — never a path.
  "all-in-1:upload:bytes",
  // D35: collab progress. The renderer polls this while a collaborate run is
  // in flight so a long orchestration shows live participant status instead
  // of a frozen card. Pull-only, like every other channel here.
  "all-in-1:collab:progress",
  // D35: compare progress. A compare run is N independent gated agent runs
  // under one batch id; the renderer polls this while a compare runs so a long
  // batch shows per-model status instead of a frozen card. Pull-only.
  "all-in-1:compare:progress",
  // P1-6: generate media (images, video) through the gated router. The media
  // gate is frozen (media.enabled = false in the MVP), so every call short-
  // circuits before any provider lookup or transport call.
  "all-in-1:media:generate",
  // P1-6: cancel an in-flight media generation. The desktop stack owns the
  // abort controller; this just triggers it. A cancelled attempt is never
  // retried — the adapter throws a typed `cancelled` media error.
  "all-in-1:media:cancel",
] as const;

export type IpcChannel = (typeof IPC_CHANNELS)[number];
