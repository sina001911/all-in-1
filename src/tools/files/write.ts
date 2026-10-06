/**
 * files.write (D2). Writes a file inside a writable workspace root.
 *
 * Requires the write privilege class, hence a human approval, and resolves the
 * target through `resolveWrite` which additionally requires the real parent
 * directory to sit inside a writable root. Parent directories are created only
 * beneath the resolved target, never by an arbitrary path.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Tool, ToolContext, ToolOutput } from "../types.ts";
import { toolFailure } from "./util.ts";

interface WriteInput {
  readonly path: string;
  readonly content: string;
  readonly createDirs?: boolean;
}

const MAX_WRITE = 4 * 1024 * 1024;

export const writeTool: Tool = {
  schema: {
    name: "files.write",
    description: "Write content to a file inside the workspace, overwriting it if it exists.",
    permission: "write",
    input: {
      type: "object",
      required: ["path", "content"],
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "target path inside a writable workspace root" },
        content: { type: "string", description: "the text to write" },
        createDirs: { type: "boolean", description: "create missing parent directories" },
      },
    },
  },
  async execute(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
    const req = input as WriteInput;
    if (ctx.signal.aborted) return toolFailure("TOOL_CANCELLED", "run cancelled before writing");
    if (req.content.length > MAX_WRITE) {
      return toolFailure("TOOL_LIMIT_EXCEEDED", `content is ${req.content.length} characters; exceeds the ${MAX_WRITE} ceiling`);
    }
    const resolved = ctx.workspace.resolveWrite(req.path);
    try {
      if (req.createDirs) mkdirSync(dirname(resolved), { recursive: true });
      writeFileSync(resolved, req.content, "utf8");
    } catch {
      return toolFailure("ARTIFACT_WRITE_FAILED", `failed to write ${resolved}`);
    }
    return {
      ok: true,
      content: [{ type: "text", text: `wrote ${Buffer.byteLength(req.content, "utf8")} bytes to ${resolved}` }],
      metadata: { path: resolved, bytes: Buffer.byteLength(req.content, "utf8") },
    };
  },
};
