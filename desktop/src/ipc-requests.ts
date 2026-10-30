/**
 * D29: the diagnostic IPC request boundary, extracted from the Electron
 * handler so the seam is testable without a window.
 *
 * Why this file exists. D16 added `streaming` and `runId` to
 * `DiagnosticRequest`, D16/D17 wired the main-process bridge side, and D18
 * built a renderer that polls `getWorkflowStream` — but the ONE handler in
 * between them never forwarded either field. `facade.runDiagnostic` therefore
 * always saw `streaming === undefined`, so `workflowStreamBridge.start()` never
 * ran and the D18 progress overlay polled a bridge key that could never exist.
 * A whole shipped milestone, and its "stream events" checkbox, were inert; and
 * the renderer's stable runId — the only input D26's resume contract can act on
 * — was dropped before it ever arrived at the facade.
 *
 * The mapping is pure and throws on invalid input exactly as the inline handler
 * did, so main.ts stays a thin registration layer over an enumerated surface.
 */
import { SAFETY_MODES, type SafetyMode } from "../../src/safety/guard.ts";
import { MODEL_ROLES, type ModelRole } from "../../src/registry/roles.ts";
import type {
  CollaborateParticipant,
  CollaborateRequest,
  DiagnosticRequest,
  ManyModelRequest,
} from "./facade.ts";

export function isSafetyMode(v: unknown): v is SafetyMode {
  return typeof v === "string" && (SAFETY_MODES as readonly string[]).includes(v);
}

export function isModelRole(v: unknown): v is ModelRole {
  return typeof v === "string" && (MODEL_ROLES as readonly string[]).includes(v);
}

/**
 * Map a raw IPC payload onto a `DiagnosticRequest`, throwing the same errors
 * the inline handler threw. `runId` and `streaming` are forwarded so the D16
 * bridge and the D26 resume path can ever be reached at all.
 */
export function buildDiagnosticRequest(raw: unknown): DiagnosticRequest {
  if (!raw || typeof raw !== "object") throw new Error("Invalid diagnostic request");
  const req = raw as Record<string, unknown>;
  if (!isSafetyMode(req.mode)) throw new Error(`Invalid mode: ${String(req.mode)}`);
  if (typeof req.subject !== "string") throw new Error("subject must be a string");
  const steps = Array.isArray(req.steps) && req.steps.every(isModelRole)
    ? (req.steps as ModelRole[])
    : undefined;
  return {
    mode: req.mode,
    subject: req.subject,
    steps,
    auto: req.auto === true,
    plan: typeof req.plan === "boolean" ? req.plan : undefined,
    timeoutMs: typeof req.timeoutMs === "number" ? req.timeoutMs : undefined,
    // D29: the two fields the D16-D18 chain needs and the inline handler
    // dropped. A non-string runId is ignored (the facade generates one), and
    // only an explicit `true` opts into streaming — it is never defaulted,
    // because a progressive channel is a caller's explicit choice.
    runId: typeof req.runId === "string" ? req.runId : undefined,
    streaming: req.streaming === true,
  };
}

/**
 * The Compare IPC boundary, same contract as D29: the mapping is pure and is
 * what main's thin `agent:many` handler feeds the facade, so a renderer payload
 * can only reach `runMany` through this shape check — a raw object field that
 * is not in this list never crosses the boundary.
 *
 * `batchId` is restricted to a safe token: it seeds the per-slot runIds, and
 * run ids feed the persisted run store, so it may carry no separator, no
 * path component, and no more than 64 characters.
 */
export function buildManyRequest(raw: unknown): ManyModelRequest {
  if (!raw || typeof raw !== "object") throw new Error("Invalid compare request");
  const req = raw as Record<string, unknown>;
  if (typeof req.prompt !== "string" || req.prompt.trim() === "") {
    throw new Error("prompt must be a non-empty string");
  }
  const modelIds = Array.isArray(req.modelIds)
    ? (req.modelIds as unknown[]).filter((c): c is string => typeof c === "string")
    : [];
  // The boundary type is readonly; the builder is mutable while it validates
  // and casts only at the return, so a rejected field can never be half-set.
  const out: {
    prompt: string;
    modelIds: string[];
    batchId?: string;
    mode?: SafetyMode;
    auto?: ManyModelRequest["auto"];
    timeoutMs?: number;
    concurrency?: number;
    streaming?: boolean;
  } = {
    prompt: req.prompt,
    modelIds,
  };
  const batchId =
    typeof req.batchId === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(req.batchId)
      ? req.batchId
      : undefined;
  if (batchId !== undefined) out.batchId = batchId;
  if (req.mode !== undefined) {
    if (!isSafetyMode(req.mode)) throw new Error(`Invalid mode: ${String(req.mode)}`);
    out.mode = req.mode;
  }
  if (req.auto && typeof req.auto === "object") {
    const a = req.auto as Record<string, unknown>;
    out.auto = {
      auto: a.auto === true,
      maxIterations: Number.isInteger(a.maxIterations) ? (a.maxIterations as number) : undefined,
      maxEdits: Number.isInteger(a.maxEdits) ? (a.maxEdits as number) : undefined,
      dryRunFirst: typeof a.dryRunFirst === "boolean" ? a.dryRunFirst : undefined,
    };
  }
  if (Number.isFinite(req.timeoutMs)) out.timeoutMs = req.timeoutMs as number;
  if (Number.isFinite(req.concurrency) && (req.concurrency as number) > 0) {
    out.concurrency = req.concurrency as number;
  }
  out.streaming = req.streaming === true;
  return out as ManyModelRequest;
}

/**
 * D34: the Collaborate IPC boundary, same contract as D29 and D33: the
 * mapping is pure and is what main's thin `collab:run` handler feeds the
 * facade, so a renderer payload can only reach `runCollab` through this
 * shape check. `runId` is restricted to a safe token — it seeds the persisted
 * run record and the stream bridge key, so it may carry no separator, no
 * path component, and no more than 64 characters.
 */
export function buildCollabRequest(raw: unknown): CollaborateRequest {
  if (!raw || typeof raw !== "object") throw new Error("Invalid collaborate request");
  const req = raw as Record<string, unknown>;
  if (typeof req.task !== "string" || req.task.trim() === "") {
    throw new Error("task must be a non-empty string");
  }
  if (!Array.isArray(req.participants) || req.participants.length < 2) {
    throw new Error("collaborate requires at least two participants");
  }
  if (req.strategy !== "parallel" && req.strategy !== "sequential" && req.strategy !== "debate") {
    throw new Error(`Invalid strategy: ${String(req.strategy)}`);
  }
  if (!isSafetyMode(req.mode)) throw new Error(`Invalid mode: ${String(req.mode)}`);

  // The boundary type is readonly; the builder is mutable while it validates
  // and casts only at the return, so a rejected field can never be half-set.
  const out: {
    task: string;
    participants: CollaborateParticipant[];
    strategy: "parallel" | "sequential" | "debate";
    synthesis?: { readonly provider: string; readonly modelId: string };
    mode: SafetyMode;
    auto?: boolean;
    timeoutMs?: number;
    streaming?: boolean;
    runId?: string;
  } = {
    task: req.task,
    participants: [],
    strategy: req.strategy as "parallel" | "sequential" | "debate",
    mode: req.mode as SafetyMode,
  };
  for (const entry of req.participants) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || e.id.trim() === "") throw new Error("participant id must be a non-empty string");
    if (typeof e.provider !== "string" || e.provider.trim() === "") throw new Error("participant provider must be a non-empty string");
    if (typeof e.modelId !== "string" || e.modelId.trim() === "") throw new Error("participant modelId must be a non-empty string");
    if (typeof e.role !== "string" || !isModelRole(e.role)) throw new Error(`participant role must be a registered role, got ${String(e.role)}`);
    if (typeof e.task !== "string" || e.task.trim() === "") throw new Error("participant task must be a non-empty string");
    out.participants.push({
      id: e.id,
      provider: e.provider,
      modelId: e.modelId,
      role: e.role as ModelRole,
      task: e.task,
      streaming: e.streaming === true,
    });
  }
  if (out.participants.length < 2) {
    throw new Error("collaborate requires at least two valid participants");
  }

  if (req.synthesis && typeof req.synthesis === "object") {
    const s = req.synthesis as Record<string, unknown>;
    if (typeof s.provider === "string" && typeof s.modelId === "string") {
      out.synthesis = { provider: s.provider, modelId: s.modelId };
    }
  }
  if (req.auto === true) out.auto = true;
  if (Number.isFinite(req.timeoutMs)) out.timeoutMs = req.timeoutMs as number;
  if (req.streaming === true) out.streaming = true;
  const runId =
    typeof req.runId === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(req.runId)
      ? req.runId
      : undefined;
  if (runId !== undefined) out.runId = runId;
  return out as CollaborateRequest;
}
