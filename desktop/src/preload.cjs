/**
 * Preload (D1).
 *
 * Runs in an ISOLATED context: the renderer page itself has no Node access.
 * This script is the only bridge, and it exposes an enumerated API object on
 * `window.allInOne` — never `ipcRenderer`, never Node, never the engine.
 *
 * Credential values travel only through `setCredential` (write-only); no
 * exposed method returns a secret value.
 */
const { contextBridge, ipcRenderer } = require("electron");

const api = {
  getFrozenDefaults: () => ipcRenderer.invoke("all-in-1:frozen-defaults"),
  getSystemStatus: () => ipcRenderer.invoke("all-in-1:system-status"),
  getBudget: () => ipcRenderer.invoke("all-in-1:budget"),
  listRuns: () => ipcRenderer.invoke("all-in-1:runs:list"),
  getRun: (id) => ipcRenderer.invoke("all-in-1:run:get", id),
  // D24: no argument lists every run's accounting; an id reports that run.
  getRunUsage: (runId) => ipcRenderer.invoke("all-in-1:run:usage", runId),
  runDiagnostic: (request) => ipcRenderer.invoke("all-in-1:run:diagnostic", request),
  cancelRun: (runId) => ipcRenderer.invoke("all-in-1:run:cancel", runId),
  // D35: run management — rename, delete, and search. The id is the run's own
  // content-addressed key; a rename is cosmetic and a delete never touches the
  // artifact store or the usage ledger.
  renameRun: (runId, name) => ipcRenderer.invoke("all-in-1:run:rename", { runId, name }),
  deleteRun: (runId) => ipcRenderer.invoke("all-in-1:run:delete", runId),
  searchRuns: (query) => ipcRenderer.invoke("all-in-1:run:search", query),
  listApprovals: () => ipcRenderer.invoke("all-in-1:approvals:list"),
  grantApproval: (record) => ipcRenderer.invoke("all-in-1:approvals:grant", record),
  revokeApproval: (modelId) => ipcRenderer.invoke("all-in-1:approvals:revoke", modelId),
  listUsage: () => ipcRenderer.invoke("all-in-1:usage:list"),
  getUsageTotals: () => ipcRenderer.invoke("all-in-1:usage:totals"),
  listLogs: (since) => ipcRenderer.invoke("all-in-1:logs:list", since),
  getSettings: () => ipcRenderer.invoke("all-in-1:settings:get"),
  patchSettings: (patch) => ipcRenderer.invoke("all-in-1:settings:patch", patch),
  listCredentialNames: () => ipcRenderer.invoke("all-in-1:credentials:names"),
  hasCredential: (name) => ipcRenderer.invoke("all-in-1:credentials:has", name),
  setCredential: (name, value) => ipcRenderer.invoke("all-in-1:credentials:set", name, value),
  deleteCredential: (name) => ipcRenderer.invoke("all-in-1:credentials:delete", name),
  // D2 tools
  listTools: () => ipcRenderer.invoke("all-in-1:tools:list"),
  invokeTool: (request) => ipcRenderer.invoke("all-in-1:tools:invoke", request),
  listToolAudit: (since) => ipcRenderer.invoke("all-in-1:tools:audit:list", since),
  listPendingToolApprovals: () => ipcRenderer.invoke("all-in-1:tools:approvals:pending"),
  approveTool: (id, note) => ipcRenderer.invoke("all-in-1:tools:approve", id, note),
  denyTool: (id, reason) => ipcRenderer.invoke("all-in-1:tools:deny", id, reason),
  // D4 agent
  listAgentTools: (mode) => ipcRenderer.invoke("all-in-1:agent:tools", mode),
  runAgent: (request) => ipcRenderer.invoke("all-in-1:agent:run", request),
  // Compare: one prompt against N selected models. The payload is exactly
  // what buildManyRequest validates; nothing else crosses this channel.
  runMany: (input) => ipcRenderer.invoke("all-in-1:agent:many", input),
  getAgentStream: (runId, cursor) => ipcRenderer.invoke("all-in-1:agent:stream", { runId, cursor }),
  getWorkflowStream: (runId, cursor) => ipcRenderer.invoke("all-in-1:workflow:stream", { runId, cursor }),
  // D34: collaborative path. Each participant's frames carry a `participantId`
  // tag and are served by the same bridge, so the renderer routes them per card.
  runCollab: (request) => ipcRenderer.invoke("all-in-1:collab:run", request),
  // D34: collab stream events are served by the shared workflow bridge channel.
  // The renderer uses getWorkflowStream directly; no separate preload entry needed.
  // D5 read-only views
  listModels: () => ipcRenderer.invoke("all-in-1:models:list"),
  getSelectionPosture: () => ipcRenderer.invoke("all-in-1:models:posture"),
  listModelProviders: () => ipcRenderer.invoke("all-in-1:models:providers"),
  listWorkspaceRoots: () => ipcRenderer.invoke("all-in-1:workspace:roots"),
  // D8: why a registered provider was skipped at startup.
  getProviderWarnings: () => ipcRenderer.invoke("all-in-1:providers:warnings"),
  validateProviderConfig: (provider) => ipcRenderer.invoke("all-in-1:providers:test", provider),
  // D7: fetch the catalogue a gateway advertises, without registering anything.
  discoverModels: (input) => ipcRenderer.invoke("all-in-1:providers:discover", input),
  // D6: asks MAIN to let the user pick a folder. This takes no path argument —
  // the renderer can only request the dialog, never name a directory.
  pickWorkspaceRoot: () => ipcRenderer.invoke("all-in-1:workspace:pick"),
  // D35: the artifact surface. The renderer lists, reads, and downloads by id;
  // the id is content-addressed and regex-validated on the store side, so a
  // crafted id cannot escape the artifact directory. The bytes never cross
  // the bridge as a raw path — the renderer receives the payload and writes
  // it itself, or main writes it for a download.
  listArtifacts: () => ipcRenderer.invoke("all-in-1:artifacts:list"),
  getArtifact: (id) => ipcRenderer.invoke("all-in-1:artifacts:read", id),
  downloadArtifact: (id) => ipcRenderer.invoke("all-in-1:artifacts:download", id),
  // D35: analyze an uploaded image. The renderer supplies the artifact id
  // (never raw bytes); the facade reads the bytes from the store and routes
  // the VISION role through the frozen PREFERRED_FREE policy.
  analyzeImage: (id) => ipcRenderer.invoke("all-in-1:artifacts:analyze", id),
  // D35: analyze an uploaded file by content type. image/* routes through the
  // VISION path; text/* is decoded and summarized locally; anything else is
  // reported as binary. No external API is called for any branch.
  analyzeFile: (id) => ipcRenderer.invoke("all-in-1:artifacts:analyze-file", id),
  // D35: the renderer may upload a file the user picked in the OS dialog.
  // Main owns the dialog and the bytes; the renderer supplies nothing but
  // the resulting id, and the store confines the write to paths.artifacts.
  // Two entry points: uploadFile() opens the OS dialog (main owns the bytes);
  // uploadBytes(bytes, name) accepts bytes the renderer already has, e.g. a
  // file the user picked via <input type=file> in the browser.
  uploadFile: () => ipcRenderer.invoke("all-in-1:upload:file"),
  uploadBytes: (bytes, name) => ipcRenderer.invoke("all-in-1:upload:bytes", { bytes, name }),
  // D35: collab progress. Pull-only, like every other channel here; the
  // renderer polls this while a collab runs so a long orchestration shows
  // live participant status instead of a frozen card.
  getCollabProgress: (runId) => ipcRenderer.invoke("all-in-1:collab:progress", { runId }),
  // D35: compare progress. A compare run is N independent gated agent runs
  // under one batch id; the renderer polls this while a compare runs so a long
  // batch shows per-model status instead of a frozen card. Pull-only.
  getCompareProgress: (batchId) => ipcRenderer.invoke("all-in-1:compare:progress", { batchId }),
  // P1-6: media generation. The media gate is frozen in the MVP (media.enabled
  // = false), so every call returns MEDIA_DISABLED immediately — no credential
  // is read, no transport is opened. When the gate is flipped and a provider
  // is registered, the same channel generates images / video.
  generateMedia: (request) => ipcRenderer.invoke("all-in-1:media:generate", request),
  cancelMedia: (runId) => ipcRenderer.invoke("all-in-1:media:cancel", runId),
};

contextBridge.exposeInMainWorld("allInOne", api);
