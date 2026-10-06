/**
 * Tool registry (D2).
 *
 * An enumerated set of tools, exactly like the IPC channel list: a tool the
 * registry does not contain cannot be invoked, so the capability surface is a
 * closed list rather than an open proxy onto the filesystem.
 *
 * Registration validates the tool's own schema up front (assertSchemaUsable),
 * so a malformed tool is rejected at registration time rather than producing
 * confusing validation failures on every request.
 */
import { assertSchemaUsable } from "../specialists/validator.ts";
import { AllInOneError } from "../errors.ts";
import type { Tool } from "./types.ts";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.schema.name)) {
      throw new AllInOneError(
        `A tool named "${tool.schema.name}" is already registered`,
        "INVALID_CONFIG",
        "config",
      );
    }
    assertSchemaUsable(tool.schema.input);
    this.tools.set(tool.schema.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): readonly Tool[] {
    return [...this.tools.values()].sort((a, b) => a.schema.name.localeCompare(b.schema.name));
  }

  names(): readonly string[] {
    return this.list().map((t) => t.schema.name);
  }
}
