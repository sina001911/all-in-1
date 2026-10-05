/**
 * CLI acceptance suite (P4): pins the zero-config execution surface.
 *
 * Runs the real CLI as a subprocess so the entry point itself is exercised —
 * argument parsing, the offline stack wiring, and the JSON contract a user
 * scripts against. Everything here runs offline: no remote provider is
 * registered, egress is deny-all, and the budget is 0.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "src", "cli.ts");

function run(...args: string[]): { status: number; stdout: string; stderr: string } {
  const out = execFileSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: 0, stdout: out, stderr: "" };
}

function runAllowFailure(...args: string[]): {
  status: number;
  stdout: string;
  stderr: string;
} {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout: out, stderr: "" };
  } catch (e) {
    const err = e as {
      stdout?: string;
      stderr?: string;
      status?: number;
    };
    return {
      status: err.status ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

describe("cli select", () => {
  it("selects the deterministic local model for CODING", () => {
    const { status, stdout } = run("select", "CODING");
    expect(status).toBe(0);
    const decision = JSON.parse(stdout) as { ok: boolean; model: { provider: string; modelId: string }; costClass: string };
    expect(decision.ok).toBe(true);
    expect(decision.model.provider).toBe("local");
    expect(decision.costClass).toBe("FREE");
  });

  it("exits 1 and explains why a media-gated capability is unavailable", () => {
    const { status, stdout } = runAllowFailure("select", "IMAGE_GENERATION");
    expect(status).toBe(1);
    const decision = JSON.parse(stdout) as { ok: boolean; warnings: string[] };
    expect(decision.ok).toBe(false);
    expect(decision.warnings.some((w) => w.includes("media-gated"))).toBe(true);
  });
});

describe("cli invoke", () => {
  it("executes end to end offline and echoes the input deterministically", () => {
    const { status, stdout } = run("invoke", "CODING", "--text", "hello from the cli");
    expect(status).toBe(0);
    const outcome = JSON.parse(stdout) as {
      ok: boolean;
      model: { provider: string; modelId: string };
      adapter: string;
      committedUsd: number;
      text: string;
    };
    expect(outcome.ok).toBe(true);
    expect(outcome.model.provider).toBe("local");
    expect(outcome.adapter).toBe("local");
    expect(outcome.committedUsd).toBe(0);
    expect(outcome.text).toContain("hello from the cli");
  });

  it("produces identical output for identical input", () => {
    const a = run("invoke", "CODING", "--text", "stable input");
    const b = run("invoke", "CODING", "--text", "stable input");
    expect(b.stdout).toBe(a.stdout);
  });

  it("exits 1 with SELECTION_FAILED for an unknown capability", () => {
    const { status, stderr, stdout } = runAllowFailure("invoke", "NO_SUCH_CAPABILITY");
    expect(status).toBe(1);
    const blob = stdout + stderr;
    expect(blob).toContain("SELECTION_FAILED");
  });
});
