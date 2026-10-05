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
  runDiagnostic: (request) => ipcRenderer.invoke("all-in-1:run:diagnostic", request),
  cancelRun: (runId) => ipcRenderer.invoke("all-in-1:run:cancel", runId),
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
};

contextBridge.exposeInMainWorld("allInOne", api);
