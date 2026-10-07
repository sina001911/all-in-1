/**
 * Desktop stack bootstrap (D1).
 *
 * Assembles the existing all_in_1 core (`buildSpecialistStack`, unchanged
 * behaviour) with the desktop's persistence and credential layers. The core is
 * the security spine; this module only supplies stores and a log sink.
 *
 * Frozen posture is preserved by construction:
 *   - policy is left at its default (FREE_ONLY);
 *   - budget is constructed at 0 (spendBudgetUsd frozen default);
 *   - no allowHosts are passed, so egress stays deny-all;
 *   - no remote provider adapter is registered, only the deterministic local
 *     adapter that `buildSpecialistStack` always registers.
 *
 * The Electron main process passes the OS data directory and the safeStorage
 * credential provider; tests and the headless self-test pass a temp directory
 * and a memory credential provider.
 */
import { buildSpecialistStack, type SpecialistStack } from "../../src/specialists/stack.ts";
import { SwappablePortal } from "../../src/execution/swappable-portal.ts";
import { FROZEN_DEFAULTS } from "../../src/config/schema.ts";
import { buildToolRuntime, type ToolRuntime } from "../../src/tools/index.ts";
import { buildAgentRuntime, type AgentRuntime } from "../../src/agent/index.ts";
import { ProviderModelGateway } from "../../src/agent/provider-gateway.ts";
import { PersistentApprovalStore } from "./persistence/persistent-approval-store.ts";
import { PersistentBudgetLedger } from "./persistence/persistent-budget-ledger.ts";
import { FileRunStore } from "./persistence/run-store.ts";
import { FileUsageStore } from "./persistence/usage-store.ts";
import { FileSettingsStore } from "./persistence/settings-store.ts";
import { FileLogStore } from "./persistence/log-store.ts";
import { JsonFileStore, JsonlAppendStore } from "./persistence/json-store.ts";
import type {
  RunStore,
  UsageStore,
  SettingsStore,
  LogStore,
  DesktopSettings,
  SettingsProvider,
} from "./persistence/types.ts";
import { resolveDataPaths, type DataPaths } from "./persistence/paths.ts";
import { LogStoreSink } from "./log-sink.ts";
import { CancellationHub } from "./cancellation.ts";
import { AgentStreamBridge } from "./stream-bridge.ts";
import type { CredentialProvider } from "./credentials/types.ts";
import { InteractiveToolApprover } from "./tools/approver.ts";
import { FileToolAuditStore } from "./tools/audit-store.ts";
import { DesktopWorkspaceRoots } from "./tools/workspace-roots.ts";

export interface DesktopStack {
  readonly core: SpecialistStack;
  readonly paths: DataPaths;
  readonly runStore: RunStore;
  readonly usageStore: UsageStore;
  readonly settingsStore: SettingsStore;
  readonly logStore: LogStore;
  readonly credentials: CredentialProvider;
  readonly cancellation: CancellationHub;
  readonly approvals: PersistentApprovalStore;
  readonly budget: PersistentBudgetLedger;
  readonly tools: ToolRuntime;
  readonly toolApprover: InteractiveToolApprover;
  readonly workspaceRoots: DesktopWorkspaceRoots;
  readonly agent: AgentRuntime;
  readonly agentGateway: ProviderModelGateway;
  /** Progressive-stream bridge (D12): pull-only preview events, in memory only. */
  readonly streamBridge: AgentStreamBridge;
  /** Workflow bridge (D16): separate from AgentStreamBridge to avoid runId bleed. */
  readonly workflowStreamBridge: AgentStreamBridge;
  /** Warnings from user-provider registration (D7), shown in the UI. Live: reflects the current stack after a reload. */
  readonly providerWarnings: readonly string[];
  /**
   * Rebuild the provider-dependent core (catalogue, adapters, egress, engine,
   * runner) from current settings and atomically swap it in (D10). The old
   * stack keeps serving in-flight invocations; new invocations use the new
   * one. Persistent stores, the tool runtime, and the agent runtime are
   * untouched. If the rebuild throws, the previous stack stays in place.
   */
  reloadProviders(): readonly string[];
  readonly frozenDefaults: typeof FROZEN_DEFAULTS;
}

export interface DesktopStackOptions {
  /** OS data directory (Electron `app.getPath("userData")` or a temp dir). */
  readonly baseDir: string;
  readonly credentials: CredentialProvider;
  /** Override stores for tests; when omitted, file-backed stores are created. */
  readonly overrides?: {
    readonly runStore?: RunStore;
    readonly usageStore?: UsageStore;
    readonly settingsStore?: SettingsStore;
    readonly logStore?: LogStore;
  };
}

export function buildDesktopStack(opts: DesktopStackOptions): DesktopStack {
  const paths = resolveDataPaths(opts.baseDir);
  const logStore = opts.overrides?.logStore ?? new FileLogStore(new JsonlAppendStore(paths.root, "logs.jsonl"));
  const runStore = opts.overrides?.runStore ?? new FileRunStore(new JsonFileStore(paths.root, "runs.json"));
  const usageStore = opts.overrides?.usageStore ?? new FileUsageStore(new JsonFileStore(paths.root, "usage.json"));
  const settingsStore =
    opts.overrides?.settingsStore ?? new FileSettingsStore(new JsonFileStore(paths.root, "settings.json"));

  // Persistent core stores, hydrated from disk then injected into the core.
  const approvals = new PersistentApprovalStore(
    undefined,
    new JsonFileStore(paths.root, "approvals.json"),
  );
  const budget = new PersistentBudgetLedger(
    /* budgetUsd */ 0, // frozen default: spendBudgetUsd = 0
    undefined,
    new JsonFileStore(paths.root, "budget.json"),
  );

  // D7: the user's registered providers are read from settings BEFORE the core
  // stack is built, so the catalogue, adapters, and egress policy the engine
  // holds are the ones the user configured.
  const settings = settingsStore.get();

  const buildCore = (): SpecialistStack =>
    buildSpecialistStack({
      approvals,
      budget,
      logSink: new LogStoreSink(logStore),
      // The desktop runs an agent loop, which needs a tool-capable model. This
      // opts in the deterministic local agent model ONLY as the built-in; a user
      // may additionally register providers below. The frozen posture is
      // unchanged for a fresh install: no providers, deny-all egress, budget 0.
      agentModel: true,
      // D7/D10: register the user's providers and open egress to exactly the
      // hosts they registered a provider against — nothing more. Loopback is
      // permitted by the default policy already, so a local model server needs
      // no entry.
      providers: settingsStore.get().providers,
      allowHosts: hostsForProviders(settingsStore.get().providers),
    });

  let current = buildCore();
  // D10: the gateway, the runner path, and every facade read go through live
  // references, so a rebuilt core is seen without re-binding constructors.
  const portal = new SwappablePortal(current.stack.engine);

  // D2: the privileged tool runtime. Its workspace roots are the directories
  // the user has opened, and its data directory is denied to every tool — a
  // tool can never read the credential store or rewrite its own audit trail.
  // The approver is interactive: privileged tools wait for the human.
  const workspaceRoots = new DesktopWorkspaceRoots(settingsStore, paths.root);
  const toolApprover = new InteractiveToolApprover();
  const tools = buildToolRuntime({
    workspace: workspaceRoots.manager(),
    approver: toolApprover,
    audit: new FileToolAuditStore(new JsonlAppendStore(paths.root, "tool-audit.jsonl")),
  });

  // D4: the agent runtime. The gateway routes every turn through the execution
  // engine, hence through the frozen gates; the agent holds the tool runtime,
  // never the approver, so a tool request from the model can only be settled
  // by the human behind `toolApprover`. D10: the gateway sees the swappable
  // portal, so a rebuilt provider stack takes effect for the agent too.
  const agentGateway = new ProviderModelGateway({ engine: portal });
  const agent = buildAgentRuntime({ tools, gateway: agentGateway });

  const stack: DesktopStack = {
    get core() {
      return current;
    },
    paths,
    runStore,
    usageStore,
    settingsStore,
    logStore,
    credentials: opts.credentials,
    cancellation: new CancellationHub(),
    approvals,
    budget,
    tools,
    toolApprover,
    workspaceRoots,
    agent,
    agentGateway,
    streamBridge: new AgentStreamBridge(),
    workflowStreamBridge: new AgentStreamBridge(),
    // D7: the warnings from user-provider registration, surfaced in the UI so a
    // bad entry is explained rather than silently ignored. Live after reload.
    get providerWarnings() {
      return current.stack.registrationWarnings;
    },
    reloadProviders() {
      // Build first: if the rebuild throws, nothing below runs and the old
      // stack keeps serving both in-flight and new invocations.
      const next = buildCore();
      portal.swap(next.stack.engine);
      current = next;
      return next.stack.registrationWarnings;
    },
    frozenDefaults: FROZEN_DEFAULTS,
  };
  return stack;
}

/**
 * The hosts egress is opened for: exactly the hosts of the providers the user
 * registered. A loopback provider contributes nothing (loopback is already
 * allowed), and an unparseable endpoint contributes nothing — its provider is
 * skipped at registration with a warning anyway.
 */
function hostsForProviders(providers: readonly SettingsProvider[]): readonly string[] {
  const hosts: string[] = [];
  for (const provider of providers) {
    try {
      const host = new URL(provider.endpoint).hostname.toLowerCase();
      if (host && !hosts.includes(host) && !isLoopbackHost(host)) hosts.push(host);
    } catch {
      /* unparseable: registration reports it */
    }
  }
  return hosts;
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/** Convenience accessor for the mutable settings (typed, frozen-free). */
export function desktopSettings(stack: DesktopStack): DesktopSettings {
  return stack.settingsStore.get();
}
