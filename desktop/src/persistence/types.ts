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
import type { ModelRole } from "../../../src/registry/roles.ts";

/** A store that can flush its current state and be reloaded. */
export interface Persistable {
  /** Persist the current state atomically. */
  save(): void;
}

/** One recorded run of a workflow or specialist command. */
export interface RunRecord {
  readonly id: string;
  /**
   * Which runtime produced this run (D27). Absent on records written before
   * D27, which are workflow runs. D34 adds `collab`: a multi-model
   * collaboration whose participants are each a gated specialist run.
   */
  readonly kind?: "workflow" | "agent" | "collab";
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
  /**
   * The step roles the run executes, in order (D26). Part of the run's identity:
   * a resumed run derives the steps it still has to run from this sequence, so a
   * caller re-invoking an unfinished run cannot silently change its order. Absent
   * on records written before D26; such runs fall back to the caller's steps.
   */
  readonly steps?: readonly ModelRole[];
  /**
   * D35: the provider/model composite the run was asked to use (e.g.
   * `local/agent`). Absent on runs that did not target a specific model, such
   * as workflow runs. Carried on the record so a progress poll can label each
   * slot of a comparison by the model it asked for, without the renderer
   * re-issuing the request.
   */
  readonly model?: string;
  /**
   * D35: an optional display name the user gave the run. Absent when the run
   * has never been renamed; the `subject` remains the source of truth for the
   * pipeline, so a rename is cosmetic and never changes what the run does.
   */
  readonly name?: string;
  /**
   * D35: the participants of a collaboration, in declaration order. Carried on
   * the record so a progress poll can map live stream frames back to the
   * provider/model each card should show, without the renderer re-issuing the
   * whole request. Absent on every other kind of run.
   */
  readonly participants?: ReadonlyArray<{
    readonly id: string;
    readonly provider: string;
    readonly modelId: string;
  }>;
}

export interface RunStore extends Persistable {
  record(run: RunRecord): void;
  update(id: string, patch: Partial<RunRecord>): void;
  get(id: string): RunRecord | undefined;
  list(): readonly RunRecord[];
  /**
   * D35: rename a run. The `name` is cosmetic — the pipeline keys off `id` and
   * `subject`, so a rename never changes what a re-run does. Returns false when
   * the run does not exist.
   */
  rename(id: string, name: string): boolean;
  /**
   * D35: delete a run record. Returns false when the run does not exist.
   * Deleting a record does not delete its artifacts; the artifact store sweeps
   * on its own retention schedule.
   */
  remove(id: string): boolean;
  /**
   * D35: search runs by subject or display name. Case-insensitive substring
   * match; an empty query returns every run, newest first, like `list`.
   */
  search(query: string): readonly RunRecord[];
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
  /**
   * User-configured spend budget in USD. The frozen default is 0 (no spend),
   * which is what a fresh install ships with; the user may raise it from the
   * Settings UI to permit paid models. Raising it is an explicit human act —
   * nothing here raises a cost ceiling without the user typing a number.
   */
  readonly budgetUsd: number;
  /**
   * D35: artifact retention knobs. The frozen default keeps every artifact for
   * 90 days and the 64 most recent per kind; the user may tighten either from
   * the Settings UI. A missing value falls back to the default, so records
   * written before this field existed keep working.
   */
  readonly artifactRetentionDays?: number;
  readonly artifactKeepRuns?: number;
  /**
   * D35: the human's explicit opt-in for media generation. The frozen default
   * is `false` — a fresh install ships with media disabled and zero budget,
   * so no media call can occur until the user flips this switch AND registers a
   * provider with media capabilities AND (for paid models) raises the budget.
   * This is a user setting, not a frozen default: it is the legitimate escape
   * hatch, the same way `budgetUsd` is.
   */
  readonly mediaEnabled?: boolean;
}

/** One model the user declared at a provider (D7). */
export interface SettingsProviderModel {
  readonly id: string;
  readonly displayName?: string;
  readonly capabilities?: readonly string[];
  /**
   * D35: media capabilities this model may serve (TEXT_TO_IMAGE, IMAGE_TO_IMAGE,
   * …). Absent when the model is text-only; the media router uses this to
   * match a request to a model that actually supports the requested
   * capability. The selector shows these so the human can see WHY a model is
   * or is not offered for a media role.
   */
  readonly mediaCapabilities?: readonly string[];
  readonly contextLimit?: number;
  readonly outputLimit?: number;
  readonly tools?: boolean;
  /**
   * D35: declared per-generation cost in USD for a media model. Carried through
   * to the router so it can reserve budget before the call. Absent means the
   * cost is UNKNOWN and the router reserves zero and marks the result.
   */
  readonly costEstimateUsd?: number;
  readonly costPer1MUsd?: { readonly input: number; readonly output: number };
  /** Whether the model declares a real streaming response (D11). */
  readonly streaming?: boolean;
}

/** A provider the user registered (D7). No key VALUE ever lives here. */
export interface SettingsProvider {
  readonly id: string;
  readonly displayName?: string;
  readonly endpoint: string;
  /**
   * Wire protocol. Defaults to `openai-compatible`; set to `anthropic` for an
   * Anthropic Messages-compatible gateway such as the FCC local gateway.
   */
  readonly protocol?: string;
  /** Environment-variable NAME of the key, or null for a keyless local server. */
  readonly apiKeyEnv?: string | null;
  /**
   * D35: the image-generation path mounted under `endpoint`. The default is
   * `/images/generations` (OpenAI compatible); OpenRouter mounts image
   * generation at `/images`, so a user configuring OpenRouter sets this.
   */
  readonly imagePath?: string;
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
  budgetUsd: 0,
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
