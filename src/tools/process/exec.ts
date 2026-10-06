/**
 * process.exec (D2). Controlled, shell-free process execution.
 *
 * Threat model: the model is untrusted, the UI is untrusted. Execution is the
 * most privileged thing the runtime can do on their behalf, so four independent
 * controls apply, and none of them may be satisfied by the model:
 *
 *   1. No shell. The executable is resolved by the runtime and spawned directly
 *      with an argument array, so an argument can never become a command.
 *   2. Closed executable set. The command name (or the basename of an absolute
 *      path inside a workspace) must be on the allowlist. A model cannot
 *      discover and run an arbitrary binary; a project-local binary is
 *      admissible only by basename, so a script written into the workspace
 *      cannot be executed unless its interpreter is already allowlisted.
 *   3. Catastrophic patterns are refused outright, defense in depth behind the
 *      allowlist.
 *   4. Human approval + audit. Execution always requires an approved human
 *      decision, and the exact command line is recorded in the audit trail.
 *
 * The working directory is resolved inside a workspace root. The environment is
 * the process environment with secret-looking names stripped, so a credential
 * held in the environment can never leak into a child the model asked for.
 *
 * Execution is inherently privileged: a process is not sandboxed at the OS
 * level, and the honest controls here are the allowlist, the approval, and the
 * audit — not a job object. That boundary is why approval can never be skipped.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { delimiter, isAbsolute, join } from "node:path";
import { existsSync, statSync } from "node:fs";
import type { Tool, ToolContext, ToolOutput } from "../types.ts";
import { toolFailure } from "../files/util.ts";

interface ExecInput {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly captureBytes?: number;
}

const SUSPECT_ENV = /(?:key|token|secret|password|credential|auth)/i;

const DEFAULT_ALLOWLIST: readonly string[] = [
  "node",
  "npx",
  "npm",
  "pnpm",
  "yarn",
  "tsc",
  "vitest",
  "esbuild",
  "prettier",
  "eslint",
  "python",
  "py",
  "go",
  "cargo",
  "make",
  "cmake",
  "git",
  "ls",
  "dir",
  "type",
  "cat",
  "echo",
  "pwd",
  "where",
  "which",
  "findstr",
  "grep",
  "sort",
  "head",
  "tail",
  "wc",
  "mkdir",
  "touch",
  "cp",
  "mv",
];

/** Irreversible, system-wide operations. Refused regardless of the allowlist. */
const DENY_PATTERNS: readonly RegExp[] = [
  /\brm\s+-[rf]+\s+\/(\s|$|\/)/,
  /\brm\s+-[rf]+\s+\/(?:etc|usr|var|bin|boot|proc|sys|root)\b/,
  /\brm\s+-[rf]+\s+[a-z]:\\/i,
  /\brmdir\s+\/s\b/i,
  /\bdel\s+\/[fsq]/i,
  /\bformat\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bhalt\b/i,
  /\bpoweroff\b/i,
  /\bdiskpart\b/i,
  /\bfdisk\b/i,
  /\bmkfs\b/i,
  /\breg\s+(?:add|delete|import|load|restore)\b/i,
  /\btakeown\b/i,
  /\bicacls\b/i,
  /\bcacls\b/i,
  /\bcipher\b/i,
  /\b(?:curl|wget|invoke-webrequest|iex|invoke-expression)\b/i,
  /\:\(\)\s*\{\s*\:\s*\|\s*\:\s*&\s*\}\s*;\s*\:/,
];

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_CAPTURE = 64 * 1024;
const MAX_CAPTURE = 256 * 1024;

export interface ExecToolOptions {
  readonly allowlist?: readonly string[];
}

export function createExecTool(opts: ExecToolOptions = {}): Tool {
  const allowlist = opts.allowlist ?? DEFAULT_ALLOWLIST;
  const allowSet = new Set(allowlist.map((c) => c.toLowerCase()));

  const tool: Tool = {
    schema: {
      name: "process.exec",
      description: "Run an allowlisted command inside the workspace without a shell.",
      permission: "execute",
      timeoutMs: DEFAULT_TIMEOUT_MS,
      input: {
        type: "object",
        required: ["command"],
        additionalProperties: false,
        properties: {
          command: { type: "string", description: "allowlisted executable name, or a path inside the workspace" },
          args: { type: "array", items: { type: "string" }, description: "command arguments (never parsed by a shell)" },
          cwd: { type: "string", description: "working directory inside the workspace" },
          timeoutMs: { type: "integer", description: "hard timeout in milliseconds" },
          captureBytes: { type: "integer", description: "byte ceiling per output stream" },
        },
      },
    },

    async execute(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
      const req = input as ExecInput;
      if (ctx.signal.aborted) return toolFailure("TOOL_CANCELLED", "run cancelled before executing");
      const args = [...(req.args ?? [])];
      const joined = `${req.command} ${args.join(" ")}`;
      for (const pattern of DENY_PATTERNS) {
        if (pattern.test(joined)) {
          return toolFailure("TOOL_PERMISSION_DENIED", `refused: the command matches a denied pattern`);
        }
      }

      const executable = resolveExecutable(req.command, allowSet, ctx);
      if ("error" in executable) {
        return toolFailure(executable.code, executable.message);
      }

      const cwd = req.cwd ? ctx.workspace.resolveRead(req.cwd) : firstRoot(ctx);
      if (!cwd) return toolFailure("TOOL_PERMISSION_DENIED", "no workspace root is configured");

      const env = sanitizeEnv(process.env);
      const capture = Math.min(req.captureBytes ?? DEFAULT_CAPTURE, MAX_CAPTURE);
      const timeoutMs = Math.min(req.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

      return new Promise<ToolOutput>((resolve) => {
        let child: ChildProcess;
        try {
          child = spawn(executable.path, args, {
            cwd,
            env,
            windowsHide: true,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch {
          resolve(toolFailure("TOOL_EXECUTION_FAILED", `failed to spawn ${req.command}`));
          return;
        }
        if (!child.pid) {
          resolve(toolFailure("TOOL_EXECUTION_FAILED", `${req.command} did not start`));
          return;
        }

        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const finish = (out: ToolOutput) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          ctx.signal.removeEventListener("abort", onAbort);
          try {
            child.stdout?.destroy();
            child.stderr?.destroy();
          } catch {
            /* already closed */
          }
          resolve(out);
        };

        function onAbort() {
          killTree(child);
          finish(toolFailure("TOOL_CANCELLED", `${req.command} was cancelled by the caller`));
        }

        child.stdout?.on("data", (chunk: Buffer) => {
          if (stdoutBytes < capture) {
            stdout.push(chunk.subarray(0, capture - stdoutBytes));
            stdoutBytes += chunk.length;
          }
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          if (stderrBytes < capture) {
            stderr.push(chunk.subarray(0, capture - stderrBytes));
            stderrBytes += chunk.length;
          }
        });

        child.on("error", () => {
          finish(toolFailure("TOOL_EXECUTION_FAILED", `${req.command} failed to run`));
        });

        child.on("close", (code, signal) => {
          const out = Buffer.concat(stdout).toString("utf8");
          const err = Buffer.concat(stderr).toString("utf8");
          if (ctx.signal.aborted) {
            finish(toolFailure("TOOL_CANCELLED", `${req.command} was cancelled by the caller`));
            return;
          }
          if (code !== null && code !== 0) {
            finish({
              ok: false,
              code: "TOOL_EXECUTION_FAILED",
              message: `${req.command} exited with status ${code}${err.length > 0 ? `: ${err.slice(0, 400)}` : ""}`,
            });
            return;
          }
          finish({
            ok: true,
            content: [
              { type: "text", text: out },
              ...(err.length > 0 ? [{ type: "text" as const, text: `[stderr]\n${err}` }] : []),
            ],
            metadata: {
              command: req.command,
              args,
              cwd,
              exitCode: code,
              signal,
              truncated: stdoutBytes > capture || stderrBytes > capture,
            },
          });
        });

        if (ctx.signal.aborted) {
          onAbort();
          return;
        }
        ctx.signal.addEventListener("abort", onAbort);
        timer = setTimeout(() => {
          killTree(child);
          finish(toolFailure("TOOL_TIMEOUT", `${req.command} exceeded the ${timeoutMs}ms timeout`));
        }, timeoutMs);
      });
    },
  };
  return tool;
}

type ExecutableResolution = { path: string } | { error: true; code: string; message: string };

/**
 * Resolve the command to an absolute executable path with no shell involved.
 *
 * A bare name must be on the allowlist, then is located on PATH honouring the
 * platform's executable extensions. An absolute or relative path must resolve
 * inside a workspace root AND its basename must be on the allowlist — the
 * second rule is what stops a model from writing a script into the workspace
 * and executing it.
 */
function resolveExecutable(
  command: string,
  allowSet: Set<string>,
  ctx: ToolContext,
): ExecutableResolution {
  if (command.length === 0) {
    return { error: true, code: "TOOL_VALIDATION_FAILED", message: "command must not be empty" };
  }
  // On Windows an executable carries a PATHEXT suffix (.exe, .cmd, ...). It is
  // part of the platform's naming, not part of the tool's identity, so it is
  // stripped before the allowlist comparison — `node.exe` is `node`.
  const base = command.split(/[\\/]/).pop() as string;
  const stem = process.platform === "win32" ? base.replace(/\.(?:exe|cmd|bat|com)$/i, "") : base;
  if (!allowSet.has(stem.toLowerCase())) {
    return {
      error: true,
      code: "TOOL_PERMISSION_DENIED",
      message: `"${base}" is not on the executable allowlist`,
    };
  }
  if (isAbsolute(command) || /[\\/]/.test(command)) {
    let resolved: string;
    try {
      resolved = ctx.workspace.resolveRead(command);
    } catch {
      return { error: true, code: "PATH_TRAVERSAL_BLOCKED", message: `${command} is outside the workspace` };
    }
    if (!existsSync(resolved) || statSync(resolved).isDirectory()) {
      return { error: true, code: "TOOL_EXECUTION_FAILED", message: `${command} does not exist as an executable` };
    }
    return { path: resolved };
  }
  const onPath = findOnPath(command);
  if (!onPath) {
    return {
      error: true,
      code: "TOOL_EXECUTION_FAILED",
      message: `${command} is allowlisted but was not found on PATH`,
    };
  }
  return { path: onPath };
}

function findOnPath(command: string): string | undefined {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE").split(";") : [""];
  const paths = (process.env.PATH ?? "").split(delimiter).filter((p) => p.length > 0);
  for (const dir of paths) {
    for (const ext of extensions) {
      const candidate = join(dir, `${command}${ext}`);
      if (existsSync(candidate) && !statSync(candidate).isDirectory()) {
        return candidate;
      }
    }
  }
  return undefined;
}

function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (SUSPECT_ENV.test(key)) continue;
    out[key] = value;
  }
  return out;
}

function firstRoot(ctx: ToolContext): string | undefined {
  return ctx.workspace.listRoots()[0];
}

function killTree(child: { pid?: number | null }): void {
  if (!child.pid) return;
  try {
    process.kill(child.pid, "SIGKILL");
  } catch {
    /* the process may already be gone */
  }
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } catch {
      /* best effort tree kill */
    }
  }
}
