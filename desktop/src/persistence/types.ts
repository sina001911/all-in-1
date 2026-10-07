/**
 * Persistence contracts (D1).
 *
 * Every store is defined by an interface so the desktop layer depends on the
 * shape, not on a concrete writer. Two implementations exist:
 *
 *   - in-memory (test/offline path, no IO);
 *   - file-backed (atomic write-through, survives restart).
 *
 * The core engine's own stores (ApprovalStore, BudgetLedger) are NOT redefined
 * here. They are subclassed in `persistent-approval-store.ts` and
 * `persistent-budget-ledger.ts` so the engine keeps holding the exact types it
 * always held, and existing in-memory behaviour is untouched.
 */

/** A store that can flush its current state and be reloaded. */
export interface Persistable {
  /** Persist the current state atomically. */
  save(): void;
}

/** One recorded run of a workflow or specialist command. */
export interface RunRecord {
  readonly id: string;
  readonly mode: string;
  readonly subject: string;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly status: "running" | "completed" | "failed" | "cancelled";
  readonly ok: boolean;
  readonly errorCode?: string;
  readonly iterations: number;
  readonly pausedForHuman: boolean;
  readonly escalated: boolean;
  readonly deliverable?: string;
}

export interface RunStore extends Persistable {
  record(run: RunRecord): void;
  update(id: string, patch: Partial<RunRecord>): void;
  get(id: string): RunRecord | undefined;
  list(): readonly RunRecord[];
  clear(): void;
}

/** One accounted model invocation. Contains no secret material. */
export interface UsageRecord {
  readonly id: string;
  readonly runId: string | null;
  readonly ts: number;
  readonly modelId: string;
  readonly capability: string;
  readonly adapterId: string;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly outcome: "ok" | "failed" | "cancelled" | "timeout";
  readonly errorCode?: string;
}

export interface UsageStore extends Persistable {
  record(entry: UsageRecord): void;
  list(): readonly UsageRecord[];
  totals(): {
    readonly invocations: number;
    readonly totalCostUsd: number;
    readonly totalTokens: number;
  };
  clear(): void;
}

/**
 * Mutable desktop settings. Frozen fields (mainCoder, cost policy, media) are
 * deliberately absent: they are read-only and exposed separately via the
 * facade, so a settings write can never change a frozen default.
 *
 * Egress is NOT a frozen field — the shipped POLICY is deny-all, and that
 * stays the default for every fresh install, but the user may register a
 * provider. Its host is the only host the stack then opens, and only to speak
 * to that provider. This is the designed escape hatch that makes a real local
 * model server reachable without touching a frozen default.
 */
export interface DesktopSettings {
  readonly workspaceRoots: readonly string[];
  readonly theme: "system" | "light" | "dark";
  readonly defaultMode: "INSPECT" | "SUGGEST" | "BUILD";
  /**
   * Providers the user has registered (D7). Validated strictly at the settings
   * boundary: an `apiKeyEnv` is an environment-variable NAME only, never a key
   * value, and every field is bounds-checked before it reaches the engine.
   */
  readonly providers: readonly SettingsProvider[];
}

/** One model the user declared at a provider (D7). */
export interface SettingsProviderModel {
  readonly id: string;
  readonly displayName?: string;
  readonly capabilities?: readonly string[];
  readonly contextLimit?: number;
  readonly outputLimit?: number;
  readonly tools?: boolean;
  readonly costPer1MUsd?: { readonly input: number; readonly output: number };
}

/** A provider the user registered (D7). No key VALUE ever lives here. */
export interface SettingsProvider {
  readonly id: string;
  readonly displayName?: string;
  readonly endpoint: string;
  /** Environment-variable NAME of the key, or null for a keyless local server. */
  readonly apiKeyEnv?: string | null;
  readonly models: readonly SettingsProviderModel[];
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly enabled?: boolean;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  workspaceRoots: [],
  theme: "system",
  defaultMode: "INSPECT",
  providers: [],
};

export interface SettingsStore extends Persistable {
  get(): DesktopSettings;
  /** Patch the settings. Unknown keys are ignored; frozen keys are not present. */
  patch(patch: Partial<DesktopSettings>): DesktopSettings;
  reset(): void;
}

/** One redacted structured log line as persisted for the audit/operations view. */
export interface LogRecord {
  readonly ts: number;
  readonly level: string;
  readonly msg: string;
  readonly runId?: string;
  readonly fields?: Record<string, unknown>;
}

export interface LogStore extends Persistable {
  append(entry: LogRecord): void;
  list(since?: number): readonly LogRecord[];
  clear(): void;
}
