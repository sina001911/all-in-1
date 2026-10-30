/**
 * MediaAdapter: retry, cancellation, and error-code tests (D35).
 *
 * The adapter is the last-mile call: given a request and an injectable
 * transport, it returns bytes or throws a typed media error. These tests
 * exercise the retry loop, the abort-signal path, and the permanent-vs-
 * transient error distinction — all with a fake transport, no socket, no
 * credential, no artifact base on disk.
 */
import { describe, expect, it } from "vitest";
import { MediaAdapter } from "../src/media/adapter.ts";
import type { HttpTransport, HttpResponse } from "../src/execution/types.ts";

const P1PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function fakeTransport(fn: (url: string, body: unknown, headers: Record<string, string>) => Promise<HttpResponse>): HttpTransport {
  return { post: async (url, body, headers) => fn(url, body, headers) };
}

function req(over: Record<string, unknown> = {}) {
  return {
    capability: "TEXT_TO_IMAGE",
    model: "test/tiny",
    prompt: "a cat",
    ...over,
  } as never;
}

describe("MediaAdapter retry", () => {
  it("retries a transient transport failure and succeeds on the second attempt", async () => {
    let calls = 0;
    const adapter = new MediaAdapter({
      transport: fakeTransport(async () => {
        calls++;
        if (calls === 1) throw new Error("network reset");
        return { status: 200, body: { data: [{ b64_json: P1PNG }] } };
      }),
      maxRetries: 2,
      retryDelayMs: 1,
    });
    const result = await adapter.generate(req());
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("does not retry a permanent credential rejection", async () => {
    let calls = 0;
    const adapter = new MediaAdapter({
      transport: fakeTransport(async () => {
        calls++;
        return { status: 401, body: { error: { message: "bad key" } } };
      }),
      maxRetries: 3,
      retryDelayMs: 1,
    });
    await expect(adapter.generate(req())).rejects.toThrow(/credential_rejected/);
    expect(calls).toBe(1);
  });

  it("does not retry a 4xx client error", async () => {
    let calls = 0;
    const adapter = new MediaAdapter({
      transport: fakeTransport(async () => {
        calls++;
        return { status: 400, body: { error: { message: "bad request" } } };
      }),
      maxRetries: 3,
      retryDelayMs: 1,
    });
    await expect(adapter.generate(req())).rejects.toThrow(/bad_status/);
    expect(calls).toBe(1);
  });

  it("retries a 429 rate limit", async () => {
    let calls = 0;
    const adapter = new MediaAdapter({
      transport: fakeTransport(async () => {
        calls++;
        if (calls < 3) return { status: 429, body: {} };
        return { status: 200, body: { data: [{ b64_json: P1PNG }] } };
      }),
      maxRetries: 3,
      retryDelayMs: 1,
    });
    const result = await adapter.generate(req());
    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
  });

  it("retries a 5xx server error", async () => {
    let calls = 0;
    const adapter = new MediaAdapter({
      transport: fakeTransport(async () => {
        calls++;
        if (calls === 1) return { status: 503, body: {} };
        return { status: 200, body: { data: [{ b64_json: P1PNG }] } };
      }),
      maxRetries: 2,
      retryDelayMs: 1,
    });
    const result = await adapter.generate(req());
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("exhausts retries and throws the last transient error", async () => {
    let calls = 0;
    const adapter = new MediaAdapter({
      transport: fakeTransport(async () => {
        calls++;
        return { status: 503, body: {} };
      }),
      maxRetries: 2,
      retryDelayMs: 1,
    });
    await expect(adapter.generate(req())).rejects.toThrow(/server_error/);
    expect(calls).toBe(2);
  });
});

describe("MediaAdapter cancellation", () => {
  it("throws a typed cancelled error when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = new MediaAdapter({
      transport: fakeTransport(async () => {
        throw new Error("transport must not be called");
      }),
    });
    await expect(adapter.generate(req({ signal: controller.signal }))).rejects.toThrow(/cancelled/);
  });

  it("aborts an in-flight call and never retries", async () => {
    const controller = new AbortController();
    let calls = 0;
    let resolveCall: (() => void) | undefined;
    const adapter = new MediaAdapter({
      transport: {
        post: async (_url, _body, _headers, signal) => {
          calls++;
          await new Promise<void>((resolve, reject) => {
            if (signal?.aborted) {
              reject(new Error("aborted"));
              return;
            }
            resolveCall = () => {
              if (signal?.aborted) reject(new Error("aborted"));
              else resolve();
            };
            if (signal) signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
          return { status: 200, body: { data: [{ b64_json: P1PNG }] } };
        },
      },
      maxRetries: 5,
      retryDelayMs: 1000,
    });
    const promise = adapter.generate(req({ signal: controller.signal }));
    // Let the first attempt start, then cancel.
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    if (resolveCall) resolveCall();
    await expect(promise).rejects.toThrow(/cancelled/);
    expect(calls).toBe(1);
  });
});