/**
 * CLI acceptance suite (P5): the specialist and workflow entry points.
 *
 * Runs the real CLI as a subprocess so the entry point itself is exercised —
 * no in-process stubs. stdout must stay machine-readable JSON; the structured
 * JSONL log stream goes to stderr and is checked separately.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "src", "cli.ts");

function run(...args: string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function json<T = Record<string, unknown>>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

describe("cli specialist", () => {
  it("runs a specialist offline and returns validated structured output", () => {
    const { status, stdout } = run("specialist", "CODE_REVIEWER", "--text", "function add(a,b)");
    expect(status).toBe(0);
    const body = json<{ ok: boolean; structured: { summary: string } }>(stdout);
    expect(body.ok).toBe(true);
    expect(body.structured.summary).toContain("function add(a,b)");
  });

  it("validates the output against an inline --schema", () => {
    const schema = JSON.stringify({
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    });
    const { status, stdout } = run("specialist", "FAST_TASK", "--text", "hi", "--schema", schema);
    expect(status).toBe(0);
    expect(json<{ ok: boolean }>(stdout).ok).toBe(true);
  });

  it("reports STRUCTURED_OUTPUT_INVALID when the output misses the schema", () => {
    const schema = JSON.stringify({ type: "object", required: ["doesNotExist"] });
    const { status, stdout } = run("specialist", "FAST_TASK", "--text", "hi", "--schema", schema);
    expect(status).toBe(1);
    const body = json<{ ok: boolean; error: { code: string } }>(stdout);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("STRUCTURED_OUTPUT_INVALID");
  });

  it("reports SPECIALIST_NOT_FOUND for an unregistered role", () => {
    const { status, stdout } = run("specialist", "MEDIA_QA", "--text", "hi");
    expect(status).toBe(1);
    const body = json<{ ok: boolean; error: { code: string } }>(stdout);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("SPECIALIST_NOT_FOUND");
  });

  it("runs a vision specialist from an image artifact reference", () => {
    const { status, stdout } = run("specialist", "VISION", "--image", "shot-1");
    expect(status).toBe(0);
    expect(json<{ ok: boolean }>(stdout).ok).toBe(true);
  });
});

describe("cli workflow modes", () => {
  it("pauses for the human after one step when not autonomous", () => {
    const { status, stdout } = run(
      "workflow",
      "INSPECT",
      "--steps",
      "CODE_REVIEWER,FAST_TASK",
      "--text",
      "check this",
    );
    expect(status).toBe(0);
    const body = json<{
      ok: boolean;
      iterations: number;
      pausedForHuman: boolean;
      auto: boolean;
    }>(stdout);
    expect(body.ok).toBe(true);
    expect(body.iterations).toBe(1);
    expect(body.pausedForHuman).toBe(true);
    expect(body.auto).toBe(false);
  });

  it("refuses planning in INSPECT with MODE_VIOLATION", () => {
    const { status, stdout } = run(
      "workflow",
      "INSPECT",
      "--steps",
      "CODE_REVIEWER",
      "--plan",
      "--text",
      "x",
    );
    expect(status).toBe(1);
    const body = json<{ ok: boolean; error: { code: string } }>(stdout);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("MODE_VIOLATION");
  });

  it("produces a plan in SUGGEST", () => {
    const { status, stdout } = run(
      "workflow",
      "SUGGEST",
      "--steps",
      "CODE_REVIEWER",
      "--plan",
      "--text",
      "x",
    );
    expect(status).toBe(0);
    const body = json<{ ok: boolean; plan: string[] }>(stdout);
    expect(body.ok).toBe(true);
    expect(body.plan.length).toBeGreaterThan(0);
  });

  it("caps --auto at five iterations", () => {
    const tenSteps = Array.from({ length: 10 }, () => "FAST_TASK").join(",");
    const { status, stdout } = run(
      "workflow",
      "BUILD",
      "--steps",
      tenSteps,
      "--auto",
      "true",
      "--text",
      "x",
    );
    expect(status).toBe(1);
    const body = json<{
      ok: boolean;
      iterations: number;
      error: { code: string };
    }>(stdout);
    expect(body.ok).toBe(false);
    expect(body.iterations).toBe(5);
    expect(body.error.code).toBe("WORKFLOW_AUTO_LIMIT");
  });

  it("runs every step under --auto without pausing", () => {
    const { status, stdout } = run(
      "workflow",
      "BUILD",
      "--steps",
      "FAST_TASK,FAST_TASK,FAST_TASK",
      "--auto",
      "true",
      "--text",
      "x",
    );
    expect(status).toBe(0);
    const body = json<{ ok: boolean; iterations: number; pausedForHuman: boolean }>(stdout);
    expect(body.ok).toBe(true);
    expect(body.iterations).toBe(3);
    expect(body.pausedForHuman).toBe(false);
  });
});

describe("cli workflow structured logging", () => {
  it("emits machine-readable JSONL to stderr, never to stdout", () => {
    const { stdout, stderr } = run("workflow", "SUGGEST", "--steps", "FAST_TASK", "--text", "x");
    // stdout is exactly one JSON document.
    expect(() => JSON.parse(stdout)).not.toThrow();
    // stderr carries the JSONL log stream, one entry per line.
    const lines = stderr.trim().split(/\r?\n/).filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const entry = JSON.parse(line) as { level: string; msg: string };
      expect(["debug", "info", "warn", "error"]).toContain(entry.level);
    }
  });

  it("logs an invocation.settled line for a successful specialist run", () => {
    const { stderr } = run("specialist", "FAST_TASK", "--text", "x");
    const msgs = stderr
      .trim()
      .split(/\r?\n/)
      .map((l) => (JSON.parse(l) as { msg: string }).msg);
    expect(msgs).toContain("invocation.settled");
  });
});
