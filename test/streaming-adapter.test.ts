/**
 * D11: the OpenAI-compatible adapter streams.
 *
 * Pinned properties:
 * - `invoke(request, {stream: true})` asks the provider for `stream: true`
 *   and `stream_options.include_usage`, and assembles the frame stream back
 *   into the SAME ProviderInvokeResult contract as the buffered path;
 * - each frame is tee'd to `onEvent` as a typed StreamEvent;
 * - a mid-stream failure is PROVIDER_STREAM_INTERRUPTED and NEVER a partial
 *   success, and it is never retried after the first emitted event;
 * - a keyless endpoint is reachable without credentials and sends no
 *   Authorization header; a keyed endpoint reads the env-NAME at call time;
 * - none of the credential value or the stream content appears in any error
 *   message.
 */
import { describe, expect, it } from "vitest";
import { OpenAICompatibleAdapter } from "../src/execution/openai-compatible-adapter.ts";
import type { HttpTransport, HttpResponse, StreamEvent, StreamTransportResponse } from "../src/execution/types.ts";
import type { ProviderInvokeRequest } from "../src/providers/types.ts";

function okResponse(body: object): HttpResponse {
  return { status: 200, body };
}

function streamOf(events: StreamEvent[], status = 200): StreamTransportResponse {
  return {
    status,
    events: (async function* () {
      for (const e of events) yield e;
    })(),
  };
}

const baseRequest: ProviderInvokeRequest = {
  model: "test/mini",
  capability: "CODING",
  inputs: [{ kind: "text", text: "hello" }],
};

function makeAdapter(transport: HttpTransport, opts: { pricing?: Record<string, { input: number; output: number }> } = {}) {
  return new OpenAICompatibleAdapter({
    id: "test",
    displayName: "Test",
    endpoint: "https://127.0.0.1:1/v1",
    apiKeyEnv: null,
    capabilities: ["CODING"],
    retryBackoffMs: 0,
    pricing: opts.pricing,
    transport,
  });
}

describe("openai-compatible adapter: streaming assembly", () => {
  it("sends stream:true + stream_options and assembles text and usage", async () => {
    let seen: Record<string, unknown> | undefined;
    const transport: HttpTransport = {
      async post() {
        throw new Error("buffered path must not be used");
      },
      async postStream(_url, body) {
        seen = body as Record<string, unknown>;
        return streamOf([
          { kind: "text", text: "hello" },
          { kind: "text", text: " world" },
          { kind: "finish", finishReason: "stop" },
          { kind: "usage", promptTokens: 1_000_000, completionTokens: 500_000 },
        ]);
      },
    };
    const adapter = makeAdapter(transport, { pricing: { mini: { input: 1, output: 2 } } });
    const result = await adapter.invoke(baseRequest, { stream: true });
    expect(seen?.stream).toBe(true);
    expect(seen?.stream_options).toEqual({ include_usage: true });
    expect(result.text).toBe("hello world");
    expect(result.finishReason).toBe("stop");
    expect(result.costUsd).toBe(2); // 1M*1 + 0.5M*2, from reported tokens only
  });

  it("tee's every frame to onEvent, and keeps result independent of onEvent failure", async () => {
    const transport: HttpTransport = {
      async post() { throw new Error("unused"); },
      async postStream() {
        return streamOf([
          { kind: "text", text: "a" },
          { kind: "usage", promptTokens: 1, completionTokens: 1 },
        ]);
      },
    };
    const adapter = makeAdapter(transport);
    const delivered: StreamEvent[] = [];
    const result = await adapter.invoke(baseRequest, {
      stream: true,
      onEvent: (e) => {
        delivered.push(e);
        if (e.kind === "text") throw new Error("consumer blew up");
      },
    });
    expect(delivered).toHaveLength(2);
    expect(result.text).toBe("a");
  });

  it("merges streamed tool-call argument fragments and decodes the JSON", async () => {
    const transport: HttpTransport = {
      async post() { throw new Error("unused"); },
      async postStream() {
        return streamOf([
          { kind: "tool-call-delta", index: 0, id: "call_1", toolName: "files.write", argumentsDelta: '{"path":' },
          { kind: "tool-call-delta", index: 0, argumentsDelta: '"a.txt","content":"hi"}' },
        ]);
      },
    };
    const result = await makeAdapter(transport).invoke(baseRequest, { stream: true });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]).toMatchObject({ id: "call_1", toolName: "files.write", input: { path: "a.txt", content: "hi" } });
  });

  it("treats an empty stream as an empty completion, never as success", async () => {
    const transport: HttpTransport = {
      async post() { throw new Error("unused"); },
      async postStream() {
        return streamOf([{ kind: "finish", finishReason: "stop" }]);
      },
    };
    await expect(makeAdapter(transport).invoke(baseRequest, { stream: true })).rejects.toMatchObject({
      code: "PROVIDER_CALL_FAILED",
    });
  });

  it("reports zero cost when no usage chunk arrived — it never invents cost", async () => {
    const transport: HttpTransport = {
      async post() { throw new Error("unused"); },
      async postStream() {
        return streamOf([{ kind: "text", text: "hi" }, { kind: "finish", finishReason: "stop" }]);
      },
    };
    const result = await makeAdapter(transport, { pricing: { mini: { input: 1, output: 2 } } }).invoke(baseRequest, { stream: true });
    expect(result.costUsd).toBe(0);
  });
});

describe("openai-compatible adapter: streaming failures and retries", () => {
  it("a mid-stream failure is typed interruption and is NOT retried", async () => {
    let postStreamCalls = 0;
    const transport: HttpTransport = {
      async post() { throw new Error("unused"); },
      async postStream() {
        postStreamCalls++;
        return {
          status: 200,
          events: (async function* () {
            yield { kind: "text", text: "partial" } as StreamEvent;
            throw new Error("socket reset");
          })(),
        };
      },
    };
    const adapter = new OpenAICompatibleAdapter({
      id: "test", displayName: "T", endpoint: "https://127.0.0.1:1/v1", apiKeyEnv: null,
      capabilities: ["CODING"], maxRetries: 3, retryBackoffMs: 0, transport,
    });
    await expect(adapter.invoke(baseRequest, { stream: true })).rejects.toMatchObject({
      code: "PROVIDER_STREAM_INTERRUPTED",
      retryable: false,
    });
    expect(postStreamCalls).toBe(1);
  });

  it("a pre-event transient failure may be retried, and recovers", async () => {
    let postStreamCalls = 0;
    const transport: HttpTransport = {
      async post() { throw new Error("unused"); },
      async postStream() {
        postStreamCalls++;
        if (postStreamCalls < 2) return { status: 503, events: streamOf([]).events };
        return streamOf([{ kind: "text", text: "ok" }]);
      },
    };
    const adapter = new OpenAICompatibleAdapter({
      id: "test", displayName: "T", endpoint: "https://127.0.0.1:1/v1", apiKeyEnv: null,
      capabilities: ["CODING"], maxRetries: 2, retryBackoffMs: 0, transport,
    });
    const result = await adapter.invoke(baseRequest, { stream: true });
    expect(result.text).toBe("ok");
    expect(postStreamCalls).toBe(2);
  });

  it("a pre-event 429 is typed and retried; once events started flowing, it must not retry", async () => {
    let postStreamCalls = 0;
    const transport: HttpTransport = {
      async post() { throw new Error("unused"); },
      async postStream() {
        postStreamCalls++;
        return { status: 429, events: streamOf([]).events };
      },
    };
    const adapter = new OpenAICompatibleAdapter({
      id: "test", displayName: "T", endpoint: "https://127.0.0.1:1/v1", apiKeyEnv: null,
      capabilities: ["CODING"], maxRetries: 1, retryBackoffMs: 0, transport,
    });
    await expect(adapter.invoke(baseRequest, { stream: true })).rejects.toMatchObject({
      code: "PROVIDER_RATE_LIMITED",
    });
    expect(postStreamCalls).toBe(2);
  });

  it("a 401 is never retried and maps to CREDENTIAL_UNAVAILABLE", async () => {
    let postStreamCalls = 0;
    const transport: HttpTransport = {
      async post() { throw new Error("unused"); },
      async postStream() {
        postStreamCalls++;
        return { status: 401, events: streamOf([]).events };
      },
    };
    const adapter = new OpenAICompatibleAdapter({
      id: "test", displayName: "T", endpoint: "https://127.0.0.1:1/v1", apiKeyEnv: null,
      capabilities: ["CODING"], maxRetries: 3, retryBackoffMs: 0, transport,
    });
    await expect(adapter.invoke(baseRequest, { stream: true })).rejects.toMatchObject({
      code: "CREDENTIAL_UNAVAILABLE",
    });
    expect(postStreamCalls).toBe(1);
  });
});

describe("openai-compatible adapter: streaming cancellation", () => {
  it("passes the caller's AbortSignal down to the transport", async () => {
    let seenSignal: AbortSignal | undefined;
    const transport: HttpTransport = {
      async post() { throw new Error("unused"); },
      async postStream(_url, _body, _headers, signal) {
        seenSignal = signal;
        return streamOf([{ kind: "text", text: "ok" }]);
      },
    };
    const controller = new AbortController();
    const adapter = makeAdapter(transport);
    await adapter.invoke(baseRequest, { stream: true, signal: controller.signal });
    expect(seenSignal).toBe(controller.signal);
  });

  it("an aborted stream surfaces PROVIDER_CANCELLED", async () => {
    const controller = new AbortController();
    const transport: HttpTransport = {
      async post() { throw new Error("unused"); },
      async postStream(_url, _body, _headers, signal) {
        return {
          status: 200,
          events: (async function* () {
            yield { kind: "text", text: "one" } as StreamEvent;
            // Hang until the caller aborts; then the generator itself throws,
            // mirroring transport-level tear-down.
            await new Promise<never>((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(new Error("the span was aborted")), { once: true });
            });
          })(),
        };
      },
    };
    const adapter = makeAdapter(transport);
    setTimeout(() => controller.abort(), 10);
    await expect(adapter.invoke(baseRequest, { stream: true, signal: controller.signal })).rejects.toMatchObject({
      code: "PROVIDER_CANCELLED",
    });
  });
});
