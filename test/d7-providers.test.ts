/**
 * D7 suite: the provider path becomes real.
 *
 * Pinned properties:
 * - the adapter now SENDS the declared tools and PARSES the provider's tool
 *   calls, so a real model can actually request a tool;
 * - a keyless (local) endpoint sends no Authorization header and is declared
 *   reachable without credentials;
 * - the faithful `messages` conversation is rendered when present, and the flat
 *   `inputs` fallback is untouched when it is not;
 * - cost is derived only from token counts the provider reported AND a
 *   registered rate — never invented;
 * - retries are bounded and reserved for genuinely transient failures;
 * - user-provider registration validates everything and skips bad entries
 *   instead of throwing.
 */
import { describe, expect, it } from "vitest";
import { OpenAICompatibleAdapter } from "../src/execution/openai-compatible-adapter.ts";
import type { HttpTransport, HttpResponse } from "../src/execution/types.ts";
import type { ProviderInvokeRequest } from "../src/providers/types.ts";
import {
  registerUserProvider,
  type UserProvidedProvider,
} from "../src/execution/user-providers.ts";
import { ModelCatalog } from "../src/models/catalog.ts";
import { AdapterRegistry } from "../src/execution/adapter-registry.ts";
import { buildExecutionStack } from "../src/execution/stack.ts";

/** A transport that records what was sent and replays a canned response. */
function recordingTransport(
  response: HttpResponse,
  onPost?: (url: string, body: unknown, headers: Record<string, string>) => void,
): HttpTransport {
  return {
    async post(url, body, headers) {
      onPost?.(url, body as Record<string, unknown>, headers);
      return response;
    },
  };
}

function okResponse(body: object): HttpResponse {
  return { status: 200, body };
}

const baseRequest: ProviderInvokeRequest = {
  model: "test/mini",
  capability: "CODING",
  inputs: [{ kind: "text", text: "hello" }],
};

describe("openai-compatible adapter: tool calls", () => {
  it("sends the declared tools to the provider", async () => {
    let sent: unknown;
    const adapter = new OpenAICompatibleAdapter({
      id: "test",
      displayName: "Test",
      endpoint: "https://127.0.0.1:1/v1",
      apiKeyEnv: null,
      capabilities: ["CODING"],
      transport: recordingTransport(okResponse({ choices: [{ message: { content: "ok" } }] }), (_u, b) => {
        sent = b;
      }),
    });

    await adapter.invoke({
      ...baseRequest,
      tools: [
        {
          name: "files.read",
          description: "Read a file",
          input: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    });

    const payload = sent as { tools: unknown };
    expect(Array.isArray(payload.tools)).toBe(true);
    expect((payload.tools as Array<{ function: { name: string } }>)[0].function.name).toBe("files.read");
  });

  it("parses tool calls the provider emitted, decoding JSON-string arguments", async () => {
    const adapter = new OpenAICompatibleAdapter({
      id: "test",
      displayName: "Test",
      endpoint: "https://127.0.0.1:1/v1",
      apiKeyEnv: null,
      capabilities: ["CODING"],
      transport: recordingTransport(
        okResponse({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "files.write", arguments: '{"path":"a.txt","content":"hi"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      ),
    });

    const result = await adapter.invoke({
      ...baseRequest,
      tools: [{ name: "files.write", description: "Write", input: {} }],
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].id).toBe("call_1");
    expect(result.toolCalls![0].toolName).toBe("files.write");
    expect(result.toolCalls![0].input).toEqual({ path: "a.txt", content: "hi" });
  });

  it("degrades malformed tool arguments to an empty object instead of throwing", async () => {
    const adapter = new OpenAICompatibleAdapter({
      id: "test",
      displayName: "Test",
      endpoint: "https://127.0.0.1:1/v1",
      apiKeyEnv: null,
      capabilities: ["CODING"],
      transport: recordingTransport(
        okResponse({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  { id: "call_1", type: "function", function: { name: "files.read", arguments: "not json" } },
                ],
              },
            },
          ],
        }),
      ),
    });

    const result = await adapter.invoke(baseRequest);
    expect(result.toolCalls![0].input).toEqual({});
  });

  it("accepts a turn that only asks for tools, and a turn that only has text", async () => {
    const textOnly = new OpenAICompatibleAdapter({
      id: "t",
      displayName: "T",
      endpoint: "https://127.0.0.1:1/v1",
      apiKeyEnv: null,
      capabilities: ["CODING"],
      transport: recordingTransport(okResponse({ choices: [{ message: { content: "hi" } }] })),
    });
    expect((await textOnly.invoke(baseRequest)).text).toBe("hi");

    const empty = new OpenAICompatibleAdapter({
      id: "t2",
      displayName: "T",
      endpoint: "https://127.0.0.1:1/v1",
      apiKeyEnv: null,
      capabilities: ["CODING"],
      transport: recordingTransport(okResponse({ choices: [{ message: {} }] })),
    });
    await expect(empty.invoke(baseRequest)).rejects.toThrow(/empty completion/);
  });
});

describe("openai-compatible adapter: credentials", () => {
  it("sends no Authorization header for a keyless endpoint", async () => {
    let sentHeaders: Record<string, string> = {};
    const adapter = new OpenAICompatibleAdapter({
      id: "test",
      displayName: "Test",
      endpoint: "http://127.0.0.1:11434/v1",
      apiKeyEnv: null,
      capabilities: ["CODING"],
      transport: recordingTransport(okResponse({ choices: [{ message: { content: "ok" } }] }), (_u, _b, h) => {
        sentHeaders = h;
      }),
    });
    await adapter.invoke(baseRequest);
    expect(sentHeaders.Authorization).toBeUndefined();
    expect(adapter.availableWithoutCredentials).toBe(true);
  });

  it("reads the key from the named environment variable at call time only", async () => {
    const saved = process.env.ALLINONE_TEST_KEY;
    process.env.ALLINONE_TEST_KEY = "sk-test-value";
    try {
      let sentHeaders: Record<string, string> = {};
      const adapter = new OpenAICompatibleAdapter({
        id: "test",
        displayName: "Test",
        endpoint: "https://127.0.0.1:1/v1",
        apiKeyEnv: "ALLINONE_TEST_KEY",
        capabilities: ["CODING"],
        transport: recordingTransport(okResponse({ choices: [{ message: { content: "ok" } }] }), (_u, _b, h) => {
          sentHeaders = h;
        }),
      });
      await adapter.invoke(baseRequest);
      expect(sentHeaders.Authorization).toBe("Bearer sk-test-value");
      expect(adapter.availableWithoutCredentials).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.ALLINONE_TEST_KEY;
      else process.env.ALLINONE_TEST_KEY = saved;
    }
  });

  it("refuses to call when the named key is absent", async () => {
    const saved = process.env.ALLINONE_TEST_MISSING_KEY;
    delete process.env.ALLINONE_TEST_MISSING_KEY;
    try {
      const adapter = new OpenAICompatibleAdapter({
        id: "test",
        displayName: "Test",
        endpoint: "https://127.0.0.1:1/v1",
        apiKeyEnv: "ALLINONE_TEST_MISSING_KEY",
        capabilities: ["CODING"],
        transport: recordingTransport(okResponse({ choices: [{ message: { content: "ok" } }] })),
      });
      await expect(adapter.invoke(baseRequest)).rejects.toThrow(/not set in the environment/);
    } finally {
      if (saved !== undefined) process.env.ALLINONE_TEST_MISSING_KEY = saved;
    }
  });
});

describe("openai-compatible adapter: messages", () => {
  it("renders the faithful conversation when messages are present", async () => {
    let sent: unknown;
    const adapter = new OpenAICompatibleAdapter({
      id: "test",
      displayName: "Test",
      endpoint: "https://127.0.0.1:1/v1",
      apiKeyEnv: null,
      capabilities: ["CODING"],
      transport: recordingTransport(okResponse({ choices: [{ message: { content: "ok" } }] }), (_u, b) => {
        sent = b;
      }),
    });

    await adapter.invoke({
      ...baseRequest,
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "sure",
          toolCalls: [{ id: "call_1", toolName: "files.read", arguments: '{"path":"a"}' }],
        },
        { role: "tool", content: "contents of a", toolCallId: "call_1", toolName: "files.read" },
      ],
    });

    const messages = (sent as { messages: Array<Record<string, unknown>> }).messages;
    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual({ role: "system", content: "be brief" });
    expect(messages[2]).toEqual({
      role: "assistant",
      content: "sure",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "files.read", arguments: '{"path":"a"}' } }],
    });
    expect(messages[3]).toEqual({ role: "tool", content: "contents of a", tool_call_id: "call_1" });
  });

  it("falls back to flat inputs when no messages are given", async () => {
    let sent: unknown;
    const adapter = new OpenAICompatibleAdapter({
      id: "test",
      displayName: "Test",
      endpoint: "https://127.0.0.1:1/v1",
      apiKeyEnv: null,
      capabilities: ["CODING"],
      transport: recordingTransport(okResponse({ choices: [{ message: { content: "ok" } }] }), (_u, b) => {
        sent = b;
      }),
    });
    await adapter.invoke({ ...baseRequest, inputs: [{ kind: "text", text: "just this" }] });
    const messages = (sent as { messages: Array<Record<string, unknown>> }).messages;
    expect(messages).toEqual([{ role: "user", content: "just this" }]);
  });
});

describe("openai-compatible adapter: cost", () => {
  it("derives real cost from reported tokens and the registered rate", async () => {
    const adapter = new OpenAICompatibleAdapter({
      id: "test",
      displayName: "Test",
      endpoint: "https://127.0.0.1:1/v1",
      apiKeyEnv: null,
      capabilities: ["CODING"],
      pricing: { mini: { input: 1, output: 2 } },
      transport: recordingTransport(
        okResponse({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 },
        }),
      ),
    });
    const result = await adapter.invoke({ ...baseRequest, model: "test/mini" });
    // 1M * 1 + 0.5M * 2 = 2 USD
    expect(result.costUsd).toBe(2);
  });

  it("reports zero cost when there is no rate, rather than inventing one", async () => {
    const adapter = new OpenAICompatibleAdapter({
      id: "test",
      displayName: "Test",
      endpoint: "https://127.0.0.1:1/v1",
      apiKeyEnv: null,
      capabilities: ["CODING"],
      transport: recordingTransport(
        okResponse({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        }),
      ),
    });
    expect((await adapter.invoke(baseRequest)).costUsd).toBe(0);
  });
});

describe("openai-compatible adapter: retry", () => {
  it("retries a 429 then succeeds", async () => {
    let calls = 0;
    const transport: HttpTransport = {
      async post() {
        calls++;
        return calls < 2
          ? { status: 429, body: {} }
          : okResponse({ choices: [{ message: { content: "ok" } }] });
      },
    };
    const adapter = new OpenAICompatibleAdapter({
      id: "test",
      displayName: "Test",
      endpoint: "https://127.0.0.1:1/v1",
      apiKeyEnv: null,
      capabilities: ["CODING"],
      maxRetries: 2,
      retryBackoffMs: 0,
      transport,
    });
    expect((await adapter.invoke(baseRequest)).text).toBe("ok");
    expect(calls).toBe(2);
  });

  it("does not retry a 400", async () => {
    let calls = 0;
    const transport: HttpTransport = {
      async post() {
        calls++;
        return { status: 400, body: { error: "bad" } };
      },
    };
    const adapter = new OpenAICompatibleAdapter({
      id: "test",
      displayName: "Test",
      endpoint: "https://127.0.0.1:1/v1",
      apiKeyEnv: null,
      capabilities: ["CODING"],
      maxRetries: 3,
      retryBackoffMs: 0,
      transport,
    });
    await expect(adapter.invoke(baseRequest)).rejects.toThrow(/HTTP 400/);
    expect(calls).toBe(1);
  });

  it("gives up after the retry budget and reports the attempts", async () => {
    let calls = 0;
    const transport: HttpTransport = {
      async post() {
        calls++;
        return { status: 500, body: {} };
      },
    };
    const adapter = new OpenAICompatibleAdapter({
      id: "test",
      displayName: "Test",
      endpoint: "https://127.0.0.1:1/v1",
      apiKeyEnv: null,
      capabilities: ["CODING"],
      maxRetries: 1,
      retryBackoffMs: 0,
      transport,
    });
    await expect(adapter.invoke(baseRequest)).rejects.toThrow(/failed after 2 attempts/);
    expect(calls).toBe(2);
  });
});

describe("user provider registration", () => {
  function fresh(): { adapters: AdapterRegistry; catalog: ModelCatalog } {
    return { adapters: new AdapterRegistry(), catalog: new ModelCatalog() };
  }

  it("registers an adapter and its models for a loopback keyless server", () => {
    const { adapters, catalog } = fresh();
    const provider: UserProvidedProvider = {
      id: "ollama",
      displayName: "Ollama",
      endpoint: "http://127.0.0.1:11434/v1",
      apiKeyEnv: null,
      models: [{ id: "llama3", displayName: "Llama 3", tools: true }],
    };
    const result = registerUserProvider(provider, adapters, catalog);
    expect(result.adapterId).toBe("ollama");
    expect(result.modelIds).toEqual(["ollama/llama3"]);
    expect(adapters.has("ollama")).toBe(true);
    expect(catalog.has("ollama/llama3")).toBe(true);
    const descriptor = catalog.get("ollama/llama3");
    expect(descriptor).toBeDefined();
    expect(descriptor!.locality).toBe("local");
    expect(descriptor!.pricing.costClass).toBe("FREE");
    expect(result.warnings).toEqual([]);
  });

  it("marks a paid remote model PAID and keeps the rate for real costing", () => {
    const { adapters, catalog } = fresh();
    const result = registerUserProvider(
      {
        id: "remote",
        displayName: "Remote",
        endpoint: "https://api.example.com/v1",
        apiKeyEnv: "EXAMPLE_KEY",
        models: [
          { id: "big", displayName: "Big", costPer1MUsd: { input: 5, output: 15 } },
        ],
      },
      adapters,
      catalog,
    );
    expect(result.modelIds).toEqual(["remote/big"]);
    const descriptor = catalog.get("remote/big");
    expect(descriptor).toBeDefined();
    expect(descriptor!.pricing.costClass).toBe("PAID");
    expect(descriptor!.pricing.inputPer1M).toBe(5);
    expect(descriptor!.locality).toBe("remote");
  });

  it("refuses plain http to a remote host before any key is ever read", () => {
    const { adapters, catalog } = fresh();
    const result = registerUserProvider(
      {
        id: "bad",
        displayName: "Bad",
        endpoint: "http://api.example.com/v1",
        apiKeyEnv: "EXAMPLE_KEY",
        models: [{ id: "x", displayName: "X" }],
      },
      adapters,
      catalog,
    );
    expect(result.adapterId).toBe("");
    expect(result.modelIds).toEqual([]);
    expect(result.warnings[0]).toMatch(/must use https/);
    expect(adapters.has("bad")).toBe(false);
  });

  it("refuses an invalid id, and never overwrites the built-in local adapter", () => {
    const { adapters, catalog } = fresh();
    const invalid = registerUserProvider(
      { id: "No Good", displayName: "X", endpoint: "http://127.0.0.1:1/v1", models: [] },
      adapters,
      catalog,
    );
    expect(invalid.warnings[0]).toMatch(/not a valid id/);

    const collision = registerUserProvider(
      { id: "local", displayName: "X", endpoint: "http://127.0.0.1:1/v1", models: [] },
      adapters,
      catalog,
    );
    expect(collision.warnings[0]).toMatch(/already registered/);
  });

  it("skips a duplicate model with a warning instead of throwing", () => {
    const { adapters, catalog } = fresh();
    const provider: UserProvidedProvider = {
      id: "ollama",
      displayName: "Ollama",
      endpoint: "http://127.0.0.1:11434/v1",
      models: [
        { id: "llama3", displayName: "Llama 3" },
        { id: "llama3", displayName: "Llama 3 again" },
      ],
    };
    const result = registerUserProvider(provider, adapters, catalog);
    expect(result.modelIds).toEqual(["ollama/llama3"]);
    expect(result.warnings[0]).toMatch(/already registered/);
  });
});

describe("execution stack with user providers", () => {
  it("registers user providers additively and keeps the frozen catalogue intact", () => {
    const before = buildExecutionStack({ agentModel: true });
    const baseline = before.catalog.list().map((m) => m.id).sort();

    const stack = buildExecutionStack({
      agentModel: true,
      providers: [
        {
          id: "ollama",
          displayName: "Ollama",
          endpoint: "http://127.0.0.1:11434/v1",
          apiKeyEnv: null,
          models: [{ id: "llama3", displayName: "Llama 3" }],
        },
      ],
    });

    const ids = stack.catalog.list().map((m) => m.id).sort();
    expect(ids).toContain("ollama/llama3");
    // Everything that existed before still exists, unchanged.
    for (const id of baseline) expect(ids).toContain(id);
    expect(stack.registrationWarnings).toEqual([]);
  });

  it("collects warnings from a bad provider without failing the stack", () => {
    const stack = buildExecutionStack({
      providers: [
        { id: "bad", displayName: "Bad", endpoint: "not a url", models: [{ id: "x", displayName: "X" }] },
      ],
    });
    expect(stack.registrationWarnings.length).toBeGreaterThan(0);
    expect(stack.catalog.has("bad/x")).toBe(false);
  });
});
