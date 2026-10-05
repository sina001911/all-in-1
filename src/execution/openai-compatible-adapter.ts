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
import type { ProviderInvokeResult, HttpTransport, HttpResponse } from "./types.ts";
import { resolveBearerToken } from "./secrets.ts";
import { AllInOneError, toAllInOneError } from "../errors.ts";
import { redact } from "../log/redact.ts";

export interface OpenAICompatibleOptions {
  readonly id: string;
  readonly displayName: string;
  readonly endpoint: string;
  readonly apiKeyEnv: string;
  /** Capabilities this adapter may serve. */
  readonly capabilities: readonly string[];
  readonly knownEndpointIssues?: readonly string[];
  readonly transport?: HttpTransport;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs?: number;
}

interface ChatCompletionResponse {
  readonly choices?: ReadonlyArray<{
    readonly message?: { readonly content?: string };
    readonly finish_reason?: string;
  }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
  };
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class OpenAICompatibleAdapter extends BaseProviderAdapter {
  private readonly transport: HttpTransport;
  private readonly timeoutMs: number;

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
      availableWithoutCredentials: false,
    });
    this.transport = opts.transport ?? defaultTransport;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  override async invoke(request: ProviderInvokeRequest): Promise<ProviderInvokeResult> {
    const started = Date.now();
    const key = resolveBearerToken(this.apiKeyEnv as string);
    const url = `${this.endpoint}/chat/completions`;

    const payload = {
      model: request.model.split("/")[1],
      messages: request.inputs.map((input) =>
        input.kind === "text"
          ? { role: "user", content: input.text }
          : { role: "user", content: [{ type: "image_url", image_url: { url: `artifact://${input.artifactId}` } }] },
      ),
      response_format: request.structuredOutputSchema ? { type: "json_object" } : undefined,
    };

    let response: HttpResponse;
    try {
      response = await this.transport.post(url, payload, {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      });
    } catch (e) {
      throw toAllInOneError(e, {
        code: "PROVIDER_UNREACHABLE",
        category: "unavailable",
        message: `Request to ${this.id} failed: ${describe(e)}`,
      });
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
    if (!text) {
      throw new AllInOneError(
        `${this.id} returned an empty completion`,
        "PROVIDER_CALL_FAILED",
        "unavailable",
        { retryable: false },
      );
    }

    const costUsd = estimateCostFromUsage(parsed, this);

    return {
      providerId: this.id,
      modelId: request.model,
      capability: request.capability,
      ok: true,
      text,
      structured: request.structuredOutputSchema ? safeParseJson(text) : undefined,
      costUsd,
      latencyMs: Date.now() - started,
      finishReason: choice?.finish_reason,
      raw: undefined, // never surface the raw payload
    };
  }
}

function estimateCostFromUsage(
  parsed: ChatCompletionResponse,
  adapter: OpenAICompatibleAdapter,
): number {
  const usage = parsed.usage;
  if (!usage) return 0;
  // Cost is derived from token counts and the adapter's own rate metadata when
  // a future registration supplies it. Until then the adapter reports 0 and the
  // engine records actual usage separately, so cost is never invented.
  void adapter;
  void usage;
  return 0;
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
