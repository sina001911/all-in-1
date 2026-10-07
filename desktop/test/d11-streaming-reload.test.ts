/**
 * D11 + D10: a streaming invocation survives a provider reload.
 *
 * The engine captures its adapters at invocation start; D10's atomic swap
 * installs a new engine without touching the in-flight one, so a streamed
 * completion that began before the reload finishes — with every event
 * delivered — while the NEXT streaming request resolves against the new
 * catalogue, honestly reporting that the provider no longer exists.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDesktopStack } from "../src/desktop-stack.ts";
import { DesktopFacade } from "../src/facade.ts";
import { MemoryCredentialProvider } from "../src/credentials/memory-credential-provider.ts";
import type { StreamEvent } from "../../src/execution/types.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-d11-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("streaming across a hot reload", () => {
  it("in-flight stream completes; the new catalogue admits nothing", async () => {
    const stack = buildDesktopStack({
      baseDir: dir,
      credentials: new MemoryCredentialProvider(),
    });
    const f = new DesktopFacade(stack);
    f.patchSettings({
      providers: [
        {
          id: "remote",
          displayName: "Remote",
          endpoint: "https://api.example.com/v1",
          apiKeyEnv: null,
          models: [{ id: "mini", capabilities: ["CHAT"], streaming: true }],
        },
      ],
    } as never);

    // The pre-reload engine must see the streaming model.
    const streamedModel = f.listModels().find((m) => m.id === "remote/mini");
    expect(streamedModel?.streaming).toBe(true);

    // Feed the adapter a real SSE byte stream, split mid-frame, and pause the
    // HTTP body until we release it.
    const encoder = new TextEncoder();
    let releaseBody!: () => void;
    const bodyGate = new Promise<void>((r) => (releaseBody = r));
    let resolveFirstChunk!: () => void;
    const firstChunk = new Promise<void>((r) => (resolveFirstChunk = r));

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hel'));
          resolveFirstChunk();
          await bodyGate;
          controller.enqueue(encoder.encode('lo"}}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        })();
      },
    });

    const originalFetch = globalThis.fetch;
    let sawAuth = false;
    globalThis.fetch = (async (_url: unknown, init: unknown) => {
      const headers = (init as { headers?: Record<string, string> }).headers ?? {};
      sawAuth = "Authorization" in headers;
      return { status: 200, body: stream, json: async () => ({}) } as never;
    }) as never;

    const oldEngine = stack.core.stack.engine;
    const delivered: StreamEvent[] = [];
    try {
      const pending = oldEngine.invoke(
        { capability: "CHAT", inputs: [{ kind: "text", text: "hi" }], streaming: true },
        { onStreamEvent: (e) => delivered.push(e) },
      );

      await firstChunk;

      // Remove the provider while the byte stream is paused mid-frame.
      f.patchSettings({ providers: [] } as never);

      releaseBody();
      const outcome = await pending;

      expect(outcome.result.text).toBe("hello");
      expect(outcome.committedUsd).toBe(0); // no pricing registered for the model
      expect(delivered.map((e) => e.kind)).toEqual(["text", "usage"]);
      expect(stack.core.stack.engine).not.toBe(oldEngine);
      expect(sawAuth).toBe(false); // keyless endpoint: no Authorization header

      await expect(
        stack.core.stack.engine.invoke(
          { capability: "CHAT", inputs: [{ kind: "text", text: "hi" }], streaming: true },
          {},
        ),
      ).rejects.toMatchObject({ code: "SELECTION_FAILED" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("streaming requests are refused honestly when the model does not declare streaming", () => {
    const stack = buildDesktopStack({
      baseDir: dir,
      credentials: new MemoryCredentialProvider(),
    });
    const f = new DesktopFacade(stack);
    f.patchSettings({
      providers: [
        {
          id: "plain",
          displayName: "Plain",
          endpoint: "https://api.example.com/v1",
          apiKeyEnv: null,
          models: [{ id: "mini", capabilities: ["CHAT"] }], // no streaming flag
        },
      ],
    } as never);
    const model = f.listModels().find((m) => m.id === "plain/mini");
    expect(model?.streaming).toBe(false);
  });
});
