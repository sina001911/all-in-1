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
} from "./persistence/types.ts";
import type { ToolRequest, ToolResult } from "../../src/tools/types.ts";
import type { ToolAuditRecord } from "../../src/tools/audit.ts";
import type { ApprovalRecord as ToolApprovalEntry } from "./tools/approver.ts";

export interface DiagnosticRequest {
  readonly mode: SafetyMode;
  readonly subject: string;
  /** Step roles; defaults are per-mode when omitted. */
  readonly steps?: readonly ModelRole[];
  /** Explicit autonomous opt-in. Never defaulted by the facade. */
  readonly auto?: boolean;
  /** Produce a plan summary (requires plan permission). */
  readonly plan?: boolean;
  /** Per-step invocation timeout forwarded to the engine. */
  readonly timeoutMs?: number;
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
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const signal = this.stack.cancellation.signalFor(runId);
    const startedAt = Date.now();

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
      },
    });

    let result: WorkflowResult;
    try {
      result = await loop.run();
    } catch (e) {
      this.stack.runStore.update(runId, {
        finishedAt: Date.now(),
        status: "failed",
        ok: false,
        errorCode: "WORKFLOW_FAILED",
      });
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

  patchSettings(patch: Partial<DesktopSettings>): DesktopSettings {
    return this.stack.settingsStore.patch(patch);
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
