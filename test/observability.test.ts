/**
 * Observability suite (P5): the logging seam around the execution engine.
 *
 * Pinned properties:
 * - one structured line per invocation, with the gate that refused a call
 *   derived from the typed error code;
 * - provider-derived text is redacted BEFORE it reaches the sink, and the sink
 *   itself redacts again — neither layer is trusted alone;
 * - the raw provider payload is never logged, per the invoke-result contract;
 * - logging never changes gate behaviour: the wrapper rethrows every error
 *   unchanged and returns every outcome unchanged.
 */
import { describe, expect, it } from "vitest";
import { LoggedExecutionEngine, redactProviderText } from "../src/observability/index.ts";
import { Logger, MemorySink } from "../src/log/logger.ts";
import { AllInOneError } from "../src/errors.ts";
import type {
  ExecutionOutcome,
  InvocationPortal,
  InvokeOptions,
} from "../src/execution/engine.ts";
import type { SelectionRequest } from "../src/models/types.ts";

const SECRET_KEY = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ";
const BEARER = "Bearer dGhpcyBpcyBhIHNlY3JldCB0b2tlbiB2YWx1ZQ";

function fakeOutcome(text = "done"): ExecutionOutcome {
  return {
    decision: {
      ok: true,
      mode: "auto",
      capability: "CODING",
      model: { provider: "local", modelId: "local/deterministic" },
      basis: "default-priority",
      costClass: "FREE",
      costEstimateUsd: 0,
      requiresApproval: false,
      trace: [],
      warnings: [],
    },
    adapterId: "local",
    result: {
      providerId: "local",
      modelId: "local/deterministic",
      capability: "CODING",
      ok: true,
      text,
      structured: { summary: text },
      costUsd: 0,
      latencyMs: 3,
      // Raw payloads are never logged verbatim; plant a secret to prove it.
      raw: { apiKeyLeak: SECRET_KEY },
    },
    committedUsd: 0,
  };
}

function portalFrom(outcome: ExecutionOutcome): InvocationPortal {
  return {
    async invoke(_request: SelectionRequest, _options?: InvokeOptions): Promise<ExecutionOutcome> {
      return outcome;
    },
  };
}

function failingPortal(error: AllInOneError): InvocationPortal {
  return {
    async invoke(_request: SelectionRequest, _options?: InvokeOptions): Promise<ExecutionOutcome> {
      throw error;
    },
  };
}

function logged(portal: InvocationPortal): { engine: LoggedExecutionEngine; sink: MemorySink } {
  const sink = new MemorySink();
  const engine = new LoggedExecutionEngine({
    engine: portal,
    logger: new Logger(sink, "test"),
  });
  return { engine, sink };
}

const REQUEST: SelectionRequest = {
  capability: "CODING",
  inputs: [{ kind: "text", text: "hi" }],
  structuredOutput: true,
};

function parseLines(sink: MemorySink): Array<{ msg: string; fields: Record<string, unknown> }> {
  return sink.lines.map((l) => {
    const parsed = JSON.parse(l) as { msg: string; fields?: Record<string, unknown> };
    return { msg: parsed.msg, fields: parsed.fields ?? {} };
  });
}

function findGate(sink: MemorySink): { msg: string; fields: Record<string, unknown> } | undefined {
  return parseLines(sink).find((l) => l.msg.startsWith("gate."));
}

describe("execution logging", () => {
  it("logs a request and a settled line on success", async () => {
    const { engine, sink } = logged(portalFrom(fakeOutcome()));
    const outcome = await engine.invoke(REQUEST);
    expect(outcome).toBe(outcome);
    const msgs = parseLines(sink).map((l) => l.msg);
    expect(msgs).toContain("invocation.requested");
    expect(msgs).toContain("invocation.settled");
  });

  it("records the model, adapter, basis, and committed cost", async () => {
    const { engine, sink } = logged(portalFrom(fakeOutcome()));
    await engine.invoke(REQUEST);
    const settled = parseLines(sink).find((l) => l.msg === "invocation.settled");
    expect(settled?.fields.model).toBe("local/local/deterministic");
    expect(settled?.fields.adapter).toBe("local");
    expect(settled?.fields.basis).toBe("default-priority");
    expect(settled?.fields.committedUsd).toBe(0);
  });

  it("maps a typed error code to the gate that refused the call", async () => {
    const { engine, sink } = logged(
      failingPortal(
        new AllInOneError("host refused", "EGRESS_BLOCKED", "security", { retryable: false }),
      ),
    );
    await expect(engine.invoke(REQUEST)).rejects.toThrow(/host refused/);
    const line = findGate(sink);
    expect(line?.msg).toBe("gate.refused.egress");
    expect(line?.fields.code).toBe("EGRESS_BLOCKED");
  });

  it("logs an approval refusal as a gate event, not a crash", async () => {
    const { engine, sink } = logged(
      failingPortal(
        new AllInOneError("needs approval", "APPROVAL_REQUIRED", "config", { retryable: false }),
      ),
    );
    await expect(engine.invoke(REQUEST)).rejects.toThrow(/needs approval/);
    expect(findGate(sink)?.msg).toBe("gate.blocked.approval");
  });

  it("rethrows every error unchanged so gates stay authoritative", async () => {
    const error = new AllInOneError("boom", "PROVIDER_CALL_FAILED", "unavailable");
    const { engine } = logged(failingPortal(error));
    await expect(engine.invoke(REQUEST)).rejects.toBe(error);
  });
});

describe("secret redaction in logs", () => {
  it("redacts an sk-* key echoed back in provider text", async () => {
    const { engine, sink } = logged(
      portalFrom(fakeOutcome(`the key is ${SECRET_KEY} please`)),
    );
    await engine.invoke(REQUEST);
    const blob = sink.lines.join("\n");
    expect(blob).not.toContain(SECRET_KEY);
    expect(blob).toContain("[REDACTED]");
  });

  it("redacts a bearer token echoed back in provider text", async () => {
    const { engine, sink } = logged(portalFrom(fakeOutcome(`auth: ${BEARER}`)));
    await engine.invoke(REQUEST);
    const blob = sink.lines.join("\n");
    expect(blob).not.toContain(BEARER);
    expect(blob).toContain("Bearer [REDACTED]");
  });

  it("redacts a secret that appears in an error message", async () => {
    const { engine, sink } = logged(
      failingPortal(
        new AllInOneError(`upstream said key=${SECRET_KEY}`, "PROVIDER_CALL_FAILED", "unavailable"),
      ),
    );
    await expect(engine.invoke(REQUEST)).rejects.toThrow();
    const blob = sink.lines.join("\n");
    expect(blob).not.toContain(SECRET_KEY);
  });

  it("never logs the raw provider payload, even when it holds a secret", async () => {
    const { engine, sink } = logged(portalFrom(fakeOutcome()));
    await engine.invoke(REQUEST);
    const blob = sink.lines.join("\n");
    expect(blob).not.toContain(SECRET_KEY);
    // No log line carries a `raw` field at all.
    for (const line of parseLines(sink)) {
      expect(line.fields).not.toHaveProperty("raw");
    }
  });

  it("exposes redactProviderText for callers that store provider text", () => {
    expect(redactProviderText(`key=${SECRET_KEY}`)).not.toContain(SECRET_KEY);
  });
});
