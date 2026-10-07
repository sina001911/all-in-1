/**
 * OpenAI-compatible adapter suite (P4): the real call path, driven entirely
 * through an injected transport so no network is ever opened.
 *
 * Pinned properties:
 * - the request shape is the Chat Completions contract;
 * - the credential is sent only as a Bearer header, and can never reach an
 *   error message or a log line;
 * - every HTTP failure class maps to a typed, retryability-correct error.
 */
import { afterEach, describe, expect, it } from "vitest";
import { OpenAICompatibleAdapter } from "../src/execution/openai-compatible-adapter.ts";
import type { HttpTransport, HttpResponse } from "../src/execution/types.ts";
import { AllInOneError } from "../src/errors.ts";

const KEY_NAME = "AIO_TEST_OAI_KEY";

afterEach(() => {
  delete process.env[KEY_NAME];
});

interface Recorded {
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

function transport(
  respond: () => HttpResponse,
  recorder: { recorded: Recorded[] },
): HttpTransport {
  return {
    async post(url, body, headers): Promise<HttpResponse> {
      recorder.recorded.push({ url, body, headers });
      return respond();
    },
  };
}

function makeAdapter(
  respond: () => HttpResponse,
  recorder: { recorded: Recorded[] },
  opts: { endpoint?: string; capabilities?: readonly string[] } = {},
): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    id: "acme",
    displayName: "Acme",
    endpoint: opts.endpoint ?? "https://api.acme.test/v1",
    apiKeyEnv: KEY_NAME,
    capabilities: opts.capabilities ?? ["CODING"],
    transport: transport(respond, recorder),
    retryBackoffMs: 0,
  });
}

function ok(content: string, usage = { prompt_tokens: 10, completion_tokens: 5 }): HttpResponse {
  return {
    status: 200,
    body: {
      choices: [{ message: { content }, finish_reason: "stop" }],
      usage,
    },
  };
}

describe("openai-compatible adapter: request shape", () => {
  it("posts a Chat Completions payload and sends the key only as a Bearer header", async () => {
    process.env[KEY_NAME] = "sk-secret-value";
    const rec = { recorded: [] as Recorded[] };
    const adapter = makeAdapter(() => ok("hi"), rec);
    await adapter.invoke({
      model: "acme/gpt-ish",
      capability: "CODING",
      inputs: [{ kind: "text", text: "hello" }],
    });
    const call = rec.recorded[0] as Recorded;
    expect(call.url).toBe("https://api.acme.test/v1/chat/completions");
    expect(call.headers["Authorization"]).toBe("Bearer sk-secret-value");
    expect(call.headers["Content-Type"]).toBe("application/json");
    const body = call.body as { model: string; messages: unknown[] };
    expect(body.model).toBe("gpt-ish"); // provider prefix stripped
    expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("requests JSON output when a structured schema is given", async () => {
    process.env[KEY_NAME] = "sk-secret-value";
    const rec = { recorded: [] as Recorded[] };
    const adapter = makeAdapter(() => ok('{"answer":42}'), rec);
    const result = await adapter.invoke({
      model: "acme/gpt-ish",
      capability: "CODING",
      inputs: [{ kind: "text", text: "compute" }],
      structuredOutputSchema: { type: "object" },
    });
    const body = rec.recorded[0]?.body as { response_format: { type: string } };
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(result.structured).toEqual({ answer: 42 });
  });
});

describe("openai-compatible adapter: success", () => {
  it("returns the completion text and finish reason", async () => {
    process.env[KEY_NAME] = "sk-secret-value";
    const rec = { recorded: [] as Recorded[] };
    const adapter = makeAdapter(() => ok("42"), rec);
    const result = await adapter.invoke({
      model: "acme/gpt-ish",
      capability: "CODING",
      inputs: [{ kind: "text", text: "answer" }],
    });
    expect(result.ok).toBe(true);
    expect(result.text).toBe("42");
    expect(result.finishReason).toBe("stop");
    expect(result.modelId).toBe("acme/gpt-ish");
    expect(result.providerId).toBe("acme");
  });
});

describe("openai-compatible adapter: typed failures", () => {
  it("maps 401/403 to CREDENTIAL_UNAVAILABLE (not retryable)", async () => {
    process.env[KEY_NAME] = "sk-secret-value";
    const rec = { recorded: [] as Recorded[] };
    const adapter = makeAdapter(() => ({ status: 401, body: { error: "bad key" } }), rec);
    await expect(
      adapter.invoke({
        model: "acme/gpt-ish",
        capability: "CODING",
        inputs: [{ kind: "text", text: "x" }],
      }),
    ).rejects.toMatchObject({
      code: "CREDENTIAL_UNAVAILABLE",
      category: "unavailable",
      retryable: false,
    });
  });

  it("maps 429 to PROVIDER_RATE_LIMITED (retryable)", async () => {
    process.env[KEY_NAME] = "sk-secret-value";
    const rec = { recorded: [] as Recorded[] };
    const adapter = makeAdapter(() => ({ status: 429, body: {} }), rec);
    await expect(
      adapter.invoke({
        model: "acme/gpt-ish",
        capability: "CODING",
        inputs: [{ kind: "text", text: "x" }],
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_RATE_LIMITED",
      category: "unavailable",
      retryable: true,
    });
  });

  it("maps 5xx to PROVIDER_UNREACHABLE (retryable)", async () => {
    process.env[KEY_NAME] = "sk-secret-value";
    const rec = { recorded: [] as Recorded[] };
    const adapter = makeAdapter(() => ({ status: 503, body: {} }), rec);
    await expect(
      adapter.invoke({
        model: "acme/gpt-ish",
        capability: "CODING",
        inputs: [{ kind: "text", text: "x" }],
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_UNREACHABLE",
      category: "unavailable",
      retryable: true,
    });
  });

  it("maps other non-2xx to PROVIDER_CALL_FAILED (not retryable)", async () => {
    process.env[KEY_NAME] = "sk-secret-value";
    const rec = { recorded: [] as Recorded[] };
    const adapter = makeAdapter(() => ({ status: 418, body: {} }), rec);
    await expect(
      adapter.invoke({
        model: "acme/gpt-ish",
        capability: "CODING",
        inputs: [{ kind: "text", text: "x" }],
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_CALL_FAILED",
      category: "unavailable",
      retryable: false,
    });
  });

  it("maps an empty completion to PROVIDER_CALL_FAILED", async () => {
    process.env[KEY_NAME] = "sk-secret-value";
    const rec = { recorded: [] as Recorded[] };
    const adapter = makeAdapter(() => ({ status: 200, body: { choices: [] } }), rec);
    await expect(
      adapter.invoke({
        model: "acme/gpt-ish",
        capability: "CODING",
        inputs: [{ kind: "text", text: "x" }],
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_CALL_FAILED" });
  });

  it("maps a transport error to PROVIDER_UNREACHABLE without leaking the key", async () => {
    process.env[KEY_NAME] = "sk-secret-value-long-opaque-token-1234567890";
    const rec = { recorded: [] as Recorded[] };
    const failing: HttpTransport = {
      async post(): Promise<HttpResponse> {
        throw new TypeError(`connect failed for Bearer sk-secret-value-long-opaque-token-1234567890`);
      },
    };
    const adapter = new OpenAICompatibleAdapter({
      id: "acme",
      displayName: "Acme",
      endpoint: "https://api.acme.test/v1",
      apiKeyEnv: KEY_NAME,
      capabilities: ["CODING"],
      transport: failing,
    });
    await expect(
      adapter.invoke({
        model: "acme/gpt-ish",
        capability: "CODING",
        inputs: [{ kind: "text", text: "x" }],
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNREACHABLE" });
  });
});

describe("openai-compatible adapter: credential handling", () => {
  it("throws CREDENTIAL_UNAVAILABLE when the key is absent", async () => {
    delete process.env[KEY_NAME];
    const rec = { recorded: [] as Recorded[] };
    const adapter = makeAdapter(() => ok("hi"), rec);
    await expect(
      adapter.invoke({
        model: "acme/gpt-ish",
        capability: "CODING",
        inputs: [{ kind: "text", text: "x" }],
      }),
    ).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
    expect(rec.recorded).toHaveLength(0); // no request was attempted
  });

  it("the key never appears in an error message", async () => {
    process.env[KEY_NAME] = "sk-secret-value-long-opaque-token-1234567890";
    const failing: HttpTransport = {
      async post(): Promise<HttpResponse> {
        throw new Error("connection reset");
      },
    };
    const adapter = new OpenAICompatibleAdapter({
      id: "acme",
      displayName: "Acme",
      endpoint: "https://api.acme.test/v1",
      apiKeyEnv: KEY_NAME,
      capabilities: ["CODING"],
      transport: failing,
    });
    try {
      await adapter.invoke({
        model: "acme/gpt-ish",
        capability: "CODING",
        inputs: [{ kind: "text", text: "x" }],
      });
      expect.fail("expected a failure");
    } catch (e) {
      const err = e as AllInOneError;
      expect(err.message).not.toContain("sk-secret-value");
    }
  });
});
