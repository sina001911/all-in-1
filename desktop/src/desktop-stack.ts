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
import { FROZEN_DEFAULTS } from "../../src/config/schema.ts";
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
} from "./persistence/types.ts";
import { resolveDataPaths, type DataPaths } from "./persistence/paths.ts";
import { LogStoreSink } from "./log-sink.ts";
import { CancellationHub } from "./cancellation.ts";
import type { CredentialProvider } from "./credentials/types.ts";

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

  const core = buildSpecialistStack({
    approvals,
    budget,
    logSink: new LogStoreSink(logStore),
  });

  return {
    core,
    paths,
    runStore,
    usageStore,
    settingsStore,
    logStore,
    credentials: opts.credentials,
    cancellation: new CancellationHub(),
    approvals,
    budget,
    frozenDefaults: FROZEN_DEFAULTS,
  };
}

/** Convenience accessor for the mutable settings (typed, frozen-free). */
export function desktopSettings(stack: DesktopStack): DesktopSettings {
  return stack.settingsStore.get();
}
