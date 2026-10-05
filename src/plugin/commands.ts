/**
 * Command surface (P6).
 *
 * Builds the OpenCode commands the plugin registers and the seam that delivers
 * their results back to the session. Every command is a thin wrapper: it parses
 * the prompt, runs the execution layer, and delivers the result. All analysis
 * routes through the P4 engine and its gates; the plugin never writes a file.
 *
 * The OpenCode context is consumed through a narrow structural interface so the
 * real `Plugin.Context` is assignable while the surface stays testable without
 * the SDK. The types come from the ambient contract in
 * `src/opencode-plugin.d.ts` as type-only imports, so no runtime dependency is
 * introduced.
 */
import type {
  CommandDomain,
  CommandInvocation,
  Registration,
  SessionPromptInput,
} from "@opencode/plugin";
import { executePluginCommand } from "./execute.ts";
import type { CommandExecutionRequest } from "./execute.ts";
import { parseCommandPrompt } from "./prompt.ts";
import type { CommandParseResult, ParsedCommand } from "./prompt.ts";
import type { SafetyMode } from "../safety/guard.ts";

export const COMMAND_IDS = [
  "all-in-1-inspect",
  "all-in-1-suggest",
  "all-in-1-build",
  "all-in-1-specialist",
  "all-in-1-policy",
] as const;
export type CommandId = (typeof COMMAND_IDS)[number];

/** The narrow slice of the plugin context this surface needs. */
export interface PluginCommandContext {
  readonly command: Pick<CommandDomain, "transform">;
  readonly session: { readonly prompt: (input: SessionPromptInput) => Promise<unknown> };
}

export interface DeliverInput {
  readonly sessionID: string;
  readonly text: string;
  readonly delivery: CommandInvocation["delivery"];
  readonly files?: SessionPromptInput["files"];
}

export type Deliver = (input: DeliverInput) => Promise<void>;

/**
 * Register every all_in_1 command. Returns the transform registration so the
 * plugin can dispose it on unload.
 */
export async function registerAllInOneCommands(ctx: PluginCommandContext): Promise<Registration> {
  return await ctx.command.transform((editor) => {
    for (const definition of allInOneCommandDefinitions(makeDeliver(ctx))) {
      editor.add(definition);
    }
  });
}

function makeDeliver(ctx: PluginCommandContext): Deliver {
  return async (input) => {
    await ctx.session.prompt(input);
  };
}

/**
 * The command definitions, parameterised by the delivery seam so they are pure
 * with respect to the SDK and exhaustively testable.
 */
export function allInOneCommandDefinitions(deliver: Deliver): readonly CommandDefinitionLike[] {
  return [
    modeCommand(deliver, "all-in-1-inspect", "INSPECT", "Analyze a subject. Read-only; proposes no changes."),
    modeCommand(deliver, "all-in-1-suggest", "SUGGEST", "Analyze a subject and produce a plan. Proposes changes, applies nothing."),
    modeCommand(deliver, "all-in-1-build", "BUILD", "Analyze and plan an edit. Editing stays with the OpenCode tools under human supervision. Pass --auto for bounded autonomous iteration."),
    specialistCommand(deliver),
    policyCommand(deliver),
  ];
}

/** Shape the editor accepts; mirrors the ambient `CommandDefinition`. */
export interface CommandDefinitionLike {
  readonly name: string;
  readonly description?: string;
  readonly execute: (input: CommandInvocationLike) => Promise<void>;
}

export interface CommandInvocationLike {
  readonly sessionID: string;
  readonly prompt: { readonly text: string; readonly files?: SessionPromptInput["files"] };
  readonly delivery: CommandInvocation["delivery"];
}

function modeCommand(
  deliver: Deliver,
  name: string,
  mode: SafetyMode,
  description: string,
): CommandDefinitionLike {
  return {
    name,
    description,
    async execute(input) {
      await runAndDeliver(deliver, input, mode, (parsed) => ({
        mode,
        subject: parsed.subject,
        steps: parsed.steps,
        plan: parsed.plan,
        auto: parsed.auto,
        specialistId: null,
      }));
    },
  };
}

function specialistCommand(deliver: Deliver): CommandDefinitionLike {
  return {
    name: "all-in-1-specialist",
    description: "Run one named specialist by id: all-in-1-specialist <id> <subject>",
    async execute(input) {
      const first = firstToken(input.prompt.text);
      const rest = withoutFirstToken(input.prompt.text);
      await runAndDeliver(deliver, input, "INSPECT", (parsed) => ({
        mode: "INSPECT",
        subject: rest || parsed.subject,
        steps: parsed.steps,
        plan: parsed.plan,
        auto: parsed.auto,
        specialistId: first,
      }));
    },
  };
}

function policyCommand(deliver: Deliver): CommandDefinitionLike {
  return {
    name: "all-in-1-policy",
    description: "Show the frozen cost, autonomy, and media defaults this plugin enforces.",
    async execute(input) {
      await deliver({
        sessionID: input.sessionID,
        delivery: input.delivery,
        text: [
          "[all-in-1] frozen defaults (enforced by tests, not convention)",
          "mainCoder: Atria-Dawn-Preview / s1 — immutable, router cannot resolve it",
          "spendBudgetUsd: 0",
          "default policy: FREE_ONLY — UNKNOWN_COST is blocked, no silent free->paid fallback",
          "BUILD: human-in-the-loop by default; --auto is an explicit, bounded opt-in (maxIterations 5)",
          "media: disabled in MVP (interfaces and registries only)",
          "egress: deny-all by default; opening a host is three explicit human acts",
          "runtime dependencies: zero — this package has no npm dependencies",
          "",
          "The only file writers are the OpenCode tools. This plugin binds commands, not writers.",
        ].join("\n"),
      });
    },
  };
}

async function runAndDeliver(
  deliver: Deliver,
  input: CommandInvocationLike,
  mode: SafetyMode,
  toRequest: (parsed: ParsedCommand) => CommandExecutionRequest,
): Promise<void> {
  const parsed = parseCommandPrompt(input.prompt.text);
  if (!parsed.ok) {
    await deliver({
      sessionID: input.sessionID,
      delivery: input.delivery,
      text: `[all-in-1] command refused: ${parsed.error.message}`,
    });
    return;
  }
  const request = toRequest(parsed);
  let text: string;
  try {
    const result = await executePluginCommand(request);
    text = result.text;
  } catch (e) {
    text = `[all-in-1 ${mode}] failed unexpectedly: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
  }
  await deliver({
    sessionID: input.sessionID,
    delivery: input.delivery,
    files: input.prompt.files,
    text,
  });
}

function firstToken(text: string): string | null {
  const token = text.trim().split(/\s+/)[0];
  return token && token.length > 0 ? token : null;
}

function withoutFirstToken(text: string): string {
  return text.trim().split(/\s+/).slice(1).join(" ").trim();
}
