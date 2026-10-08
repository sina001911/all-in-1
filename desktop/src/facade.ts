/**
 * DesktopFacade (D1) — the ONLY surface the renderer may call.
 *
 * Security rules this boundary enforces by construction:
 *
 *   - It exposes no Node, filesystem, or process capability. There is no
 *     method that takes an arbitrary path or command.
 *   - It never returns a credential VALUE. Credential methods are limited to
 *     name/presence/set/delete; `setCredential` returns void and never echoes
 *     its input.
 *   - It returns only data the core already deemed safe: redacted logs,
 *     accounting counters, run records, and the frozen defaults (read-only).
 *   - Every run goes through the core's engine, hence through every gate.
 *
 * The facade is deliberately Electron-free: it depends on the stack, not on the
 * host, so it is fully exercisable under plain Node/vitest.
 */
import { WorkflowLoop } from "../../src/workflow/index.ts";
import type { WorkflowResult } from "../../src/workflow/index.ts";
import type { ModelRole } from "../../src/registry/roles.ts";
import type { SafetyMode } from "../../src/safety/guard.ts";
import type { ApprovalRecord } from "../../src/registry/approvals.ts";
import type { BudgetSnapshot } from "../../src/registry/budget.ts";
import type { DesktopStack } from "./desktop-stack.ts";
import type {
  DesktopSettings,
  LogRecord,
  RunRecord,
  UsageRecord,
  SettingsProvider,
} from "./persistence/types.ts";
import type { ToolRequest, ToolResult } from "../../src/tools/types.ts";
import type { ToolAuditRecord } from "../../src/tools/audit.ts";
import type { ApprovalRecord as ToolApprovalEntry } from "./tools/approver.ts";
import type { AgentRequest, AgentResult } from "../../src/agent/index.ts";
import { toolsVisibleInMode } from "../../src/agent/index.ts";
import { sanitizeProvider } from "./persistence/settings-store.ts";
import { resolveBearerToken } from "../../src/execution/secrets.ts";

export interface DiagnosticRequest {
  readonly mode: SafetyMode;
  readonly subject: string;
  /** Step roles; defaults are per-mode when omitted. */
  readonly steps?: readonly ModelRole[];
  /** Explicit autonomous opt-in. Never defaulted by the facade. */
  readonly auto?: boolean;
  /** Produce a plan summary (requires plan permission). */
  readonly plan?: boolean;
  /** Optional caller-supplied run id; generated when absent. */
  readonly runId?: string;
  /** Per-step invocation timeout forwarded to the engine. */
  readonly timeoutMs?: number;
  /** Request progressive streaming frames from the engine path. */
  readonly streaming?: boolean;
}

export interface DiagnosticResult {
  readonly runId: string;
  readonly ok: boolean;
  readonly mode: SafetyMode;
  readonly text: string;
  readonly iterations: number;
  readonly pausedForHuman: boolean;
  readonly escalated: boolean;
  readonly errorCode?: string;
}

const DEFAULT_STEPS: Readonly<Record<SafetyMode, readonly ModelRole[]>> = {
  INSPECT: ["CODE_REVIEWER"],
  SUGGEST: ["DEEP_REASONING"],
  BUILD: ["CODE_REVIEWER"],
};

function defaultPlanFor(mode: SafetyMode): boolean {
  return mode !== "INSPECT";
}

function modePermissions(mode: SafetyMode): string {
  if (mode === "INSPECT") return "analyze only, no edits";
  if (mode === "SUGGEST") return "analyze + plan, no edits";
  return "analyze + plan; no edit tools are wired in yet (D1)";
}

export class DesktopFacade {
  private readonly stack: DesktopStack;

  constructor(stack: DesktopStack) {
    this.stack = stack;
  }

  // ---- read-only policy / status -------------------------------------

  /** The frozen defaults, as a plain JSON-safe object for the renderer. */
  getFrozenDefaults(): Record<string, unknown> {
    return JSON.parse(JSON.stringify(this.stack.frozenDefaults)) as Record<string, unknown>;
  }

  getSystemStatus(): {
    readonly egress: { readonly kind: string; readonly allowlist: readonly string[] };
    readonly budget: BudgetSnapshot;
    readonly approvals: number;
    readonly runs: number;
    readonly credentials: readonly string[];
  } {
    return {
      egress: { kind: this.stack.core.stack.egress.kind, allowlist: this.stack.core.stack.egress.allowlist },
      budget: this.stack.budget.snapshot(),
      approvals: this.stack.approvals.list().length,
      runs: this.stack.runStore.list().length,
      credentials: this.stack.credentials.listNames(),
    };
  }

  getBudget(): BudgetSnapshot {
    return this.stack.budget.snapshot();
  }

  // ---- runs ----------------------------------------------------------

  listRuns(): readonly RunRecord[] {
    return this.stack.runStore.list();
  }

  getRun(id: string): RunRecord | undefined {
    return this.stack.runStore.get(id);
  }

  /**
   * Run a diagnostic workflow through the full core pipeline (all seven gates).
   * This is the standalone equivalent of the plugin command path, with no
   * dependency on any host.
   */
  async runDiagnostic(req: DiagnosticRequest): Promise<DiagnosticResult> {
    // Keep the runId stable when the caller provides one; otherwise generate it
    // exactly once so cancellation, persistence and streaming all see the same id.
    const runId = typeof req.runId === "string" && req.runId.trim().length > 0
      ? req.runId.trim()
      : `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const streaming = req.streaming === true;
    const signal = this.stack.cancellation.signalFor(runId);
    const startedAt = Date.now();
    if (streaming) {
      this.stack.workflowStreamBridge.start(runId);
    }

    this.stack.runStore.record({
      id: runId,
      mode: req.mode,
      subject: req.subject,
      startedAt,
      status: "running",
      ok: false,
      iterations: 0,
      pausedForHuman: false,
      escalated: false,
    });

    const roles = req.steps ?? DEFAULT_STEPS[req.mode];
    const wantPlan = req.plan ?? defaultPlanFor(req.mode);
    const subject = req.subject;

    const loop = new WorkflowLoop({
      runner: this.stack.core.runner,
      request: {
        mode: req.mode,
        auto: req.auto ? { auto: true } : undefined,
        plan: wantPlan,
        signal,
        timeoutMs: req.timeoutMs,
        steps: roles.map((role) => ({
          role,
          prompt: subject,
          inputs: subject ? [{ kind: "text", text: subject }] : [],
          outputSchema: {},
        })),
        // D16: optional progressive events for the diagnostic stream bridge.
        streaming: streaming || undefined,
        onStreamEvent: streaming
          ? (e) => this.stack.workflowStreamBridge.append(runId, e)
          : undefined,
      },
    });

    let result: WorkflowResult;
    try {
      result = await loop.run();
      if (streaming) {
        if (result.ok) this.stack.workflowStreamBridge.done(runId);
        else this.stack.workflowStreamBridge.failed(runId, {
          code: result.error?.code ?? "WORKFLOW_FAILED",
          message: result.ok ? "diagnostic stream completed" : "diagnostic stream failed",
        });
      }
    } catch (e) {
      this.stack.runStore.update(runId, {
        finishedAt: Date.now(),
        status: "failed",
        ok: false,
        errorCode: "WORKFLOW_FAILED",
      });
      if (streaming) {
        this.stack.workflowStreamBridge.failed(runId, {
          code: "WORKFLOW_FAILED",
          message: "diagnostic stream failed",
        });
      }
      this.stack.cancellation.release(runId);
      return {
        runId,
        ok: false,
        mode: req.mode,
        text: `[all-in-1 ${req.mode}] failed unexpectedly: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
        iterations: 0,
        pausedForHuman: false,
        escalated: false,
        errorCode: "WORKFLOW_FAILED",
      };
    }

    const cancelled = signal.aborted;
    const status: RunRecord["status"] = cancelled ? "cancelled" : result.ok ? "completed" : "failed";
    const text = this.composeDeliverable(req, result, cancelled);

    this.stack.runStore.update(runId, {
      finishedAt: Date.now(),
      status,
      ok: result.ok && !cancelled,
      errorCode: cancelled ? "WORKFLOW_CANCELLED" : result.error?.code,
      iterations: result.iterations,
      pausedForHuman: result.pausedForHuman,
      escalated: result.escalated,
      deliverable: text,
    });

    // D1 accounts at run granularity with values that are actually observable.
    // Per-invocation token accounting arrives with real providers (D4); the
    // deterministic local adapter is genuinely zero-cost, so costUsd is 0 by
    // construction here — never an invented number.
    const usage: UsageRecord = {
      id: `usage-${runId}`,
      runId,
      ts: Date.now(),
      modelId: "local/deterministic",
      capability: roles.join(","),
      adapterId: "local",
      costUsd: 0,
      latencyMs: Date.now() - startedAt,
      outcome: cancelled ? "cancelled" : result.ok ? "ok" : "failed",
      errorCode: cancelled ? "WORKFLOW_CANCELLED" : result.error?.code,
    };
    this.stack.usageStore.record(usage);
    this.stack.usageStore.save();
    this.stack.runStore.save();

    this.stack.cancellation.release(runId);

    return {
      runId,
      ok: result.ok && !cancelled,
      mode: req.mode,
      text,
      iterations: result.iterations,
      pausedForHuman: result.pausedForHuman,
      escalated: result.escalated,
      errorCode: cancelled ? "WORKFLOW_CANCELLED" : result.error?.code,
    };
  }

  private composeDeliverable(req: DiagnosticRequest, result: WorkflowResult, cancelled: boolean): string {
    const body: string[] = [];
    for (const step of result.results) {
      const summary = summarize(step.response);
      body.push(`- [${step.role}] ${summary}`);
    }
    const lines = [
      `[all-in-1 ${req.mode}] subject: ${req.subject.length > 0 ? `"${req.subject}"` : "(no subject given)"}`,
      `mode: ${req.mode} — ${modePermissions(req.mode)}`,
      "engine: deterministic local (FREE · offline · egress deny-all · budget 0)",
      req.auto ? "auto: explicit opt-in, bounded (maxIterations 5)" : "auto: off (human-in-the-loop)",
      "",
      ...(body.length > 0 ? body : ["(no step produced output)"]),
    ];
    if (wantPlanOf(req, result) && result.plan) {
      lines.push("", "plan:", ...result.plan.map((p) => `  ${p}`));
    }
    if (cancelled) {
      lines.push("", "cancelled by the user; any budget reservation was released.");
    } else if (result.pausedForHuman) {
      lines.push("", "paused for human: run again to continue to the next step.");
    }
    if (result.error) {
      lines.push("", `error: ${result.error.code} — ${result.error.message}`);
    }
    return lines.join("\n");
  }

  /** Abort a running diagnostic. Returns false when the run is not live. */
  cancelRun(runId: string): boolean {
    return this.stack.cancellation.cancel(runId);
  }

  // ---- approvals ------------------------------------------------------

  listApprovals(): readonly ApprovalRecord[] {
    return this.stack.approvals.list();
  }

  /**
   * Record an explicit human approval. This is one of the three explicit human
   * acts; it is never granted by the engine or by the facade itself.
   */
  grantApproval(record: ApprovalRecord): void {
    this.stack.approvals.grant(record);
  }

  revokeApproval(modelId: string): void {
    this.stack.approvals.revoke(modelId);
  }

  // ---- usage / logs ---------------------------------------------------

  listUsage(): readonly UsageRecord[] {
    return this.stack.usageStore.list();
  }

  getUsageTotals(): { readonly invocations: number; readonly totalCostUsd: number; readonly totalTokens: number } {
    return this.stack.usageStore.totals();
  }

  /** Redacted, persisted audit trail. */
  listLogs(since?: number): readonly LogRecord[] {
    return this.stack.logStore.list(since);
  }

  // ---- settings -------------------------------------------------------

  getSettings(): DesktopSettings {
    return this.stack.settingsStore.get();
  }

  /** Warnings from D7 user-provider registration at startup. */
  getProviderWarnings(): readonly string[] {
    return this.stack.providerWarnings;
  }

  /**
   * D21: validate a raw provider declaration before it reaches persistence.
   * Shape checks happen with the same strict sanitizer, and endpoint/model
   * availability is probed without generating any chat completion: the probe
   * is a cheap GET <endpoint>/models that never ships a business request.
   */
  async testProviderConfig(raw: unknown): Promise<{
    ok: boolean;
    detail: string;
    code?: string;
    endpoint: string;
    models: Array<{ id: string; streaming?: boolean; declared: boolean; discovered: boolean }>;
  }> {
    const provider = sanitizeProvider(raw);
    if (!provider) {
      return {
        ok: false,
        code: "PROVIDER_INVALID",
        detail: "Provider config was rejected by sanitizeProvider(raw): endpoint/id/models/key env rules not satisfied",
        endpoint: String((raw as { endpoint?: unknown } | null)?.endpoint ?? ""),
        models: [],
      };
    }

    let canResolve = true;
    let detail = "";
    let code: string | undefined;
    if (provider.apiKeyEnv) {
      try {
        void resolveBearerToken(provider.apiKeyEnv);
      } catch {
        canResolve = false;
        code = "CREDENTIAL_UNAVAILABLE";
        detail = `Env var ${provider.apiKeyEnv} is not set; endpoint model check skipped for cost safety`;
      }
    }

    const base = provider.endpoint.replace(/\/+$/, "");
    const probed: Array<{ id: string; streaming?: boolean; declared: boolean; discovered: boolean }> = [];
    for (const m of provider.models) {
      probed.push({ id: m.id, streaming: m.streaming, declared: true, discovered: false });
    }
    if (!canResolve) {
      return { ok: false, code, detail, endpoint: provider.endpoint, models: probed };
    }

    let rawBody = "";
    let status = 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (provider.apiKeyEnv) {
        const token = resolveBearerToken(provider.apiKeyEnv);
        headers.Authorization = `Bearer ${token}`;
      }
      const response = await fetch(`${base}/models`, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      status = response.status;
      rawBody = await response.text();
      if (status < 200 || status >= 300) {
        return {
          ok: false,
          code: "PROVIDER_UNREACHABLE",
          detail: `Endpoint rejected model listing with HTTP ${status}`,
          endpoint: provider.endpoint,
          models: probed,
        };
      }
    } catch (e) {
      return {
        ok: false,
        code: "PROVIDER_UNREACHABLE",
        detail: `Endpoint unreachable during model probe: ${e instanceof Error ? e.message : String(e)}`,
        endpoint: provider.endpoint,
        models: probed,
      };
    } finally {
      clearTimeout(timer);
    }

    let dataArray: unknown[] = [];
    try {
      const parsed = JSON.parse(rawBody) as { data?: unknown };
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.data)) {
        return {
          ok: false,
          code: "PROVIDER_CALL_FAILED",
          detail: "Endpoint returned JSON, but it is not a valid models list",
          endpoint: provider.endpoint,
          models: probed,
        };
      }
      dataArray = parsed.data;
    } catch {
      return {
        ok: false,
        code: "PROVIDER_CALL_FAILED",
        detail: "Endpoint returned non-JSON during model probe",
        endpoint: provider.endpoint,
        models: probed,
      };
    }

    const listed = new Set(
      dataArray
        .map((item: any) => (item && typeof item.id === "string" ? item.id : ""))
        .filter((id: string) => id.length > 0),
    );
    const finalModels = probed.map((m) => ({ ...m, discovered: listed.has(m.id) }));
    const allDiscovered = finalModels.every((m) => m.discovered);
    return {
      ok: allDiscovered,
      code: allDiscovered ? undefined : "MODEL_NOT_FOUND",
      detail: allDiscovered
        ? `Provider endpoint is reachable and all ${finalModels.length} declared model(s) were found.`
        : `Provider endpoint is reachable, but ${finalModels.filter((m) => !m.discovered).length} declared model(s) were not in the models list.`,
      endpoint: provider.endpoint,
      models: finalModels,
    };
  }

  patchSettings(patch: Partial<DesktopSettings>): DesktopSettings {
    const before = this.stack.settingsStore.get();
    const saved = this.stack.settingsStore.patch(patch);
    // D10: a change to the provider list takes effect immediately — this
    // rebuilds only the provider-dependent core and swaps it in atomically.
    // In-flight invocations keep their original engine; new ones see the new
    // catalogue, egress, and adapters. If the rebuild fails, the error
    // propagates and the previous core stays.
    if ("providers" in patch && JSON.stringify(before.providers) !== JSON.stringify(saved.providers)) {
      this.stack.reloadProviders();
    }
    return saved;
  }

  // ---- credentials ----------------------------------------------------
  // VALUE-returning methods are intentionally absent.

  listCredentialNames(): readonly string[] {
    return this.stack.credentials.listNames();
  }

  hasCredential(name: string): boolean {
    return this.stack.credentials.has(name);
  }

  /**
   * Store a credential. Returns nothing and never echoes the value. The value
   * flows renderer -> IPC -> main -> OS secure storage; it is not retained in
   * facade state, not logged, and not placed in any error.
   */
  setCredential(_name: string, _value: string): void {
    // Length is validated by the caller; a name check belongs here.
    if (!_name || _name.trim().length === 0) {
      throw new Error("Credential name must not be empty");
    }
    this.stack.credentials.set(_name, _value.trim());
  }

  deleteCredential(name: string): void {
    this.stack.credentials.delete(name);
  }

  // ---- tool runtime (D2) --------------------------------------------
  //
  // The privileged layer. Every call goes through the executor, hence through
  // validation, the permission policy, the workspace boundary, and (for a
  // privileged class) the human approval. The facade exposes no way to bypass
  // any of them: there is no "approve my own request" method here.

  /** The tools the runtime offers, with the privilege class each carries. */
  listTools(): ReadonlyArray<{ name: string; description: string; permission: string; requiresApproval: boolean }> {
    return this.stack.tools.registry.list().map((t) => ({
      name: t.schema.name,
      description: t.schema.description,
      permission: t.schema.permission,
      requiresApproval: this.stack.tools.policy.requiresApproval(t.schema),
    }));
  }

  /** Invoke a tool. Returns a settled result; never throws. */
  async invokeTool(req: ToolRequest): Promise<ToolResult> {
    return this.stack.tools.executor.execute(req);
  }

  /** The privileged requests waiting for a human decision. */
  listPendingToolApprovals(): readonly ToolApprovalEntry[] {
    return this.stack.toolApprover.listPending();
  }

  /** Every tool approval request, answered or not, newest last. */
  listToolApprovals(): readonly ToolApprovalEntry[] {
    return this.stack.toolApprover.listAll();
  }

  /** The human approves a pending request. Returns false when it is unknown. */
  approveTool(id: string, note?: string): boolean {
    return this.stack.toolApprover.approve(id, note);
  }

  /** The human denies a pending request. Returns false when it is unknown. */
  denyTool(id: string, reason?: string): boolean {
    return this.stack.toolApprover.deny(id, reason);
  }

  /** The persisted audit trail of every tool invocation. */
  listToolAudit(since?: number): readonly ToolAuditRecord[] {
    return this.stack.tools.audit.list(since);
  }

  /** The workspace roots the tools are confined to. */
  listWorkspaceRoots(): readonly string[] {
    return this.stack.workspaceRoots.roots();
  }

  /** Deny every pending request; used when a run is abandoned or on shutdown. */
  abandonPendingApprovals(reason: string): void {
    this.stack.toolApprover.denyAll(reason);
  }

  // ---- agent runtime (D4) -------------------------------------------
  //
  // The loop that connects the model to the tools. The facade exposes the run
  // and the tools the current mode permits; it exposes nothing that could
  // approve a tool request — that remains the two approval channels above.

  /** The tools the model may call in this mode, with their privilege class. */
  listAgentTools(mode: SafetyMode): ReadonlyArray<{ name: string; description: string; permission: string; requiresApproval: boolean }> {
    return toolsVisibleInMode(this.stack.tools.registry, this.stack.tools.policy, mode).map((schema) => ({
      name: schema.name,
      description: schema.description,
      permission: schema.permission,
      requiresApproval: this.stack.tools.policy.requiresApproval(schema),
    }));
  }

  /**
   * Run the agent as far as the bounds permit; resumable on the same runId.
   *
   * The run's abort signal is injected here, not supplied by the caller: an
   * `AbortSignal` is not serializable across IPC, and the ownership matters —
   * the desktop owns the run's lifetime (the same hub the diagnostic path
   * uses), so `cancelRun(runId)` ends an agent run exactly as it ends a
   * workflow. A pending approval the run raised is released by the pipeline,
   * never silently approved.
   */
  async runAgent(request: AgentRequest): Promise<AgentResult> {
    const signal = this.stack.cancellation.signalFor(request.runId);
    // D12: the bridge sees the progressive frames; it is in-memory only and
    // keyed by run id, so there is no persistence side effect involved.
    const streaming = request.streaming === true;
    this.stack.streamBridge.start(request.runId);
    const appendEvent = (e: import("../../src/execution/types.ts").StreamEvent) =>
      this.stack.streamBridge.append(request.runId, e);
    try {
      const settled = await this.stack.agent.run({
        ...request,
        signal,
        // D11/D12 opt-in: when streaming was requested, every turn forwards
        // the progressive frames; the result contract is unchanged.
        streaming,
        onStreamEvent: streaming ? appendEvent : undefined,
      });
      this.stack.streamBridge.done(request.runId);
      return settled;
    } catch (e) {
      const err = e as { code?: string; message?: string };
      this.stack.streamBridge.failed(request.runId, {
        code: err.code ?? "PROVIDER_CALL_FAILED",
        message: (err.message ?? "unknown error").slice(0, 280),
      });
      throw e;
    } finally {
      this.stack.cancellation.release(request.runId);
      // A cancelled run leaves any raised approval DANGLING: denial is the
      // conservative end state so no decision it raised can outlive it.
      if (signal.aborted) {
        for (const pending of this.stack.toolApprover.listPending()) {
          if (pending.runId === request.runId) {
            this.stack.toolApprover.deny(pending.id, "run cancelled by the caller");
          }
        }
      }
    }
  }

  /**
   * Where the run's progressive frames are. The renderer polls this; the
   * gateway itself never touches persistence. Absence of the run (never
   * started or released) answers with `undefined`.
   */
  getAgentStream(runId: string, cursor: number): {
    readonly events: readonly import("../../src/execution/types.ts").StreamEvent[];
    readonly state: "running" | "done" | "failed";
    readonly error?: { readonly code: string; readonly message: string };
    readonly nextIndex: number;
  } | undefined {
    return this.stack.streamBridge.getSince(runId, cursor);
  }

  getWorkflowStream(runId: string, cursor: number): {
    readonly events: readonly import("../../src/execution/types.ts").StreamEvent[];
    readonly state: "running" | "done" | "failed";
    readonly error?: { readonly code: string; readonly message: string };
    readonly nextIndex: number;
  } | undefined {
    return this.stack.workflowStreamBridge.getSince(runId, cursor);
  }

  // ---- models & providers (D5) --------------------------------------
  //
  // Read-only catalogue data for the UI. The descriptor is provider-agnostic
  // and contains no secret material; the UI shows it so the human can see
  // WHICH models exist and WHY only the local ones are reachable under the
  // frozen posture.

  /**
   * The models the catalogue holds, as a plain JSON-safe list for the
   * renderer, with the frozen posture that bounds selection alongside.
   */
  listModels(): ReadonlyArray<{
    readonly id: string;
    readonly provider: string;
    readonly displayName: string;
    readonly locality: string;
    readonly costClass: string;
    readonly status: string;
    readonly enabled: boolean;
    readonly available: boolean;
    readonly fixed: boolean;
    readonly tools: boolean;
    /** Whether the descriptor advertises a streaming response (D11). */
    readonly streaming: boolean;
  }> {
    return this.stack.core.stack.catalog.snapshot().map((m) => ({
      id: m.id,
      provider: m.provider,
      displayName: m.displayName,
      locality: m.locality,
      costClass: m.pricing.costClass,
      status: m.status,
      enabled: m.enabled,
      available: m.available,
      fixed: Boolean(m.fixed),
      tools: m.tools,
      streaming: m.streaming,
    }));
  }

  /**
   * The user-registered providers, as plain JSON-safe data for the UI: who
   * they are, where they live, what they cost, whether their key is in
   * storage, and whether the engine actually registered them. No values.
   */
  listModelProviders(): ReadonlyArray<{
    readonly id: string;
    readonly displayName: string;
    readonly endpoint: string;
    readonly locality: "local" | "remote";
    readonly costClass: "FREE" | "PAID";
    readonly registered: boolean;
    readonly apiKeyEnv: string | null;
    /** true/false when a key is needed; null when the endpoint needs none. */
    readonly credentialPresent: boolean | null;
    readonly models: readonly string[];
  }> {
    const settings = this.stack.settingsStore.get();
    return settings.providers.map((p) => {
      let locality: "local" | "remote" = "remote";
      try {
        const host = new URL(p.endpoint).hostname.toLowerCase();
        if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") locality = "local";
      } catch {
        /* unparseable endpoints never survived registration */
      }
      const paid = (p.models ?? []).some((m) => m.costPer1MUsd !== undefined);
      return {
        id: p.id,
        displayName: p.displayName ?? p.id,
        endpoint: p.endpoint,
        locality,
        costClass: paid ? "PAID" : "FREE",
        registered: this.stack.core.stack.adapters.has(p.id),
        apiKeyEnv: p.apiKeyEnv ?? null,
        credentialPresent: p.apiKeyEnv ? this.stack.credentials.has(p.apiKeyEnv) : null,
        models: (p.models ?? []).map((m) => m.id),
      };
    });
  }

  /** Why selection is bounded the way it is: the frozen posture, read-only. */
  selectionPosture(): {
    readonly egress: string;
    readonly budgetUsd: number;
    readonly policy: string;
    readonly note: string;
  } {
    const providers = this.stack.settingsStore.get().providers;
    const allowlist = this.stack.core.stack.egress.allowlist;
    if (providers.length === 0) {
      return {
        egress: this.stack.core.stack.egress.kind,
        budgetUsd: this.stack.budget.snapshot().budgetUsd,
        policy: "FREE_ONLY",
        note:
          "Only local, zero-cost models are reachable: egress is deny-all, the budget is 0, and the cost policy is FREE_ONLY. No credential is read and no host is contacted.",
      };
    }
    const hosts = allowlist.length > 0 ? allowlist.join(", ") : "loopback only";
    return {
      egress: this.stack.core.stack.egress.kind,
      budgetUsd: this.stack.budget.snapshot().budgetUsd,
      policy: "FREE_ONLY",
      note:
        `${providers.length} user-registered provider(s): ${providers.map((p) => p.id).join(", ")}. Egress is open to ${hosts}; the budget stays ${this.stack.budget.snapshot().budgetUsd} USD and the cost policy stays FREE_ONLY, so a paid model remains unselectable until the human lifts both.`,
    };
  }
}

function summarize(response: { ok: boolean; structured?: unknown }): string {
  if (!response.ok) return "step failed";
  const structured = response.structured as Record<string, unknown> | null;
  if (structured && typeof structured === "object" && "summary" in structured) {
    return String(structured.summary);
  }
  return "analysis completed";
}

function wantPlanOf(req: DiagnosticRequest, result: WorkflowResult): boolean {
  return (req.plan ?? defaultPlanFor(req.mode)) && !!result.plan;
}
