/**
 * Command execution (P6).
 *
 * Turns a parsed plugin command into a deliverable by routing it through the
 * P5 specialist stack — hence through the P4 engine, hence through every
 * policy, approval, egress, secret, and budget gate, unchanged. This module
 * performs no network call, reads no credential, and writes no file. It is the
 * engine's consumer, never a way around it.
 *
 * Mode enforcement happens here, at the boundary of the command surface:
 *   - every command may analyze (INSPECT/SUGGEST/BUILD all hold the permission),
 *   - a plan requires the plan permission (SUGGEST/BUILD),
 *   - an edit-capable plan additionally requires the edit permission (BUILD),
 *     asserted through the P6 edit boundary before such a plan is produced.
 *
 * The stack used is the default inert one: deterministic local adapter and
 * models only, deny-all egress, zero budget, FREE_ONLY policy, no credential.
 * A command therefore cannot open a remote path even if the caller asks; that
 * remains three explicit human acts outside the plugin.
 */
import type { ModelRole } from "../registry/roles.ts";
import type { SafetyMode } from "../safety/guard.ts";
import { assertCanAnalyze, assertCanPlan } from "../safety/guard.ts";
import { buildSpecialistStack } from "../specialists/stack.ts";
import type { SpecialistStack } from "../specialists/stack.ts";
import { SpecialistRegistry, registerBaselineSpecialists } from "../specialists/registry.ts";
import { WorkflowLoop } from "../workflow/index.ts";
import type { WorkflowResult } from "../workflow/index.ts";
import { assertEditPlanAllowed, editPlanDisclaimer } from "./plan-gate.ts";

export interface CommandExecutionRequest {
  readonly mode: SafetyMode;
  readonly subject: string;
  readonly steps: readonly ModelRole[] | null;
  /** Plan override; null leaves the mode default. */
  readonly plan: boolean | null;
  /** Explicit `--auto` opt-in. Never defaulted by this module. */
  readonly auto: boolean;
  /** Run a single named specialist instead of a workflow. */
  readonly specialistId: string | null;
}

export interface CommandExecutionResult {
  readonly ok: boolean;
  readonly mode: SafetyMode;
  /** Human-readable deliverable for the session. */
  readonly text: string;
  readonly pausedForHuman: boolean;
  readonly escalated: boolean;
  readonly errorCode?: string;
}

/** Default single-step workflow per mode. One analytical turn per command, so a
 * command completes in a single invocation; BUILD hands back a plan rather than
 * an edit, and `--steps`/`--auto` extend the loop when the caller asks. */
const DEFAULT_STEPS: Readonly<Record<SafetyMode, readonly ModelRole[]>> = {
  INSPECT: ["CODE_REVIEWER"],
  SUGGEST: ["DEEP_REASONING"],
  BUILD: ["CODE_REVIEWER"],
};

/** A plan is the natural deliverable of a mode that may plan. */
function defaultPlanFor(mode: SafetyMode): boolean {
  return mode !== "INSPECT";
}

/**
 * The baseline specialist id->role mapping. Built locally rather than read off
 * the P5 stack so this module does not need to modify a frozen surface to reach
 * the registry; `buildSpecialistStack` registers the same baseline set, so the
 * mapping used for lookup is the mapping used for execution.
 */
function baselineSpecialists(): SpecialistRegistry {
  const registry = new SpecialistRegistry();
  registerBaselineSpecialists(registry);
  return registry;
}

export async function executePluginCommand(
  req: CommandExecutionRequest,
  stack: SpecialistStack = buildSpecialistStack(),
): Promise<CommandExecutionResult> {
  // Mode enforcement at the boundary.
  try {
    assertCanAnalyze(req.mode);
    const wantPlan = req.plan ?? defaultPlanFor(req.mode);
    if (wantPlan) assertCanPlan(req.mode);
    // The P6 edit boundary: an edit-capable plan can only come from BUILD.
    // SUGGEST may plan advisably without any edit permission, so the gate is
    // asserted for the mode that holds the edit permission and nothing else.
    if (req.mode === "BUILD" && wantPlan) assertEditPlanAllowed(req.mode);
  } catch (e) {
    return toFailure(req, e, "MODE_VIOLATION");
  }

  if (req.specialistId) {
    return await runSpecialist(req.specialistId, req, stack);
  }
  return await runWorkflow(req, stack);
}

async function runSpecialist(
  id: string,
  req: CommandExecutionRequest,
  stack: SpecialistStack,
): Promise<CommandExecutionResult> {
  const descriptor = baselineSpecialists().get(id);
  if (!descriptor) {
    const available = baselineSpecialists()
      .list()
      .map((d) => d.id)
      .join(", ");
    return toText(req, false, {
      text: `No specialist is registered with id ${id}. Available: ${available}`,
      errorCode: "SPECIALIST_NOT_FOUND",
    });
  }
  const response = await stack.runner.run({
    role: descriptor.role,
    prompt: req.subject,
    inputs: req.subject ? [{ kind: "text", text: req.subject }] : [],
    outputSchema: {},
  });
  if (!response.ok) {
    return toText(req, false, {
      text: `Specialist ${descriptor.id} failed: ${response.error.code} — ${response.error.message}`,
      errorCode: response.error.code,
    });
  }
  return toText(req, true, {
    text: [
      `[all-in-1 specialist:${descriptor.id}] role ${descriptor.role}`,
      header(req),
      "",
      JSON.stringify(response.structured, null, 2),
    ].join("\n"),
  });
}

async function runWorkflow(
  req: CommandExecutionRequest,
  stack: SpecialistStack,
): Promise<CommandExecutionResult> {
  const roles = req.steps ?? DEFAULT_STEPS[req.mode];
  const wantPlan = req.plan ?? defaultPlanFor(req.mode);
  const loop = new WorkflowLoop({
    runner: stack.runner,
    request: {
      mode: req.mode,
      auto: req.auto ? { auto: true } : undefined,
      plan: wantPlan,
      steps: roles.map((role) => ({
        role,
        prompt: req.subject,
        inputs: req.subject ? [{ kind: "text", text: req.subject }] : [],
        outputSchema: {},
      })),
    },
  });

  let result: WorkflowResult;
  try {
    result = await loop.run();
  } catch (e) {
    return toFailure(req, e, "WORKFLOW_FAILED");
  }

  const body: string[] = [];
  for (const step of result.results) {
    const summary = summarize(step.response);
    body.push(`- [${step.role}] ${summary}`);
  }
  const lines = [
    `[all-in-1 ${req.mode}] subject: ${quote(req.subject)}`,
    header(req),
    "",
    ...(body.length > 0 ? body : ["(no step produced output)"]),
  ];
  if (wantPlan && result.plan) {
    lines.push("", "plan:", ...result.plan.map((p) => `  ${p}`));
  }
  if (req.mode === "BUILD" && wantPlan) {
    lines.push("", editPlanDisclaimer());
  }
  if (result.pausedForHuman) {
    lines.push("", "paused for human: re-invoke the command to continue to the next step.");
  }
  if (result.error) {
    lines.push("", `error: ${result.error.code} — ${result.error.message}`);
  }
  return {
    ok: result.ok,
    mode: req.mode,
    text: lines.join("\n"),
    pausedForHuman: result.pausedForHuman,
    escalated: result.escalated,
    errorCode: result.error?.code,
  };
}

function header(req: CommandExecutionRequest): string {
  const perms = req.mode === "INSPECT" ? "analyze only, no edits" : req.mode === "SUGGEST" ? "analyze + plan, no edits" : "analyze + plan; edits only via OpenCode tools";
  return [
    `mode: ${req.mode} — ${perms}`,
    "engine: deterministic local (FREE · offline · egress deny-all · budget 0)",
    req.auto ? "auto: explicit opt-in, bounded (maxIterations 5)" : "auto: off (human-in-the-loop)",
  ].join("\n");
}

function summarize(response: { ok: boolean; structured?: unknown }): string {
  if (!response.ok) return "step failed";
  const structured = response.structured as Record<string, unknown> | null;
  if (structured && typeof structured === "object" && "summary" in structured) {
    return String(structured.summary);
  }
  return "analysis completed";
}

function quote(text: string): string {
  return text.length > 0 ? `"${text}"` : "(no subject given)";
}

function toFailure(req: CommandExecutionRequest, e: unknown, code: string): CommandExecutionResult {
  const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return {
    ok: false,
    mode: req.mode,
    text: `[all-in-1 ${req.mode}] refused: ${message}`,
    pausedForHuman: false,
    escalated: false,
    errorCode: code,
  };
}

function toText(
  req: CommandExecutionRequest,
  ok: boolean,
  parts: { text: string; errorCode?: string },
): CommandExecutionResult {
  return {
    ok,
    mode: req.mode,
    text: parts.text,
    pausedForHuman: false,
    escalated: false,
    errorCode: parts.errorCode,
  };
}
