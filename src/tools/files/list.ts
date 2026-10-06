/**
 * files.list (D2). Lists entries inside a workspace directory.
 *
 * Non-recursive by design: a recursive listing of a large tree is a cheap way
 * to exfiltrate structure, so tree walking belongs to `files.search`, which is
 * bounded and pattern-scoped.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Tool, ToolContext, ToolOutput } from "../types.ts";
import { toolFailure } from "./util.ts";

interface ListInput {
  readonly path: string;
  /** Regular expression matched against each entry name. */
  readonly pattern?: string;
  readonly limit?: number;
}

export const listTool: Tool = {
  schema: {
    name: "files.list",
    description: "List entries in a workspace directory, optionally filtered by a name pattern.",
    permission: "read",
    input: {
      type: "object",
      required: ["path"],
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "directory inside the workspace" },
        pattern: { type: "string", description: "regular expression matched against entry names" },
        limit: { type: "integer", description: "maximum number of entries to return" },
      },
    },
  },
  async execute(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
    const req = input as ListInput;
    if (ctx.signal.aborted) return toolFailure("TOOL_CANCELLED", "run cancelled before listing");
    const resolved = ctx.workspace.resolveRead(req.path);
    let names: string[];
    try {
      names = readdirSync(resolved);
    } catch {
      return toolFailure("TOOL_EXECUTION_FAILED", `cannot list ${resolved}: not a directory or unreadable`);
    }
    const limit = Math.min(req.limit ?? 500, 1000);
    let re: RegExp | undefined;
    if (req.pattern) {
      try {
        re = new RegExp(req.pattern);
      } catch {
        return toolFailure("TOOL_VALIDATION_FAILED", `invalid pattern: ${req.pattern}`);
      }
    }
    const entries = names
      .filter((name) => !re || re.test(name))
      .slice(0, limit)
      .map((name) => {
        let kind = "file";
        let size = 0;
        try {
          const st = statSync(join(resolved, name));
          kind = st.isDirectory() ? "dir" : "file";
          size = st.isFile() ? st.size : 0;
        } catch {
          kind = "unreachable";
        }
        return { name, kind, size };
      });
    return {
      ok: true,
      content: [{ type: "json", json: { path: resolved, entries, truncated: names.length > limit } }],
    };
  },
};
