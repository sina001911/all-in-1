/**
 * D13: one real socket, one real SSE stream, one real engine invocation.
 *
 * The default OpenAICompatibleAdapter transport must parse a real HTTP
 * stream end-to-end — no fake transport, no mocked iterator. The provider is
 * a plain Node HTTP server on loopback, its model declared with
 * `streaming: true`, and invocation flows through an `ExecutionEngine` built
 * by `buildExecutionStack`, so the frozen gates are all in the path.
 */
import { describe, expect, it, afterEach } from "vitest";
import http from "node:http";
import { once } from "node:events";
import { buildExecutionStack } from "../../src/execution/stack.ts";
import type { StreamEvent } from "../../src/execution/types.ts";

const sseHeaders = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
};

async function withServer(
  handler: http.RequestListener,
  body: () => Promise<void>,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

describe("real SSE over a loopback socket", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  it("assembles a streamed answer and reports the provider's usage frame", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, sseHeaders);
      res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":" there"}}]}\n\n');
      res.write('data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanup = async () => { server.close(); };

    const port = (server.address() as { port: number }).port;
    const stack = buildExecutionStack({
      providers: [
        {
          id: "sse",
          displayName: "SSE",
          endpoint: `http://127.0.0.1:${port}/v1`,
          apiKeyEnv: null,
          models: [{ id: "echo", capabilities: ["CHAT"], streaming: true }],
        },
      ],
    });

    const events: StreamEvent[] = [];
    const outcome = await stack.engine.invoke(
      { capability: "CHAT", inputs: [{ kind: "text", text: "hi" }], streaming: true },
      { onStreamEvent: (e) => events.push(e) },
    );
    expect(outcome.result.text).toBe("hello there");
    expect(events.map((e) => e.kind)).toEqual(["text", "text", "usage"]);
    // No pricing registered: cost must be exactly 0, never invented.
    expect(outcome.result.costUsd).toBe(0);
    expect(outcome.committedUsd).toBe(0);
    // The egress gate allowed loopback (deny-all with loopback opt-in).
    expect(stack.egress.kind).toBe("deny-all");
    expect(stack.adapters.has("sse")).toBe(true);
  });

  it("a hung body is aborted by the engine timeout, and no reservation leaks", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, sseHeaders);
      res.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
      // Never complete the body; the engine's timeout must cut it.
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanup = async () => { server.close(); };

    const port = (server.address() as { port: number }).port;
    const stack = buildExecutionStack({
      providers: [
        {
          id: "sse",
          displayName: "SSE",
          endpoint: `http://127.0.0.1:${port}/v1`,
          apiKeyEnv: null,
          models: [{ id: "echo", capabilities: ["CHAT"], streaming: true }],
        },
      ],
    });

    await expect(
      stack.engine.invoke(
        { capability: "CHAT", inputs: [{ kind: "text", text: "hi" }], streaming: true },
      { timeoutMs: 100 },
    ),
    ).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    expect(stack.budget.snapshot().spentUsd).toBe(0);
    server.closeAllConnections?.();
  });
});
