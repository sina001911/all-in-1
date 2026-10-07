/**
 * OpenAI-compatible provider adapter (P4) — the real call path.
 *
 * Speaks the Chat Completions shape shared by OpenAI-compatible endpoints. It
 * is the ONLY component that opens an outbound connection to a remote host,
 * and only after three gates have passed, in this order:
 *
 *   1. `validateInvoke()`  — provider isolation (inherited, frozen P3 logic)
 *   2. egress gate         — the endpoint host must be explicitly allowlisted
 *   3. secret resolution   — the key value is read, here and only here
 *
 * The transport is injectable. The default transport uses the global `fetch`,
 * which is available in Node 18+; tests inject a fake transport so the entire
 * call path is verifiable offline. The adapter itself never imports an HTTP
 * library, so the package keeps ZERO runtime dependencies.
 *
 * NOT REGISTERED BY DEFAULT. Per docs/reconnaissance.md no provider's pricing
 * or availability has been verified, so this adapter exists but is not wired
 * into any registry. Registering it is an explicit, reviewed act.
 */
import { BaseProviderAdapter, type ProviderInvokeRequest } from "../providers/types.ts";
import type {
  ProviderInvokeResult,
  ProviderToolCall,
  ProviderToolDeclaration,
  HttpTransport,
  HttpResponse,
} from "./types.ts";
import { resolveBearerToken } from "./secrets.ts";
import { AllInOneError, toAllInOneError } from "../errors.ts";
import { redact } from "../log/redact.ts";

export interface OpenAICompatibleOptions {
  readonly id: string;
  readonly displayName: string;
  readonly endpoint: string;
  /**
   * Environment variable NAME holding the key, or `null` for a keyless
   * endpoint. A local model server (Ollama, LM Studio, vLLM) needs no
   * credential, and forcing one on it would make a perfectly reachable
   * provider refuse to run.
   */
  readonly apiKeyEnv: string | null;
  /** Capabilities this adapter may serve. */
  readonly capabilities: readonly string[];
  readonly knownEndpointIssues?: readonly string[];
  readonly transport?: HttpTransport;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs?: number;
  /**
   * Bounded retry policy (D7). Only genuinely transient failures are retried
   * (429, 5xx, transport errors); a 4xx is never retried, because repeating
   * a request the provider already rejected just spends the user's budget.
   */
  readonly maxRetries?: number;
  /** Base backoff in ms; grows linearly with the attempt number. */
  readonly retryBackoffMs?: number;
  /**
   * Real price metadata, keyed by model name, in USD per 1,000,000 tokens
   * (D7). Cost is only ever derived from token counts the provider itself
   * reports; without a rate the adapter reports 0 rather than inventing one.
   */
  readonly pricing?: Readonly<Record<string, { readonly input: number; readonly output: number }>>;
}

interface ChatCompletionToolCall {
  readonly id?: string;
  readonly type?: string;
  readonly function?: {
    readonly name?: string;
    /** OpenAI sends arguments as a JSON *string*, not an object. */
    readonly arguments?: string;
  };
}

interface ChatCompletionResponse {
  readonly choices?: ReadonlyArray<{
    readonly message?: {
      readonly content?: string;
      readonly tool_calls?: ReadonlyArray<ChatCompletionToolCall>;
    };
    readonly finish_reason?: string;
  }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
  };
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BACKOFF_MS = 500;

export class OpenAICompatibleAdapter extends BaseProviderAdapter {
  private readonly transport: HttpTransport;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;
  private readonly pricing: Readonly<Record<string, { readonly input: number; readonly output: number }>>;

  constructor(opts: OpenAICompatibleOptions) {
    super({
      id: opts.id,
      displayName: opts.displayName,
      protocol: "openai-compatible",
      locality: "remote",
      apiKeyEnv: opts.apiKeyEnv,
      endpoint: opts.endpoint,
      capabilities: opts.capabilities,
      knownEndpointIssues: opts.knownEndpointIssues,
      // A keyless endpoint (a local model server) is genuinely reachable with
      // no credential; declaring otherwise would make the selector discard it.
      availableWithoutCredentials: opts.apiKeyEnv === null,
    });
    this.transport = opts.transport ?? defaultTransport;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = Math.max(0, opts.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.retryBackoffMs = Math.max(0, opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS);
    this.pricing = opts.pricing ?? {};
  }

  override async invoke(request: ProviderInvokeRequest): Promise<ProviderInvokeResult> {
    const started = Date.now();
    const modelName = request.model.split("/")[1];
    // A keyless endpoint simply sends no Authorization header. A keyed one
    // resolves the value HERE, at the last possible moment, and it is never
    // stored, logged, or placed in an error.
    const key = this.apiKeyEnv === null ? null : resolveBearerToken(this.apiKeyEnv);
    const url = `${this.endpoint}/chat/completions`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (key !== null) headers.Authorization = `Bearer ${key}`;

    const payload = {
      model: modelName,
      messages: buildMessages(request),
      tools: request.tools?.map(toOpenAITool),
      response_format: request.structuredOutputSchema ? { type: "json_object" } : undefined,
    };

    let response: HttpResponse | undefined;
    let lastStatus = 0;
    let lastTransportError: unknown;
    // Bounded retry over genuinely transient failures only.
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        response = await this.transport.post(url, payload, headers);
        if (response.status !== 429 && response.status < 500) break;
        lastStatus = response.status;
        response = undefined;
      } catch (e) {
        lastTransportError = e;
      }
      if (attempt < this.maxRetries && this.retryBackoffMs > 0) {
        await delay(this.retryBackoffMs * (attempt + 1));
      }
    }
    if (response === undefined) {
      // When the budget is spent, report the honest typed outcome of the
      // FINAL attempt — never an invented generic one.
      const attempts = `failed after ${this.maxRetries + 1} attempts`;
      if (lastStatus === 429) {
        throw new AllInOneError(
          `${this.id} rate-limited the request (HTTP 429): ${attempts}`,
          "PROVIDER_RATE_LIMITED",
          "unavailable",
          { retryable: true },
        );
      }
      if (lastStatus >= 500) {
        throw new AllInOneError(
          `${this.id} returned HTTP ${lastStatus}: ${attempts}`,
          "PROVIDER_UNREACHABLE",
          "unavailable",
          { retryable: true },
        );
      }
      throw new AllInOneError(
        `Request to ${this.id} ${attempts}: ${describe(lastTransportError)}`,
        "PROVIDER_UNREACHABLE",
        "unavailable",
        { retryable: true, cause: lastTransportError },
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new AllInOneError(
        `${this.id} rejected the credential (HTTP ${response.status})`,
        "CREDENTIAL_UNAVAILABLE",
        "unavailable",
        { retryable: false },
      );
    }
    if (response.status === 429) {
      throw new AllInOneError(
        `${this.id} rate-limited the request (HTTP 429)`,
        "PROVIDER_RATE_LIMITED",
        "unavailable",
        { retryable: true },
      );
    }
    if (response.status >= 500) {
      throw new AllInOneError(
        `${this.id} returned HTTP ${response.status}`,
        "PROVIDER_UNREACHABLE",
        "unavailable",
        { retryable: true },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new AllInOneError(
        `${this.id} returned HTTP ${response.status}`,
        "PROVIDER_CALL_FAILED",
        "unavailable",
        { retryable: false },
      );
    }

    const parsed = response.body as ChatCompletionResponse;
    const choice = parsed.choices?.[0];
    const text = choice?.message?.content ?? "";
    const toolCalls = parseToolCalls(choice?.message?.tool_calls);
    // A turn is successful when it produced text OR asked for tools. A provider
    // that returns neither failed, and saying so is more useful than an empty
    // success the agent loop would then treat as a final answer.
    if (!text && toolCalls.length === 0) {
      throw new AllInOneError(
        `${this.id} returned an empty completion`,
        "PROVIDER_CALL_FAILED",
        "unavailable",
        { retryable: false },
      );
    }

    const costUsd = estimateCostFromUsage(parsed, this.pricing, modelName);

    return {
      providerId: this.id,
      modelId: request.model,
      capability: request.capability,
      ok: true,
      text,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      structured: request.structuredOutputSchema ? safeParseJson(text) : undefined,
      costUsd,
      latencyMs: Date.now() - started,
      finishReason: choice?.finish_reason,
      raw: undefined, // never surface the raw payload
    };
  }
}

/** Wire shape for one declared tool. A declaration grants no execution right. */
function toOpenAITool(decl: ProviderToolDeclaration) {
  return {
    type: "function" as const,
    function: {
      name: decl.name,
      description: decl.description,
      parameters: decl.input,
    },
  };
}

/**
 * Parse the provider's tool calls. Arguments arrive as a JSON STRING; a
 * malformed or non-object payload degrades to `{}` rather than throwing, so a
 * confused model produces a call that fails the executor's own validation —
 * inside the privilege pipeline, where it belongs — instead of a provider
 * error that looks like a transport failure.
 */
function parseToolCalls(calls: ReadonlyArray<ChatCompletionToolCall> | undefined): ProviderToolCall[] {
  if (!Array.isArray(calls)) return [];
  const out: ProviderToolCall[] = [];
  for (const call of calls) {
    const name = call?.function?.name;
    if (typeof name !== "string" || name.length === 0) continue;
    out.push({
      id: typeof call?.id === "string" && call.id.length > 0 ? call.id : `call_${out.length + 1}`,
      toolName: name,
      input: parseArguments(call?.function?.arguments),
    });
  }
  return out;
}

function parseArguments(raw: string | undefined): Readonly<Record<string, unknown>> {
  if (typeof raw !== "string" || raw.trim().length === 0) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Build the wire message list. The faithful `messages` conversation wins when
 * present; otherwise the flat `inputs` are flattened into one user turn, which
 * is exactly what a single-shot completion needs.
 */
function buildMessages(request: ProviderInvokeRequest): unknown[] {
  if (request.messages && request.messages.length > 0) {
    return request.messages.map((m) => {
      if (m.role === "assistant") {
        return {
          role: "assistant",
          content: m.content,
          ...(m.toolCalls && m.toolCalls.length > 0
            ? {
                tool_calls: m.toolCalls.map((c) => ({
                  id: c.id,
                  type: "function",
                  function: { name: c.toolName, arguments: c.arguments },
                })),
              }
            : {}),
        };
      }
      if (m.role === "tool") {
        return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
      }
      return { role: m.role, content: m.content };
    });
  }
  return request.inputs.map((input) =>
    input.kind === "text"
      ? { role: "user", content: input.text }
      : { role: "user", content: [{ type: "image_url", image_url: { url: `artifact://${input.artifactId}` } }] },
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Derive the real cost from the token counts the provider reported and the
 * registered rate. Without either, the answer is 0 — cost is never invented,
 * and the engine records usage separately so nothing is silently free.
 */
function estimateCostFromUsage(
  parsed: ChatCompletionResponse,
  pricing: Readonly<Record<string, { readonly input: number; readonly output: number }>>,
  modelName: string,
): number {
  const usage = parsed.usage;
  if (!usage) return 0;
  const rate = pricing[modelName];
  if (!rate) return 0;
  const input = Math.max(0, usage.prompt_tokens ?? 0);
  const output = Math.max(0, usage.completion_tokens ?? 0);
  return Number(((input * rate.input + output * rate.output) / 1_000_000).toFixed(6));
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function describe(e: unknown): string {
  const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  // Defensive: a network error must never smuggle a key into an error message.
  return redact(message);
}

const defaultTransport: HttpTransport = {
  async post(url: string, body: unknown, headers: Record<string, string>): Promise<HttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const parsed = (await response.json()) as unknown;
      return { status: response.status, body: parsed };
    } finally {
      clearTimeout(timer);
    }
  },
};
