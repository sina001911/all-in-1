/**
 * files.search (D2). Bounded recursive content search.
 *
 * Every visited path is resolved through the workspace manager, so a symlinked
 * directory inside the workspace cannot redirect the walk outside it. Both the
 * number of files scanned and the number of matches returned are capped, so a
 * search cannot be used to dump a whole tree into context. Binary files are
 * skipped, and the pattern is compiled up front so a bad regex is a validation
 * error rather than a mid-walk crash.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Tool, ToolContext, ToolOutput } from "../types.ts";
import { looksBinary, toolFailure } from "./util.ts";

interface SearchInput {
  readonly path: string;
  readonly pattern: string;
  readonly multiline?: boolean;
  readonly maxResults?: number;
  readonly maxFiles?: number;
}

interface SearchHit {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly match: string;
}

const DEFAULT_MAX_RESULTS = 50;
const DEFAULT_MAX_FILES = 200;

export const searchTool: Tool = {
  schema: {
    name: "files.search",
    description: "Recursively search file contents inside the workspace for a regular expression.",
    permission: "read",
    input: {
      type: "object",
      required: ["path", "pattern"],
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "directory inside the workspace to search" },
        pattern: { type: "string", description: "regular expression to match against file contents" },
        multiline: { type: "boolean", description: "allow patterns that span lines" },
        maxResults: { type: "integer", description: "maximum matches to return" },
        maxFiles: { type: "integer", description: "maximum files to scan" },
      },
    },
  },
  async execute(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
    const req = input as SearchInput;
    if (ctx.signal.aborted) return toolFailure("TOOL_CANCELLED", "run cancelled before searching");
    const resolved = ctx.workspace.resolveRead(req.path);
    let re: RegExp;
    try {
      re = new RegExp(req.pattern, req.multiline ? "gm" : "g");
    } catch {
      return toolFailure("TOOL_VALIDATION_FAILED", `invalid pattern: ${req.pattern}`);
    }
    const maxResults = Math.min(req.maxResults ?? DEFAULT_MAX_RESULTS, 200);
    const maxFiles = Math.min(req.maxFiles ?? DEFAULT_MAX_FILES, 1000);
    const hits: SearchHit[] = [];
    let scanned = 0;
    let truncated = false;

    const stack: string[] = [resolved];
    while (stack.length > 0 && hits.length < maxResults && scanned < maxFiles) {
      const dir = stack.pop() as string;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (hits.length >= maxResults || scanned >= maxFiles) {
          truncated = true;
          break;
        }
        const candidate = join(dir, name);
        // Each candidate is re-resolved: a symlinked child is caught here.
        if (!ctx.workspace.isInside(candidate)) continue;
        let st;
        try {
          st = statSync(candidate);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          stack.push(candidate);
          continue;
        }
        if (!st.isFile() || st.size > ctx.workspace.maxReadBytes) continue;
        scanned += 1;
        if (ctx.signal.aborted) return toolFailure("TOOL_CANCELLED", "run cancelled during search");
        const buf = readFileSync(candidate);
        if (looksBinary(buf)) continue;
        const text = buf.toString("utf8");
        const lines = text.split("\n");
        for (let index = 0; index < lines.length && hits.length < maxResults; index++) {
          const line = lines[index] as string;
          re.lastIndex = 0;
          const found = re.exec(line);
          if (!found) continue;
          hits.push({ path: candidate, line: index + 1, text: line.slice(0, 400), match: found[0] });
        }
      }
    }
    truncated = truncated || hits.length >= maxResults || scanned >= maxFiles;
    return {
      ok: true,
      content: [{ type: "json", json: { root: resolved, hits, scannedFiles: scanned, truncated } }],
    };
  },
};
