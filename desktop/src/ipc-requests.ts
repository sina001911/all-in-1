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
import type { DiagnosticRequest } from "./facade.ts";

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
