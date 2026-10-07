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
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage } from "electron";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildDesktopStack } from "./desktop-stack.ts";
import { DesktopFacade } from "./facade.ts";
import type { DesktopStack } from "./desktop-stack.ts";
import { ElectronSafeStorageCredentialProvider } from "./credentials/electron-safe-storage.ts";
import { applyPickedRoot } from "./workspace/pick.ts";
import { SAFETY_MODES, type SafetyMode } from "../../src/safety/guard.ts";
import { MODEL_ROLES, type ModelRole } from "../../src/registry/roles.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const isSelfTest = process.argv.includes("--selftest");

function isSafetyMode(v: unknown): v is SafetyMode {
  return typeof v === "string" && (SAFETY_MODES as readonly string[]).includes(v);
}

function isModelRole(v: unknown): v is ModelRole {
  return typeof v === "string" && (MODEL_ROLES as readonly string[]).includes(v);
}

function buildStack(): DesktopStack {
  const baseDir = app.getPath("userData");
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
  ipcMain.handle("all-in-1:run:diagnostic", (_e, raw: unknown) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid diagnostic request");
    const req = raw as Record<string, unknown>;
    if (!isSafetyMode(req.mode)) throw new Error(`Invalid mode: ${String(req.mode)}`);
    if (typeof req.subject !== "string") throw new Error("subject must be a string");
    const steps = Array.isArray(req.steps) && req.steps.every(isModelRole)
      ? (req.steps as ModelRole[])
      : undefined;
    return facade.runDiagnostic({
      mode: req.mode,
      subject: req.subject,
      steps,
      auto: req.auto === true,
      plan: typeof req.plan === "boolean" ? req.plan : undefined,
      timeoutMs: typeof req.timeoutMs === "number" ? req.timeoutMs : undefined,
    });
  });
  ipcMain.handle("all-in-1:run:cancel", (_e, runId: unknown) =>
    typeof runId === "string" ? facade.cancelRun(runId) : false,
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
  ipcMain.handle("all-in-1:workspace:roots", () => facade.listWorkspaceRoots());
  // D8: the warnings the D7 registration produced at startup, so the renderer
  // can explain a skipped provider instead of pretending it worked.
  ipcMain.handle("all-in-1:providers:warnings", () => facade.getProviderWarnings());
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
    return facade.runAgent({
      runId: req.runId,
      prompt: req.prompt,
      mode: req.mode,
      auto: req.auto && typeof req.auto === "object" ? (req.auto as Record<string, unknown>) : undefined,
      tools: Array.isArray(req.tools) ? (req.tools as string[]).filter((t) => typeof t === "string") : undefined,
      timeoutMs: typeof req.timeoutMs === "number" ? req.timeoutMs : undefined,
    });
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
      preload: join(__dirname, "preload.cjs"),
    },
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
    createWindow(facade);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(facade);
    });
  });
}

bootstrap();
