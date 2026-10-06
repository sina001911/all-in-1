/**
 * files.read (D2). Reads text from inside a workspace root.
 *
 * The path is resolved through the workspace manager, so traversal, symlink
 * escapes, and application-owned paths are refused before any read happens. The
 * read is bounded by the workspace byte ceiling and truncated on a UTF-8
 * boundary, so neither a huge file nor a half-multibyte sequence can reach the
 * model.
 */
import { readFileSync } from "node:fs";
import type { Tool, ToolContext, ToolOutput } from "../types.ts";
import { readTextBounded, toolFailure } from "./util.ts";

interface ReadInput {
  readonly path: string;
  readonly encoding?: "utf8" | "base64";
  readonly maxBytes?: number;
  /** 1-based first line to return (text encoding only). */
  readonly offsetLine?: number;
  /** Maximum number of lines to return (text encoding only). */
  readonly limitLines?: number;
}

const MAX_BASE64 = 4 * 1024 * 1024;

export const readTool: Tool = {
  schema: {
    name: "files.read",
    description: "Read a file inside the workspace as text, or base64 for binary.",
    permission: "read",
    input: {
      type: "object",
      required: ["path"],
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "absolute path, or relative to the first workspace root" },
        encoding: { type: "string", description: "utf8 (default) or base64" },
        maxBytes: { type: "integer", description: "byte ceiling for the read" },
        offsetLine: { type: "integer", description: "1-based first line to return" },
        limitLines: { type: "integer", description: "maximum number of lines to return" },
      },
    },
  },
  async execute(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
    const req = input as ReadInput;
    if (ctx.signal.aborted) return toolFailure("TOOL_CANCELLED", "run cancelled before reading");
    const resolved = ctx.workspace.resolveRead(req.path);
    const ceiling = Math.min(
      req.maxBytes ?? ctx.workspace.maxReadBytes,
      ctx.workspace.maxReadBytes,
    );
    if (req.encoding === "base64") {
      const buf = readFileSync(resolved);
      if (buf.length > Math.min(MAX_BASE64, ceiling)) {
        return toolFailure("TOOL_LIMIT_EXCEEDED", `file is ${buf.length} bytes; exceeds the base64 read ceiling`);
      }
      return { ok: true, content: [{ type: "text", text: buf.toString("base64") }], metadata: { bytes: buf.length } };
    }
    const read = readTextBounded(resolved, ceiling);
    let text = read.text;
    if (req.offsetLine !== undefined || req.limitLines !== undefined) {
      const lines = text.split("\n");
      const start = Math.max(1, req.offsetLine ?? 1) - 1;
      const count = req.limitLines ?? lines.length;
      text = lines.slice(start, start + count).join("\n");
    }
    if (ctx.signal.aborted) return toolFailure("TOOL_CANCELLED", "run cancelled during read");
    return {
      ok: true,
      content: [{ type: "text", text }],
      metadata: { bytes: read.bytes, truncated: read.truncated, path: resolved },
    };
  },
};
