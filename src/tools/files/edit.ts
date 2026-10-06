/**
 * files.edit (D2). Replaces an exact substring inside a workspace file.
 *
 * Mirrors the semantics the human-facing edit tools use: `oldString` must occur
 * exactly once unless `replaceAll` is set, so an ambiguous edit is refused
 * rather than applied to the wrong occurrence. The result carries a unified
 * diff so the approving human can see exactly what changed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Tool, ToolContext, ToolOutput } from "../types.ts";
import { lineDiff, readTextBounded, toolFailure } from "./util.ts";

interface EditInput {
  readonly path: string;
  readonly oldString: string;
  readonly newString: string;
  readonly replaceAll?: boolean;
}

export const editTool: Tool = {
  schema: {
    name: "files.edit",
    description: "Replace an exact substring in a workspace file with another.",
    permission: "write",
    input: {
      type: "object",
      required: ["path", "oldString", "newString"],
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "target path inside a writable workspace root" },
        oldString: { type: "string", description: "the text to replace; must be unique unless replaceAll is set" },
        newString: { type: "string", description: "the replacement text" },
        replaceAll: { type: "boolean", description: "replace every occurrence" },
      },
    },
  },
  async execute(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
    const req = input as EditInput;
    if (ctx.signal.aborted) return toolFailure("TOOL_CANCELLED", "run cancelled before editing");
    if (req.oldString === req.newString) {
      return toolFailure("TOOL_VALIDATION_FAILED", "oldString and newString must differ");
    }
    if (req.oldString.length === 0) {
      return toolFailure("TOOL_VALIDATION_FAILED", "oldString must not be empty");
    }
    const resolved = ctx.workspace.resolveWrite(req.path);
    let before: string;
    try {
      before = readTextBounded(resolved, ctx.workspace.maxReadBytes).text;
    } catch {
      return toolFailure("ARTIFACT_READ_FAILED", `cannot read ${resolved}: not a file or unreadable`);
    }

    const occurrences = countOccurrences(before, req.oldString);
    if (occurrences === 0) {
      return toolFailure("TOOL_EXECUTION_FAILED", `oldString not found in ${resolved}`);
    }
    if (occurrences > 1 && !req.replaceAll) {
      return toolFailure(
        "TOOL_EXECUTION_FAILED",
        `oldString occurs ${occurrences} times in ${resolved}; set replaceAll or make it unique`,
      );
    }
    const after = req.replaceAll
      ? before.split(req.oldString).join(req.newString)
      : before.replace(req.oldString, req.newString);

    try {
      writeFileSync(resolved, after, "utf8");
    } catch {
      return toolFailure("ARTIFACT_WRITE_FAILED", `failed to write ${resolved}`);
    }
    return {
      ok: true,
      content: [{ type: "diff", path: resolved, diff: lineDiff(resolved, before, after) }],
      metadata: { path: resolved, occurrences: req.replaceAll ? occurrences : 1 },
    };
  },
};

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}
