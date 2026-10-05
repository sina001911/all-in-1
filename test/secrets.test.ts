/**
 * Secrets suite: the layer never handles a secret value. Env is referenced by
 * NAME only; redaction scrubs token-like values before they reach any sink.
 */
import { describe, expect, it } from "vitest";
import { envRef, KNOWN_ENV_REFS } from "../src/config/env.ts";
import { isSecretLike, redact } from "../src/log/redact.ts";
import { Logger, MemorySink } from "../src/log/logger.ts";

describe("environment references", () => {
  it("only accepts well-formed variable NAMES", () => {
    expect(envRef("OPENROUTER_API_KEY").name).toBe("OPENROUTER_API_KEY");
    expect(() => envRef("not-a-name")).toThrow(/Invalid environment variable name/);
  });

  it("exposes the vision provider key as a name only", () => {
    expect(KNOWN_ENV_REFS.openrouterApiKey.name).toBe("OPENROUTER_API_KEY");
  });
});

describe("redaction", () => {
  it("flags opaque, sk-*, and hex secrets", () => {
    expect(isSecretLike("sk-or-v1-0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isSecretLike("a".repeat(48))).toBe(true);
    expect(isSecretLike("f".repeat(64))).toBe(true);
    expect(isSecretLike("normal text")).toBe(false);
  });

  it("scrubs bearer tokens and long tokens", () => {
    expect(redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCD")).toContain(
      "[REDACTED]",
    );
    expect(redact("token: sk-or-v1-0123456789abcdef0123456789abcdef")).toContain("[REDACTED]");
    expect(redact("hex: " + "f".repeat(64))).toContain("[REDACTED]");
  });

  it("preserves ordinary messages", () => {
    expect(redact("detected vite project with confidence 0.95")).toBe(
      "detected vite project with confidence 0.95",
    );
  });
});

describe("logger", () => {
  it("never writes a raw secret to the sink", () => {
    const sink = new MemorySink();
    const logger = new Logger(sink, "run-1");
    logger.info("using key", { key: "sk-or-v1-0123456789abcdef0123456789abcdef" });
    const line = sink.lines[0];
    expect(line).not.toContain("sk-or-v1");
    expect(line).toContain("[REDACTED]");
  });

  it("emits structured JSONL with a run id", () => {
    const sink = new MemorySink();
    const logger = new Logger(sink, "run-1");
    logger.warn("budget low", { remainingUsd: 0 });
    const parsed = JSON.parse(sink.lines[0]) as { runId: string; level: string };
    expect(parsed.runId).toBe("run-1");
    expect(parsed.level).toBe("warn");
  });
});
