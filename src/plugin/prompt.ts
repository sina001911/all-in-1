/**
 * Command prompt parsing (P6).
 *
 * A registered OpenCode command receives the user's argument text as
 * `input.prompt.text`. This module turns that free text into the structured
 * request the execution layer consumes. It is pure and side-effect free so the
 * command surface is exhaustively testable without the SDK or a session.
 *
 * Grammar (deliberately tiny and forgiving):
 *
 *   <subject...>                     the analysis subject
 *   --auto                           explicit autonomous opt-in (BUILD only)
 *   --steps role,role                override the workflow steps
 *   --plan / --no-plan               request or suppress a plan
 *
 * Anything else is part of the subject. Unknown roles and unknown flags are
 * reported as a typed parse error rather than silently ignored, because a
 * silent misroute of a BUILD request would be a safety bug, not a convenience.
 */
import { MODEL_ROLES, type ModelRole } from "../registry/roles.ts";

export interface ParsedCommand {
  readonly ok: true;
  /** Remaining text after flag extraction; the analysis subject. */
  readonly subject: string;
  /** True only when the caller passed `--auto`. Never defaulted. */
  readonly auto: boolean;
  /** Step roles, or null when the caller left the command default in place. */
  readonly steps: readonly ModelRole[] | null;
  /** Plan override, or null when unspecified. */
  readonly plan: boolean | null;
}

export interface CommandParseError {
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string };
}

export type CommandParseResult = ParsedCommand | CommandParseError;

export function parseCommandPrompt(text: string): CommandParseResult {
  const tokens = splitTokens(text);
  const subjectParts: string[] = [];
  let auto = false;
  let steps: ModelRole[] | null = null;
  let plan: boolean | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;

    if (token === "--auto") {
      auto = true;
      continue;
    }
    if (token === "--plan") {
      plan = true;
      continue;
    }
    if (token === "--no-plan") {
      plan = false;
      continue;
    }
    if (token === "--steps") {
      const value = tokens[i + 1];
      if (value === undefined) {
        return parseError("COMMAND_PARSE", "--steps requires a comma-separated role list");
      }
      i += 1;
      const parsed = parseRoles(value);
      if (!parsed.ok) return parsed;
      steps = parsed.roles;
      continue;
    }

    // An unknown long flag is an error, not a subject fragment: silently
    // treating `--audo` as text would hide a typo that changes autonomy.
    if (token.startsWith("--")) {
      return parseError("COMMAND_PARSE", `unknown flag: ${token}`);
    }
    subjectParts.push(token);
  }

  const subject = subjectParts.join(" ").trim();
  return { ok: true, subject, auto, steps, plan };
}

export function splitTokens(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function parseRoles(value: string): { ok: true; roles: ModelRole[] } | CommandParseError {
  const requested = value
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  if (requested.length === 0) {
    return parseError("COMMAND_PARSE", "--steps requires at least one role");
  }
  const roles: ModelRole[] = [];
  for (const name of requested) {
    if (!MODEL_ROLES.includes(name as ModelRole)) {
      return parseError(
        "COMMAND_PARSE",
        `unknown role in --steps: ${name}. Valid roles: ${MODEL_ROLES.join(", ")}`,
      );
    }
    roles.push(name as ModelRole);
  }
  return { ok: true, roles };
}

function parseError(code: string, message: string): CommandParseError {
  return { ok: false, error: { code, message } };
}
