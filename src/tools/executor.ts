/**
 * Tool executor (D2) — the fixed privilege pipeline.
 *
 *   1. RESOLVE    the tool must exist in the closed registry.
 *   2. VALIDATE   the input must satisfy the tool's schema, before anything is
 *                 touched. An unparseable schema is a registration-time error.
 *   3. MODE GATE  if the caller named a safety mode, the class must be permitted
 *                 by the frozen MODE_PERMISSIONS.
 *   4. APPROVE    if the class requires a human approval, ask the approver —
 *                 never the model — and race it against the run signal.
 *   5. EXECUTE    bounded by timeout and cancellation, isolated from the
 *                 runtime: a tool failure is a result, never an exception.
 *   6. AUDIT      always, for every terminal state.
 *
 * Why validate precedes approve: an invalid request is free to reject, and
 * asking a human to approve a request that cannot run would waste their turn.
 * Why approve precedes execute should need no explanation.
 *
 * The executor never returns a thrown error: every failure path, including a
 * thrown tool bug, is converted into a settled `ToolResult` and audited, so a
 * caller can never observe a half-applied tool and the loop never crashes.
 */
import type {
  Tool,
  ToolContent,
  ToolContext,
  ToolOutput,
  ToolRequest,
  ToolResult,
} from "./types.ts";
import type { ToolRegistry } from "./registry.ts";
import type { ToolPermissionPolicy } from "./permissions.ts";
import type { ToolApprover, ToolApprovalRequest } from "./approval.ts";
import type { ToolAuditLog, ToolAuditStatus } from "./audit.ts";
import { decisionFields } from "./audit.ts";
import { summarizeInput, capSummary } from "./summary.ts";
import { validateStructured } from "../specialists/validator.ts";
import { WorkspaceManager } from "./workspace.ts";
import { AllInOneError, isAllInOneError, toAllInOneError } from "../errors.ts";

export interface ToolExecutorOptions {
  readonly registry: ToolRegistry;
  readonly policy: ToolPermissionPolicy;
  readonly approver: ToolApprover;
  readonly audit: ToolAuditLog;
  readonly workspace: WorkspaceManager;
  /** Ceiling no per-call timeout can exceed. */
  readonly maxTimeoutMs?: number;
  /** Timeout used when neither the tool nor the request names one. */
  readonly defaultTimeoutMs?: number;
}

const DEFAULT_MAX_TIMEOUT_MS = 60_000;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

let auditCounter = 0;

function nextAuditId(): string {
  auditCounter += 1;
  return `tool-audit-${Date.now()}-${auditCounter.toString(36)}`;
}

export class ToolExecutor {
  private readonly opts: ToolExecutorOptions;

  constructor(opts: ToolExecutorOptions) {
    this.opts = opts;
  }

  async execute(req: ToolRequest): Promise<ToolResult> {
    const startedAt = Date.now();
    const auditId = nextAuditId();
    const tool = this.opts.registry.get(req.toolName);

    // 1. RESOLVE
    if (!tool) {
      this.audit(auditId, req, tool, "failed", "TOOL_NOT_FOUND", `No tool named "${req.toolName}" is registered`, startedAt, false);
      return fail(auditId, req.toolName, "TOOL_NOT_FOUND", `No tool named "${req.toolName}" is registered`, startedAt);
    }

    // 2. VALIDATE
    const validation = validateStructured(req.input, tool.schema.input);
    if (!validation.ok) {
      const message = `Invalid input for ${tool.schema.name}: ${validation.failures
        .map((f) => `${f.path} ${f.message}`)
        .join("; ")}`;
      this.audit(auditId, req, tool, "failed", "TOOL_VALIDATION_FAILED", message, startedAt, false);
      return fail(auditId, tool.schema.name, "TOOL_VALIDATION_FAILED", message, startedAt);
    }

    // 3. MODE GATE
    if (req.mode !== undefined && !this.opts.policy.allowsMode(tool.schema, req.mode)) {
      const message = `${tool.schema.name} requires a mode that permits "${tool.schema.permission}"; ${req.mode} does not`;
      this.audit(auditId, req, tool, "failed", "MODE_VIOLATION", message, startedAt, false);
      return fail(auditId, tool.schema.name, "MODE_VIOLATION", message, startedAt);
    }

    // 4. APPROVE — the model's own request can never satisfy this.
    let approved = false;
    if (this.opts.policy.requiresApproval(tool.schema)) {
      if (req.signal?.aborted) {
        this.audit(auditId, req, tool, "cancelled", "TOOL_CANCELLED", "run cancelled before approval", startedAt, false);
        return fail(auditId, tool.schema.name, "TOOL_CANCELLED", "run cancelled before approval", startedAt);
      }
      const approvalReq: ToolApprovalRequest = {
        id: auditId,
        runId: req.runId,
        toolName: tool.schema.name,
        permission: tool.schema.permission,
        summary: capSummary(describeRequest(tool, req.input)),
        inputSummary: summarizeInput(req.input),
        justification: req.justification,
        createdAt: Date.now(),
      };
      let decision;
      try {
        decision = await raceAbort(this.opts.approver.request(approvalReq, req.signal), req.signal);
      } catch (e) {
        const aborted = req.signal?.aborted === true;
        const code = aborted ? "TOOL_CANCELLED" : "TOOL_APPROVAL_REQUIRED";
        const message = aborted
          ? "approval was interrupted by run cancellation"
          : `approval could not be obtained: ${describe(e)}`;
        const status: ToolAuditStatus = aborted ? "cancelled" : "denied";
        this.audit(auditId, req, tool, status, code, message, startedAt, false, req.justification);
        return fail(auditId, tool.schema.name, code, message, startedAt);
      }
      const fields = decisionFields(decision);
      if (!decision.approved) {
        const message = `Human denied ${tool.schema.name}: ${decision.reason}`;
        this.audit(auditId, req, tool, "denied", "TOOL_APPROVAL_DENIED", message, startedAt, false, req.justification, fields.approvalNote);
        return fail(auditId, tool.schema.name, "TOOL_APPROVAL_DENIED", message, startedAt);
      }
      approved = true;
      this.audit(auditId, req, tool, "started", undefined, undefined, startedAt, approved, req.justification, fields.approvalNote);
    } else {
      this.audit(auditId, req, tool, "started", undefined, undefined, startedAt, approved, req.justification);
    }

    // 5. EXECUTE, bounded and isolated.
    const ctx: ToolContext = {
      runId: req.runId,
      workspace: this.opts.workspace,
      signal: (req.signal ?? neverAborts()) as AbortSignal,
    };
    const timeoutMs = this.boundedTimeout(tool, req.timeoutMs);

    let output: ToolOutput;
    try {
      output = await raceBounded(tool.execute(req.input, ctx), {
        timeoutMs,
        signal: req.signal,
      });
    } catch (e) {
      // A typed tool error keeps its code — a workspace violation must surface
      // as PATH_TRAVERSAL_BLOCKED, a timeout as TOOL_TIMEOUT — so the caller can
      // branch on it. Anything untyped is an unexpected tool bug, isolated here
      // as a generic execution failure that can never crash the runtime.
      const typedCode = isAllInOneError(e) ? e.code : undefined;
      const aborted = !typedCode && req.signal?.aborted === true;
      const code = typedCode ?? (aborted ? "TOOL_CANCELLED" : "TOOL_EXECUTION_FAILED");
      const status: ToolAuditStatus =
        code === "TOOL_TIMEOUT" ? "timeout" : code === "TOOL_CANCELLED" ? "cancelled" : "failed";
      const message = `${tool.schema.name} ${aborted ? "was cancelled by the caller" : describe(e)}`;
      this.audit(auditId, req, tool, status, code, message, startedAt, approved, req.justification);
      return fail(auditId, tool.schema.name, code, message, startedAt);
    }

    // 6. AUDIT the terminal state.
    if (output.ok) {
      this.audit(auditId, req, tool, "ok", undefined, undefined, startedAt, approved, req.justification);
      return {
        ok: true,
        toolName: tool.schema.name,
        auditId,
        approved,
        content: output.content,
        metadata: output.metadata,
        durationMs: Date.now() - startedAt,
      };
    }

    const timedOut = output.code === "TOOL_TIMEOUT";
    const status: ToolAuditStatus = timedOut ? "timeout" : output.code === "TOOL_CANCELLED" ? "cancelled" : "failed";
    this.audit(auditId, req, tool, status, output.code, output.message, startedAt, approved, req.justification);
    return fail(auditId, tool.schema.name, output.code, output.message, startedAt, approved);
  }

  private boundedTimeout(tool: Tool, reqTimeoutMs?: number): number | undefined {
    const ceiling = this.opts.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
    const candidates = [tool.schema.timeoutMs ?? this.opts.defaultTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS];
    if (reqTimeoutMs !== undefined) candidates.push(reqTimeoutMs);
    // The most restrictive bound wins; a caller can never widen a tool's ceiling.
    return Math.min(...candidates, ceiling);
  }

  private audit(
    auditId: string,
    req: ToolRequest,
    tool: Tool | undefined,
    status: ToolAuditStatus,
    errorCode?: string,
    message?: string,
    startedAt?: number,
    approved = false,
    justification?: string,
    approvalNote?: string,
  ): void {
    this.opts.audit.record({
      id: auditId,
      runId: req.runId,
      ts: Date.now(),
      toolName: tool?.schema.name ?? req.toolName,
      permission: tool?.schema.permission ?? "read",
      inputSummary: summarizeInput(req.input),
      justification,
      approved,
      approvalNote,
      status,
      errorCode,
      message: message !== undefined ? capSummary(message) : undefined,
      durationMs: startedAt !== undefined ? Date.now() - startedAt : undefined,
    });
  }
}

function fail(
  auditId: string,
  toolName: string,
  code: string,
  message: string,
  startedAt: number,
  approved = false,
  content: ToolContent[] = [],
): ToolResult {
  return { ok: false, toolName, auditId, code, message, approved, content, durationMs: Date.now() - startedAt };
}

function describeRequest(tool: Tool, input: unknown): string {
  const summary = summarizeInput(input);
  const path = typeof summary["path"] === "string" ? summary["path"] : "";
  const command = typeof summary["command"] === "string" ? summary["command"] : "";
  const target = path || (command ? `${command} ${(summary["args"] as unknown[] | undefined)?.map(String).join(" ") ?? ""}`.trim() : "");
  return target ? `${tool.schema.name} ${target}` : `${tool.schema.name}: ${tool.schema.description}`;
}

function describe(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

/** A signal that never aborts, for requests that did not supply one. */
function neverAborts(): AbortSignal {
  return new AbortController().signal;
}

/**
 * Race a promise against an abort signal. The underlying work is not
 * cancellable from here (that is the tool's concern); this decides when the
 * caller stops waiting, and a tool that ignores its signal is still bounded by
 * the timeout race.
 */
function raceBounded<T>(promise: Promise<T>, opts: { timeoutMs?: number; signal?: AbortSignal }): Promise<T> {
  if (opts.timeoutMs === undefined && !opts.signal) return promise;
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      action();
    };

    const onAbort = () =>
      finish(() => reject(new AllInOneError("tool cancelled by the caller", "TOOL_CANCELLED", "security")));

    if (opts.signal) {
      if (opts.signal.aborted) {
        reject(new AllInOneError("tool cancelled by the caller", "TOOL_CANCELLED", "security"));
        return;
      }
      opts.signal.addEventListener("abort", onAbort);
    }
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(
        () =>
          finish(() =>
            reject(
              new AllInOneError(
                `tool exceeded the ${opts.timeoutMs}ms timeout`,
                "TOOL_TIMEOUT",
                "unavailable",
                { retryable: true },
              ),
            ),
        ),
        opts.timeoutMs,
      );
    }

    promise.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e)),
    );
  });
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    throw new AllInOneError("approval interrupted: run already cancelled", "TOOL_CANCELLED", "security");
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AllInOneError("approval interrupted by run cancellation", "TOOL_CANCELLED", "security"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** Re-exported so callers can wrap a thrown tool error into a typed failure. */
export function toolFailure(e: unknown): ToolOutput {
  const err = toAllInOneError(e, {
    code: "TOOL_EXECUTION_FAILED",
    category: "unavailable",
    message: "tool execution failed",
  });
  return { ok: false, code: err.code, message: err.message };
}
