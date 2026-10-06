/**
 * files.patch (D2). Line-based patching of a workspace file.
 *
 * Ops are line-addressed (1-based) and applied to a copy of the file's lines in
 * a single descending pass, so the addresses stay stable as the patch applies:
 * an op never shifts the line numbers a later op refers to. Anything outside
 * the file's extent is refused rather than clamped silently, so a patch cannot
 * quietly append to the wrong line.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Tool, ToolContext, ToolOutput } from "../types.ts";
import { lineDiff, readTextBounded, toolFailure } from "./util.ts";

type OpType = "insert" | "delete" | "replace";

interface PatchOp {
  readonly type: OpType;
  /** 1-based line number. For insert, the new line is placed BEFORE this line. */
  readonly lineNumber: number;
  readonly text?: string;
}

interface PatchInput {
  readonly path: string;
  readonly ops: readonly PatchOp[];
}

const MAX_OPS = 100;

export const patchTool: Tool = {
  schema: {
    name: "files.patch",
    description: "Apply line-based insert/delete/replace ops to a workspace file.",
    permission: "write",
    input: {
      type: "object",
      required: ["path", "ops"],
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "target path inside a writable workspace root" },
        ops: {
          type: "array",
          items: {
            type: "object",
            required: ["type", "lineNumber"],
            additionalProperties: false,
            properties: {
              type: { type: "string", description: "insert | delete | replace" },
              lineNumber: { type: "integer", description: "1-based line; insert places the new line before it" },
              text: { type: "string", description: "required for insert and replace" },
            },
          },
        },
      },
    },
  },
  async execute(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
    const req = input as PatchInput;
    if (ctx.signal.aborted) return toolFailure("TOOL_CANCELLED", "run cancelled before patching");
    if (req.ops.length === 0) return toolFailure("TOOL_VALIDATION_FAILED", "patch must contain at least one op");
    if (req.ops.length > MAX_OPS) {
      return toolFailure("TOOL_LIMIT_EXCEEDED", `patch has ${req.ops.length} ops; exceeds the ${MAX_OPS} ceiling`);
    }
    for (const op of req.ops) {
      if (!Number.isInteger(op.lineNumber) || op.lineNumber < 1) {
        return toolFailure("TOOL_VALIDATION_FAILED", `invalid lineNumber: ${String(op.lineNumber)}`);
      }
      if ((op.type === "insert" || op.type === "replace") && typeof op.text !== "string") {
        return toolFailure("TOOL_VALIDATION_FAILED", `op of type ${op.type} requires a text field`);
      }
      if (op.type !== "insert" && op.type !== "delete" && op.type !== "replace") {
        return toolFailure("TOOL_VALIDATION_FAILED", `unknown op type: ${String(op.type)}`);
      }
    }
    const resolved = ctx.workspace.resolveWrite(req.path);
    let before: string;
    try {
      before = readTextBounded(resolved, ctx.workspace.maxReadBytes).text;
    } catch {
      return toolFailure("ARTIFACT_READ_FAILED", `cannot read ${resolved}: not a file or unreadable`);
    }
    // `insert` past the end (lineNumber == lines+1) appends; anything beyond is refused.
    const lines = before.split("\n");
    for (const op of req.ops) {
      if (op.type === "insert") {
        if (op.lineNumber > lines.length + 1) {
          return toolFailure("TOOL_EXECUTION_FAILED", `insert at line ${op.lineNumber} is past the end of a ${lines.length}-line file`);
        }
      } else if (op.lineNumber > lines.length) {
        return toolFailure("TOOL_EXECUTION_FAILED", `${op.type} at line ${op.lineNumber} is past the end of a ${lines.length}-line file`);
      }
    }

    // Apply highest line numbers first so earlier addresses stay valid.
    const ordered = [...req.ops].sort((a, b) => b.lineNumber - a.lineNumber);
    const out = [...lines];
    for (const op of ordered) {
      const idx = op.lineNumber - 1;
      if (op.type === "insert") out.splice(idx, 0, op.text as string);
      else if (op.type === "delete") out.splice(idx, 1);
      else out.splice(idx, 1, op.text as string);
    }
    const after = out.join("\n");
    try {
      writeFileSync(resolved, after, "utf8");
    } catch {
      return toolFailure("ARTIFACT_WRITE_FAILED", `failed to write ${resolved}`);
    }
    return {
      ok: true,
      content: [{ type: "diff", path: resolved, diff: lineDiff(resolved, before, after) }],
      metadata: { path: resolved, ops: req.ops.length },
    };
  },
};
