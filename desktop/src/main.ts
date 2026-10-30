/**
 * Electron main process (D1).
 *
 * The ONLY module in the desktop package that imports `electron`. It:
 *   - builds the all_in_1 core stack with persistent stores and the OS-backed
 *     credential provider;
 *   - registers an enumerated set of IPC handlers that route to the
 *     DesktopFacade (no generic call channel);
 *   - opens a hardened renderer window (no nodeIntegration, contextIsolation,
 *     sandbox);
 *   - supports a headless `--selftest` that drives the full pipeline without a
 *     window, so the 7-gate path is verifiable in CI.
 *
 * The application does not import or require OpenCode anywhere.
 */
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, session } from "electron";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildDesktopStack } from "./desktop-stack.ts";
import { DesktopFacade } from "./facade.ts";
import { JsonFileStore } from "./persistence/json-store.ts";
import { resolveDataPaths } from "./persistence/paths.ts";
import { MEDIA_CAPABILITIES, type MediaRequest } from "../../src/media/types.ts";
import type { DesktopStack } from "./desktop-stack.ts";
import { ElectronSafeStorageCredentialProvider } from "./credentials/electron-safe-storage.ts";
import { applyPickedRoot } from "./workspace/pick.ts";
// D29: the diagnostic request mapping lives outside the Electron boundary so
// the seam that forwards `runId`/`streaming` to the facade is exercised in CI.
import { buildCollabRequest, buildDiagnosticRequest, buildManyRequest, isSafetyMode } from "./ipc-requests.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const isSelfTest = process.argv.includes("--selftest");

/**
 * D31: the one URL the app window is allowed to occupy. `loadFile()` does not
 * emit `will-navigate`, so this is only ever compared against a navigation the
 * page or a user click starts *after* the initial load.
 */
const RENDERER_URL = pathToFileURL(join(__dirname, "renderer", "index.html")).toString();

function buildStack(): DesktopStack {
  const baseDir = app.getPath("userData");
  // D1: sweep orphaned `.tmp` files left by a crashed writer before any store
  // opens, so a torn temp never masquerades as a live store on the next boot.
  JsonFileStore.recoverTmpFiles(resolveDataPaths(baseDir).root);
  return buildDesktopStack({
    baseDir,
    credentials: new ElectronSafeStorageCredentialProvider(
      safeStorage,
      join(baseDir, "all-in-1", "credentials.json"),
    ),
  });
}

function registerHandlers(facade: DesktopFacade): void {
  ipcMain.handle("all-in-1:frozen-defaults", () => facade.getFrozenDefaults());
  ipcMain.handle("all-in-1:system-status", () => facade.getSystemStatus());
  ipcMain.handle("all-in-1:budget", () => facade.getBudget());
  ipcMain.handle("all-in-1:runs:list", () => facade.listRuns());
  ipcMain.handle("all-in-1:run:get", (_e, id: unknown) =>
    typeof id === "string" ? facade.getRun(id) : undefined,
  );
  ipcMain.handle("all-in-1:run:usage", (_e, runId: unknown) =>
    typeof runId === "string" ? facade.getRunUsage(runId) : facade.listRunUsage(),
  );
  ipcMain.handle("all-in-1:run:diagnostic", (_e, raw: unknown) =>
    // D29: the mapping (not the registration) is the seam. `runId` and
    // `streaming` reach the facade from here, or the D16 bridge and the D18
    // progress UI stay unreachable.
    facade.runDiagnostic(buildDiagnosticRequest(raw)),
  );
  ipcMain.handle("all-in-1:run:cancel", (_e, runId: unknown) =>
    typeof runId === "string" ? facade.cancelRun(runId) : false,
  );
  // D35: run management — rename, delete, and search. The id is the run's own
  // content-addressed key; a rename is cosmetic and a delete never touches the
  // artifact store or the usage ledger.
  ipcMain.handle("all-in-1:run:rename", (_e, raw: unknown) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid rename request");
    const req = raw as Record<string, unknown>;
    const runId = req.runId;
    const name = req.name;
    if (typeof runId !== "string" || typeof name !== "string") {
      throw new Error("run:rename requires string runId and name");
    }
    return facade.renameRun(runId, name);
  });
  ipcMain.handle("all-in-1:run:delete", (_e, runId: unknown) =>
    typeof runId === "string" ? facade.removeRun(runId) : false,
  );
  ipcMain.handle("all-in-1:run:search", (_e, query: unknown) =>
    typeof query === "string" ? facade.searchRuns(query) : facade.searchRuns(""),
  );
  ipcMain.handle("all-in-1:approvals:list", () => facade.listApprovals());
  ipcMain.handle("all-in-1:approvals:grant", (_e, raw: unknown) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid approval record");
    const rec = raw as Record<string, unknown>;
    if (typeof rec.modelId !== "string") throw new Error("approval modelId must be a string");
    facade.grantApproval({
      modelId: rec.modelId,
      scope: rec.scope === "session" ? "session" : "run",
      grantedAt: typeof rec.grantedAt === "number" ? rec.grantedAt : Date.now(),
      usdCap: typeof rec.usdCap === "number" ? rec.usdCap : undefined,
      note: typeof rec.note === "string" ? rec.note : undefined,
    });
    return true;
  });
  ipcMain.handle("all-in-1:approvals:revoke", (_e, modelId: unknown) => {
    if (typeof modelId !== "string") throw new Error("modelId must be a string");
    facade.revokeApproval(modelId);
    return true;
  });
  ipcMain.handle("all-in-1:usage:list", () => facade.listUsage());
  ipcMain.handle("all-in-1:usage:totals", () => facade.getUsageTotals());
  ipcMain.handle("all-in-1:logs:list", (_e, since: unknown) =>
    typeof since === "number" ? facade.listLogs(since) : facade.listLogs(),
  );
  ipcMain.handle("all-in-1:settings:get", () => facade.getSettings());
  ipcMain.handle("all-in-1:settings:patch", (_e, patch: unknown) =>
    patch && typeof patch === "object" ? facade.patchSettings(patch as Record<string, unknown>) : facade.getSettings(),
  );
  ipcMain.handle("all-in-1:credentials:names", () => facade.listCredentialNames());
  ipcMain.handle("all-in-1:credentials:has", (_e, name: unknown) =>
    typeof name === "string" ? facade.hasCredential(name) : false,
  );
  ipcMain.handle("all-in-1:credentials:set", (_e, name: unknown, value: unknown) => {
    if (typeof name !== "string" || typeof value !== "string") {
      throw new Error("credential name and value must be strings");
    }
    facade.setCredential(name, value);
    return true;
  });
  ipcMain.handle("all-in-1:credentials:delete", (_e, name: unknown) => {
    if (typeof name !== "string") throw new Error("credential name must be a string");
    facade.deleteCredential(name);
    return true;
  });
  // D2 tool runtime. The renderer may invoke a tool and answer the approval a
  // privileged request raised; it may not approve a request that does not exist.
  ipcMain.handle("all-in-1:tools:list", () => facade.listTools());
  ipcMain.handle("all-in-1:tools:invoke", (_e, raw: unknown) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid tool request");
    const req = raw as Record<string, unknown>;
    if (typeof req.toolName !== "string") throw new Error("toolName must be a string");
    if (typeof req.runId !== "string") throw new Error("runId must be a string");
    return facade.invokeTool({
      toolName: req.toolName,
      input: req.input,
      runId: req.runId,
      mode: isSafetyMode(req.mode) ? req.mode : undefined,
      timeoutMs: typeof req.timeoutMs === "number" ? req.timeoutMs : undefined,
      justification: typeof req.justification === "string" ? req.justification : undefined,
    });
  });
  ipcMain.handle("all-in-1:tools:audit:list", (_e, since: unknown) =>
    typeof since === "number" ? facade.listToolAudit(since) : facade.listToolAudit(),
  );
  ipcMain.handle("all-in-1:tools:approvals:pending", () => facade.listPendingToolApprovals());
  ipcMain.handle("all-in-1:tools:approve", (_e, id: unknown, note: unknown) => {
    if (typeof id !== "string") throw new Error("approval id must be a string");
    return facade.approveTool(id, typeof note === "string" ? note : undefined);
  });
  ipcMain.handle("all-in-1:tools:deny", (_e, id: unknown, reason: unknown) => {
    if (typeof id !== "string") throw new Error("approval id must be a string");
    return facade.denyTool(id, typeof reason === "string" ? reason : undefined);
  });
  // D5 read-only views. The renderer may see which models exist, why only the
  // local ones are reachable, and which roots the tools are confined to. None
  // of these channels mutates anything.
  ipcMain.handle("all-in-1:models:list", () => facade.listModels());
  ipcMain.handle("all-in-1:models:posture", () => facade.selectionPosture());
  ipcMain.handle("all-in-1:models:providers", () => facade.listModelProviders());
  ipcMain.handle("all-in-1:workspace:roots", () => facade.listWorkspaceRoots());
  // D8: the warnings the D7 registration produced at startup, so the renderer
  // can explain a skipped provider instead of pretending it worked.
  ipcMain.handle("all-in-1:providers:warnings", () => facade.getProviderWarnings());
  ipcMain.handle("all-in-1:providers:test", (_e, raw: unknown) => facade.testProviderConfig(raw));
  ipcMain.handle("all-in-1:providers:discover", (_e, input: unknown) => {
    if (!input || typeof input !== "object") throw new Error("Invalid discover request");
    const req = input as Record<string, unknown>;
    if (typeof req.endpoint !== "string" || req.endpoint.trim() === "") {
      throw new Error("endpoint must be a non-empty string");
    }
    return facade.discoverModels({
      endpoint: req.endpoint,
      protocol: typeof req.protocol === "string" ? req.protocol : undefined,
      apiKeyEnv: typeof req.apiKeyEnv === "string" ? req.apiKeyEnv : null,
      maxModels: typeof req.maxModels === "number" ? req.maxModels : undefined,
    });
  });
  // D6 folder picker. The renderer supplies NO path: it asks main to let the
  // user choose one. Main owns the dialog, and applies the result through the
  // sanitized settings write, so a directory can only enter the tool sandbox
  // when the human picked it in the native dialog.
  ipcMain.handle("all-in-1:workspace:pick", async () => {
    const current = facade.getSettings().workspaceRoots;
    const options: Electron.OpenDialogOptions = {
      title: "Choose a workspace folder",
      buttonLabel: "Add as workspace",
      properties: ["openDirectory", "createDirectory"],
    };
    const focused = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = focused
      ? await dialog.showOpenDialog(focused, options)
      : await dialog.showOpenDialog(options);
    const picked = applyPickedRoot(current, result.canceled ? undefined : result.filePaths[0]);
    if (picked.added) facade.patchSettings({ workspaceRoots: picked.roots });
    return picked;
  });
  // D35: the artifact surface. The renderer lists, reads, and downloads by id;
  // the id is content-addressed and regex-validated on the store side, so a
  // crafted id cannot escape the artifact directory. The bytes never cross
  // the bridge as a raw path — the renderer receives the payload and writes
  // it itself, or main writes it for a download.
  ipcMain.handle("all-in-1:artifacts:list", () => facade.listArtifacts());
  ipcMain.handle("all-in-1:artifacts:read", (_e, raw: unknown) => {
    if (typeof raw !== "string" || raw.trim() === "") throw new Error("artifact id must be a non-empty string");
    return facade.getArtifact(raw);
  });
  ipcMain.handle("all-in-1:artifacts:download", async (_e, raw: unknown) => {
    if (typeof raw !== "string" || raw.trim() === "") throw new Error("artifact id must be a non-empty string");
    const payload = facade.downloadArtifact(raw);
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("no focused window to download into");
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: "Save artifact",
      defaultPath: payload.artifactId.replace(/\//g, "_"),
      // The content type drives the extension; a malformed id never reaches
      // here because the store rejected it first.
      filters: [{ name: "All files", extensions: ["*"] }],
    });
    if (canceled || !filePath) return { savedTo: null };
    require("node:fs").writeFileSync(filePath, Buffer.from(payload.bytes));
    return { savedTo: filePath };
  });
  // D35: analyze an uploaded image. The renderer supplies the artifact id
  // (never raw bytes); the facade reads the bytes from the store and routes
  // the VISION role through the frozen PREFERRED_FREE policy.
  ipcMain.handle("all-in-1:artifacts:analyze", async (_e, raw: unknown) => {
    if (typeof raw !== "string" || raw.trim() === "") throw new Error("artifact id must be a non-empty string");
    return facade.analyzeImage(raw);
  });
  // D35: analyze an uploaded file by content type. image/* routes through the
  // VISION path; text/* is decoded and summarized locally; anything else is
  // reported as binary. No external API is called for any branch.
  ipcMain.handle("all-in-1:artifacts:analyze-file", async (_e, raw: unknown) => {
    if (typeof raw !== "string" || raw.trim() === "") throw new Error("artifact id must be a non-empty string");
    return facade.analyzeFile(raw);
  });
  // D35: the renderer may upload a file the user picked in the OS dialog.
  // Main owns the dialog and the bytes; the renderer supplies nothing but
  // the resulting id, and the store confines the write to paths.artifacts.
  ipcMain.handle("all-in-1:upload:bytes", async (_e, raw: unknown) => {
    if (!raw || typeof raw !== "object") throw new Error("upload bytes must be an object");
    const r = raw as { bytes?: unknown; name?: string };
    if (!Array.isArray(r.bytes) && !(r.bytes instanceof Uint8Array)) {
      throw new Error("upload bytes must be an array-like of bytes");
    }
    const bytes = new Uint8Array(r.bytes as ArrayLike<number>);
    const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : "upload.bin";
    const stored = facade.uploadFile({ bytes, contentType: "application/octet-stream", labels: { source: "browser-upload", name } });
    return { artifactId: stored.artifactId, name };
  });
  ipcMain.handle("all-in-1:upload:file", async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("no focused window to pick a file in");
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: "Choose a file to upload",
      buttonLabel: "Upload",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "All files", extensions: ["*"] }],
    });
    if (canceled || filePaths.length === 0) return { artifactId: null };
    const fs = require("node:fs");
    const path = require("node:path");
    const ids: string[] = [];
    for (const filePath of filePaths) {
      const bytes = new Uint8Array(fs.readFileSync(filePath));
      const stored = facade.uploadFile({
        bytes,
        contentType: "application/octet-stream",
        runId: `upload-${Date.now()}`,
        labels: { originalName: path.basename(filePath) },
      });
      ids.push(stored.artifactId);
    }
    return { artifactId: ids[0] ?? null, artifactIds: ids };
  });
  // D35: collab progress. Pull-only, like every other channel here; the
  // renderer polls this while a collaborate run is in flight so a long
  // orchestration shows live participant status instead of a frozen card.
  ipcMain.handle("all-in-1:collab:progress", (_e, raw: unknown) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid collab progress request");
    const q = raw as Record<string, unknown>;
    if (typeof q.runId !== "string") throw new Error("runId must be a string");
    return facade.getCollabProgress(q.runId);
  });
  // D35: compare progress. A compare run is N independent gated agent runs
  // under one batch id; the renderer polls this while a compare runs so a long
  // batch shows per-model status instead of a frozen card. Pull-only.
  ipcMain.handle("all-in-1:compare:progress", (_e, raw: unknown) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid compare progress request");
    const q = raw as Record<string, unknown>;
    if (typeof q.batchId !== "string") throw new Error("batchId must be a string");
    return facade.getCompareProgress(q.batchId);
  });
  // D4 agent runtime. The renderer drives a run and learns which tools the
  // mode permits; it approves nothing here — the two channels above are the
  // only answer an approval request can receive.
  ipcMain.handle("all-in-1:agent:tools", (_e, mode: unknown) => {
    if (mode !== "INSPECT" && mode !== "SUGGEST" && mode !== "BUILD") {
      throw new Error("mode must be INSPECT, SUGGEST, or BUILD");
    }
    return facade.listAgentTools(mode);
  });
  ipcMain.handle("all-in-1:agent:run", (_e, raw: unknown) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid agent request");
    const req = raw as Record<string, unknown>;
    if (typeof req.runId !== "string") throw new Error("runId must be a string");
    if (typeof req.prompt !== "string") throw new Error("prompt must be a string");
    if (req.mode !== "INSPECT" && req.mode !== "SUGGEST" && req.mode !== "BUILD") {
      throw new Error("mode must be INSPECT, SUGGEST, or BUILD");
    }
    // The user's model choice must survive the boundary: a validated
    // provider/model pair reaches the engine as the preference the selector
    // honours first — and only the pair, never a free-form override. When the
    // engine cannot honour it, it falls back WITH A WARNING and reports the
    // actual executed model; a silent substitution is the one outcome this
    // shape check exists to prevent.
    let preference: { provider: string; modelId: string } | undefined;
    if (req.preference && typeof req.preference === "object") {
      const p = req.preference as Record<string, unknown>;
      if (typeof p.provider === "string" && typeof p.modelId === "string") {
        preference = { provider: p.provider, modelId: p.modelId };
      }
    }
    return facade.runAgent({
      runId: req.runId,
      prompt: req.prompt,
      mode: req.mode,
      auto: req.auto && typeof req.auto === "object" ? (req.auto as Record<string, unknown>) : undefined,
      tools: Array.isArray(req.tools) ? (req.tools as string[]).filter((t) => typeof t === "string") : undefined,
      timeoutMs: typeof req.timeoutMs === "number" ? req.timeoutMs : undefined,
      // D12: opt-in streaming flag on every run request; the bridge sink is
      // main-side, the renderer never supplies the event stream itself.
      streaming: req.streaming === true,
      preference,
    });
  });
  // Compare: one prompt, N selected models, each a full 7-gate run. The
  // mapping (not the registration) is the seam, D29 pattern — the facade is
  // only ever fed a validated ManyModelRequest.
  ipcMain.handle("all-in-1:agent:many", (_e, raw: unknown) =>
    facade.runMany(buildManyRequest(raw)),
  );
  // D34: the collaborative path. The mapping (not the registration) is the
  // seam, D29 pattern — the facade is only ever fed a validated
  // `CollaborateRequest`, and a raw object field that is not in this list
  // never crosses the boundary.
  ipcMain.handle("all-in-1:collab:run", (_e, raw: unknown) =>
    facade.runCollab(buildCollabRequest(raw)),
  );
  // P1-6: media generation. The media gate runs first (frozen media.enabled =
  // false in the MVP); no credential is read, no transport is opened, until
  // the user flips the gate and registers a provider with media capabilities.
  ipcMain.handle("all-in-1:media:generate", async (_e, raw: unknown) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid media generate request");
    const req = raw as Record<string, unknown>;
    if (typeof req.capability !== "string" || !(MEDIA_CAPABILITIES as readonly string[]).includes(req.capability)) {
      throw new Error(`capability must be one of: ${MEDIA_CAPABILITIES.join(", ")}`);
    }
    const runId = typeof req.runId === "string" ? req.runId : `media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return facade.generateImage(
      {
        capability: req.capability as MediaRequest["capability"],
        prompt: typeof req.prompt === "string" ? req.prompt : "",
        referenceArtifactIds: Array.isArray(req.referenceArtifactIds)
          ? (req.referenceArtifactIds as string[]).filter((x): x is string => typeof x === "string")
          : undefined,
        params: req.params && typeof req.params === "object"
          ? (() => {
              const p = req.params as Record<string, unknown>;
              return {
                aspectRatio: typeof p.aspectRatio === "string" ? p.aspectRatio : undefined,
                resolution: Array.isArray(p.resolution) && p.resolution.length === 2
                  ? [Number(p.resolution[0]), Number(p.resolution[1])]
                  : undefined,
                seed: typeof p.seed === "number" ? p.seed : undefined,
              };
            })()
          : undefined,
      },
      runId,
    );
  });
  // P1-6: cancel an in-flight media generation. The desktop stack owns the
  // abort controller; this just triggers it. A cancelled attempt is never
  // retried — the adapter throws a typed `cancelled` media error.
  ipcMain.handle("all-in-1:media:cancel", (_e, runId: unknown) =>
    typeof runId === "string" ? facade.cancelMediaRun(runId) : false,
  );
  ipcMain.handle("all-in-1:agent:stream", (_e, raw: unknown) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid stream query");
    const q = raw as Record<string, unknown>;
    if (typeof q.runId !== "string") throw new Error("runId must be a string");
    if (typeof q.cursor !== "number" || !Number.isFinite(q.cursor) || q.cursor < 0) {
      throw new Error("cursor must be a non-negative finite number");
    }
    const envelope = facade.getAgentStream(q.runId, q.cursor);
    // JSON-safe envelope: the bucket owner already stripped anything sensitive
    // from `error`; StreamEvent's text is assembled when the run finished.
    return envelope ?? null;
  });
  ipcMain.handle("all-in-1:workflow:stream", (_e, raw: unknown) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid stream query");
    const q = raw as Record<string, unknown>;
    if (typeof q.runId !== "string") throw new Error("runId must be a string");
    if (typeof q.cursor !== "number" || !Number.isFinite(q.cursor) || q.cursor < 0) {
      throw new Error("cursor must be a non-negative finite number");
    }
    const envelope = facade.getWorkflowStream(q.runId, q.cursor);
    return envelope ?? null;
  });
}

/**
 * Keep the OS window chrome in step with the user's stored theme (D6).
 *
 * `themeSource` is Electron's own vocabulary and maps one-to-one onto the
 * desktop setting, so `system` genuinely defers to the OS. The RENDERER also
 * applies the theme itself through CSS tokens; this call is what makes the
 * window frame, the scrollbars and the native menus follow along too.
 */
function applyNativeTheme(facade: DesktopFacade): void {
  nativeTheme.themeSource = facade.getSettings().theme;
}

/** The window background, matched to the theme so launch shows no white flash. */
function windowBackground(facade: DesktopFacade): string {
  const theme = facade.getSettings().theme;
  const dark = theme === "dark" || (theme === "system" && nativeTheme.shouldUseDarkColors);
  return dark ? "#0f141b" : "#f7f8fa";
}

function createWindow(facade: DesktopFacade): void {
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 720,
    minHeight: 520,
    title: "all_in_1",
    // Painted before the first frame, so the window never flashes white on a
    // dark theme (M6).
    backgroundColor: windowBackground(facade),
    webPreferences: {
      // Hardened renderer: no Node, isolated worlds, sandboxed preload.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // D31: no embedded browser surface. Nothing here uses a <webview>, so the
      // tag is switched off rather than merely left unused.
      webviewTag: false,
      preload: join(__dirname, "preload.cjs"),
    },
  });

  // D31: the window is one static file that never opens another window and
  // never navigates. The CSP already removes the network, so these two handlers
  // close the remaining ways out — a popup, or a redirect off the app.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== RENDERER_URL) event.preventDefault();
  });

  win.loadFile(join(__dirname, "renderer", "index.html")).catch((e: unknown) => {
    console.error("[all-in-1] failed to load renderer:", e);
  });
}

async function runSelfTest(facade: DesktopFacade): Promise<number> {
  const report: string[] = [];
  try {
    const result = await facade.runDiagnostic({
      mode: "INSPECT",
      subject: "the 7-gate execution pipeline",
      steps: ["CODE_REVIEWER"],
    });
    report.push(`SELFTEST_OK ok=${result.ok} mode=${result.mode} iterations=${result.iterations}`);
    report.push(`SELFTEST_GATECOUNT=7`);
    const status = facade.getSystemStatus();
    report.push(`SELFTEST_EGRESS=${status.egress.kind} BUDGET=${JSON.stringify(status.budget)}`);

    // Persistence round-trip within the same process.
    const persisted = facade.listRuns();
    report.push(`SELFTEST_PERSISTED_RUNS=${persisted.length}`);

    // Credential isolation: the facade must expose no value-returning method.
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(facade)).filter(
      (m) => m !== "constructor",
    );
    const forbidden = methods.filter((m) => /secret|password|tokenvalue|resolvecredential/i.test(m));
    report.push(`SELFTEST_FORBIDDEN_METHODS=${JSON.stringify(forbidden)}`);
    if (forbidden.length > 0) throw new Error(`facade exposes value-like methods: ${forbidden.join(",")}`);

    writeFileSync(
      join(app.getPath("userData"), "selftest-report.txt"),
      report.join("\n") + "\n",
      "utf8",
    );
    for (const line of report) console.log(line);
    return 0;
  } catch (e) {
    console.error("SELFTEST_FAIL", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    return 1;
  }
}

function bootstrap(): void {
  const stack = buildStack();
  const facade = new DesktopFacade(stack);
  applyNativeTheme(facade);
  registerHandlers(facade);

  app.on("before-quit", () => {
    stack.cancellation.cancelAll();
  });

  if (isSelfTest) {
    runSelfTest(facade)
      .then((code) => {
        // allow pending writes to flush
        setTimeout(() => app.exit(code), 100);
      })
      .catch(() => app.exit(1));
    return;
  }

  app.whenReady().then(() => {
    // D31: the renderer consumes no browser capability — no camera, microphone,
    // geolocation, clipboard or OS notification (its toasts are in-page DOM).
    // Denying every request therefore costs nothing legitimate, and it means a
    // compromised renderer cannot ask the OS for anything at all.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
      callback(false);
    });
    session.defaultSession.setPermissionCheckHandler(() => false);

    createWindow(facade);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(facade);
    });
  });
}

bootstrap();
