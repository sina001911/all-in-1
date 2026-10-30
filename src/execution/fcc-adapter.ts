/**
 * Anthropic Messages-compatible provider adapter (P4) — the real call path.
 *
 * Speaks the Anthropic Messages API shape used by the FCC local gateway:
 * POST ${endpoint}/messages with a `messages` array, `max_tokens`, optional
 * `system`, optional `tools`, and optional `stream`. It is the ONLY component
 * that opens an outbound connection to a remote host, and only after three
 * gates have passed, in this order:
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
 * KEYLESS BY DESIGN. The FCC local gateway runs on the loopback interface and
 * needs no credential. Forcing an Authorization header on it would be wrong,
 * so this adapter sends none — and declares `availableWithoutCredentials`
 * true so the selector does not discard it.
 *
 * NOT REGISTERED BY DEFAULT. Per docs/reconnaissance.md no provider's pricing
 * or availability has been verified, so this adapter exists but is not wired
 * into any registry. Registering it is an explicit, reviewed act.
 */
import { BaseProviderAdapter, type ProviderInvokeRequest, type ProviderInvokeOptions } from "../providers/types.ts";
import type {
  ProviderInvokeResult,
  ProviderToolCall,
  ProviderToolDeclaration,
  HttpTransport,
  HttpResponse,
  StreamEvent,
  StreamTransportResponse,
} from "./types.ts";
import { AllInOneError } from "../errors.ts";
import { redact } from "../log/redact.ts";

export interface AnthropicCompatibleOptions {
  readonly id: string;
  readonly displayName: string;
  readonly endpoint: string;
  /**
   * Environment variable NAME holding the key, or `null` for a keyless
   * endpoint. A local gateway reachable over loopback needs no credential,
   * and forcing one on it would make a perfectly reachable provider refuse.
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
  /**
   * Optional `anthropic-beta` header value, forwarded verbatim. Absent
   * means the canonical `anthropic-version` header alone is sent.
   */
  readonly beta?: string;
  /** Default max_tokens when the caller does not specify one. */
  readonly defaultMaxTokens?: number;
}

interface AnthropicTextBlock {
  readonly type: "text";
  readonly text: string;
}

interface AnthropicToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

interface AnthropicToolResultBlock {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: string;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

interface AnthropicToolCallWire {
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
}

interface AnthropicResponse {
  readonly content?: ReadonlyArray<AnthropicContentBlock>;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
  };
  readonly stop_reason?: string;
  readonly error?: { readonly message?: string };
}

interface AnthropicStreamFrame {
  readonly type?: string;
  readonly index?: number;
  readonly delta?: {
    readonly type?: string;
    readonly text?: string;
    readonly partial_json?: string;
    readonly stop_reason?: string;
  };
  readonly content_block?: {
    readonly type?: string;
    readonly id?: string;
    readonly name?: string;
  };
  readonly message?: {
    readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
  };
  readonly usage?: { readonly output_tokens?: number };
  readonly error?: { readonly message?: string };
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BACKOFF_MS = 500;
const DEFAULT_MAX_TOKENS = 1024;

export class AnthropicCompatibleAdapter extends BaseProviderAdapter {
  private readonly transport: HttpTransport;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;
  private readonly pricing: Readonly<Record<string, { readonly input: number; readonly output: number }>>;
  private readonly beta: string | undefined;
  private readonly defaultMaxTokens: number;

  constructor(opts: AnthropicCompatibleOptions) {
    super({
      id: opts.id,
      displayName: opts.displayName,
      protocol: "anthropic",
      locality: "remote",
      apiKeyEnv: opts.apiKeyEnv,
      endpoint: opts.endpoint,
      capabilities: opts.capabilities,
      knownEndpointIssues: opts.knownEndpointIssues,
      // A keyless loopback gateway is genuinely reachable with no credential;
      // declaring otherwise would make the selector discard it.
      availableWithoutCredentials: opts.apiKeyEnv === null,
    });
    this.transport = opts.transport ?? defaultTransport;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = Math.max(0, opts.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.retryBackoffMs = Math.max(0, opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS);
    this.pricing = opts.pricing ?? {};
    this.beta = opts.beta;
    this.defaultMaxTokens = opts.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
  }

  override async invoke(
    request: ProviderInvokeRequest,
    opts?: ProviderInvokeOptions,
  ): Promise<ProviderInvokeResult> {
    if (opts?.stream === true) return this.invokeStreaming(request, opts);
    const started = Date.now();
    const modelName = request.model.split("/")[1];
    // The FCC gateway is keyless: no Authorization header is sent, and none
    // is resolved. A keyed deployment would resolve the value HERE, at the
    // last possible moment, never storing or logging it.
    const url = `${this.endpoint}/messages`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (this.beta) headers["anthropic-beta"] = this.beta;

    const payload = {
      model: modelName,
      messages: buildAnthropicMessages(request).messages,
      system: buildAnthropicMessages(request).system,
      max_tokens: this.defaultMaxTokens,
      tools: request.tools?.map(toAnthropicTool),
    };

    let response: HttpResponse | undefined;
    let lastStatus = 0;
    let lastTransportError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        response = await this.transport.post(url, payload, headers, opts?.signal);
        if (response.status !== 429 && response.status < 500) break;
        lastStatus = response.status;
        response = undefined;
      } catch (e) {
        if (opts?.signal?.aborted) {
          throw new AllInOneError("invocation cancelled by the caller", "PROVIDER_CANCELLED", "unavailable", {
            retryable: false,
          });
        }
        lastTransportError = e;
      }
      if (attempt < this.maxRetries && this.retryBackoffMs > 0) {
        await delay(this.retryBackoffMs * (attempt + 1));
      }
    }
    if (response === undefined) {
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

    const parsed = response.body as AnthropicResponse;
    if (parsed.error) {
      throw new AllInOneError(
        `${this.id} returned an error: ${redact(String(parsed.error.message ?? "unknown"))}`,
        "PROVIDER_CALL_FAILED",
        "unavailable",
        { retryable: false },
      );
    }

    const { text, toolCalls } = extractFromContent(parsed.content);
    if (!text && toolCalls.length === 0) {
      throw new AllInOneError(
        `${this.id} returned an empty completion`,
        "PROVIDER_CALL_FAILED",
        "unavailable",
        { retryable: false },
      );
    }

    const usage = parsed.usage;
    const costUsd = estimateCostFromUsageTokens(
      usage?.input_tokens,
      usage?.output_tokens,
      this.pricing,
      modelName,
    );

    return {
      providerId: this.id,
      modelId: request.model,
      capability: request.capability,
      ok: true,
      text,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      structured: request.structuredOutputSchema ? safeParseJson(text) : undefined,
      costUsd,
      promptTokens: usage?.input_tokens,
      completionTokens: usage?.output_tokens,
      latencyMs: Date.now() - started,
      finishReason: parsed.stop_reason,
      raw: undefined,
    };
  }

  /**
   * Streaming call (D11). The provider is asked for `stream: true` and the
   * resulting frame stream is tee'd to the caller via `onEvent`. The result
   * contract is identical to the buffered invocation.
   */

  private async invokeStreaming(
    request: ProviderInvokeRequest,
    opts: ProviderInvokeOptions,
  ): Promise<ProviderInvokeResult> {
    const started = Date.now();
    const modelName = request.model.split("/")[1];
    const url = `${this.endpoint}/messages`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (this.beta) headers["anthropic-beta"] = this.beta;

    if (!this.transport.postStream) {
      throw new AllInOneError(
        `${this.id} does not support streaming; its model descriptor declares it, which the descriptor and the transport must agree on`,
        "PROVIDER_CALL_FAILED",
        "config",
        { retryable: false },
      );
    }

    const payload = {
      model: modelName,
      messages: buildAnthropicMessages(request).messages,
      system: buildAnthropicMessages(request).system,
      max_tokens: this.defaultMaxTokens,
      tools: request.tools?.map(toAnthropicTool),
      stream: true,
    };

    let delivered = 0;
    let lastStatus = 0;
    let lastIterError: unknown;
    type AttemptResult = {
      text: string;
      toolCalls: ProviderToolCall[];
      finishReason?: string;
      inputTokens?: number;
      outputTokens?: number;
    };
    let assembled: AttemptResult | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response: StreamTransportResponse = await this.transport.postStream(url, payload, headers, opts.signal);
        lastStatus = response.status;
        if (response.status === 429 || response.status >= 500) {
          await response.events[Symbol.asyncIterator]().return?.().catch(() => undefined);
          lastIterError = new Error(`HTTP ${response.status}`);
          if (attempt < this.maxRetries && delivered === 0) {
            if (this.retryBackoffMs > 0) await delay(this.retryBackoffMs * (attempt + 1));
            continue;
          }
          break;
        }
        if (response.status < 200 || response.status >= 300) {
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
          throw new AllInOneError(
            `${this.id} returned HTTP ${response.status}`,
            "PROVIDER_CALL_FAILED",
            "unavailable",
            { retryable: false },
          );
        }

        const textParts: string[] = [];
        const toolByIndex = new Map<number, { id?: string; toolName?: string; arguments: string }>();
        let finishReason: string | undefined;
        let inputTokens: number | undefined;
        let outputTokens: number | undefined;

        for await (const event of response.events) {
          delivered++;
          try {
            opts.onEvent?.(event);
          } catch {
            /* a failing consumer never breaks the provider call */
          }
          if (event.kind === "text") textParts.push(event.text);
          else if (event.kind === "tool-call-delta") {
            const entry = toolByIndex.get(event.index) ?? { arguments: "" };
            if (event.id) entry.id = event.id;
            if (event.toolName) entry.toolName = event.toolName;
            if (event.argumentsDelta) entry.arguments += event.argumentsDelta;
            toolByIndex.set(event.index, entry);
          } else if (event.kind === "finish") finishReason = event.finishReason;
          else if (event.kind === "usage") {
            if (typeof event.promptTokens === "number") inputTokens = event.promptTokens;
            if (typeof event.completionTokens === "number") outputTokens = event.completionTokens;
          }
        }

        const toolCalls: ProviderToolCall[] = [...toolByIndex.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, entry]) => ({
            id: entry.id && entry.id.length > 0 ? entry.id : `call_${toolByIndex.size}`,
            toolName: entry.toolName ?? "",
            input: parseArguments(entry.arguments),
          }))
          .filter((c) => c.toolName.length > 0);

        assembled = { text: textParts.join(""), toolCalls, finishReason, inputTokens, outputTokens };
        lastIterError = undefined;
        break;
      } catch (e) {
        if (opts.signal?.aborted) {
          throw new AllInOneError("streaming invocation cancelled by the caller", "PROVIDER_CANCELLED", "unavailable", {
            retryable: false,
          });
        }
        if (e instanceof AllInOneError && !e.retryable) throw e;
        lastIterError = e;
        if (delivered > 0) break;
        if (attempt < this.maxRetries && this.retryBackoffMs > 0) {
          await delay(this.retryBackoffMs * (attempt + 1));
        }
      }
    }

    if (assembled === undefined) {
      if (lastStatus === 429) {
        throw new AllInOneError(
          `${this.id} rate-limited the request (HTTP 429): failed after ${this.maxRetries + 1} attempts`,
          "PROVIDER_RATE_LIMITED",
          "unavailable",
          { retryable: true },
        );
      }
      if (lastIterError instanceof AllInOneError) throw lastIterError;
      const wasInterrupted = delivered > 0;
      throw new AllInOneError(
        wasInterrupted
          ? `${this.id} interrupted the stream after ${delivered} event(s): ${describe(lastIterError)}`
          : `Request to ${this.id} failed after ${this.maxRetries + 1} attempts: ${describe(lastIterError)}`,
        wasInterrupted ? "PROVIDER_STREAM_INTERRUPTED" : "PROVIDER_UNREACHABLE",
        "unavailable",
        { retryable: !wasInterrupted, cause: lastIterError },
      );
    }

    const { text, toolCalls, finishReason, inputTokens, outputTokens } = assembled;
    if (!text && toolCalls.length === 0) {
      throw new AllInOneError(`${this.id} returned an empty completion`, "PROVIDER_CALL_FAILED", "unavailable", {
        retryable: false,
      });
    }

    const costUsd = estimateCostFromUsageTokens(inputTokens, outputTokens, this.pricing, modelName);

    return {
      providerId: this.id,
      modelId: request.model,
      capability: request.capability,
      ok: true,
      text,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      structured: request.structuredOutputSchema ? safeParseJson(text) : undefined,
      costUsd,
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      latencyMs: Date.now() - started,
      finishReason,
      raw: undefined,
    };
  }
}

/** Wire shape for one declared tool. A declaration grants no execution right. */
function toAnthropicTool(decl: ProviderToolDeclaration) {
  return {
    name: decl.name,
    description: decl.description,
    input_schema: decl.input,
  };
}

/**
 * Split the provider's `content` array into prose and tool calls. Anthropic
 * sends text as `{type: "text", text}` and tool requests as
 * `{type: "tool_use", id, name, input}`; a turn is successful when it produced
 * text OR asked for tools.
 */
function extractFromContent(content: ReadonlyArray<AnthropicContentBlock> | undefined): {
  text: string;
  toolCalls: ProviderToolCall[];
} {
  if (!Array.isArray(content)) return { text: "", toolCalls: [] };
  const textParts: string[] = [];
  const toolCalls: ProviderToolCall[] = [];
  for (const block of content) {
    if (block.type === "text") {
      if (block.text) textParts.push(block.text);
    } else if (block.type === "tool_use") {
      const name = typeof block.name === "string" ? block.name : "";
      if (name.length === 0) continue;
      toolCalls.push({
        id: typeof block.id === "string" && block.id.length > 0 ? block.id : `call_${toolCalls.length + 1}`,
        toolName: name,
        input: block.input && typeof block.input === "object" && !Array.isArray(block.input)
          ? (block.input as Record<string, unknown>)
          : {},
      });
    }
  }
  return { text: textParts.join(""), toolCalls };
}

/**
 * Build the Anthropic wire payload. Anthropic separates `system` from
 * `messages`, represents an assistant turn with `tool_use` content blocks, and
 * expects tool results wrapped in a `user` message carrying `tool_result`
 * blocks. Consecutive tool results are folded into one user message.
 */
function buildAnthropicMessages(request: ProviderInvokeRequest): { system: string | undefined; messages: unknown[] } {
  const systemParts: string[] = [];
  const messages: unknown[] = [];
  let pendingToolResults: { tool_use_id: string; content: string }[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length > 0) {
      messages.push({
        role: "user",
        content: pendingToolResults.map((r) => ({ type: "tool_result", tool_use_id: r.tool_use_id, content: r.content })),
      });
      pendingToolResults = [];
    }
  };

  const list = request.messages && request.messages.length > 0 ? request.messages : request.inputs.map((i) => ({ role: "user" as const, content: i.kind === "text" ? i.text : "" }));
  for (const m of list) {
    if (m.role === "system") {
      flushToolResults();
      if (m.content) systemParts.push(m.content);
      continue;
    }
    if (m.role === "tool") {
      pendingToolResults.push({ tool_use_id: m.toolCallId, content: m.content });
      continue;
    }
    flushToolResults();
    if (m.role === "assistant") {
      const content: AnthropicContentBlock[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      if (m.toolCalls && m.toolCalls.length > 0) {
        for (const c of m.toolCalls) {
          const args = safeParseJson(c.arguments);
          content.push({
            type: "tool_use",
            id: c.id,
            name: c.toolName,
            input: args && typeof args === "object" && !Array.isArray(args) ? args : {},
          });
        }
      }
      messages.push({ role: "assistant", content });
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }
  flushToolResults();
  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Derive the real cost from the token counts the provider reported and the
 * registered rate. Anthropic reports `input_tokens` / `output_tokens` rather
 * than the OpenAI `prompt_tokens` / `completion_tokens` names, so this adapter
 * takes them directly. Without either, the answer is 0 — cost is never
 * invented, and the engine records usage separately so nothing is silently
 * free.
 */
function estimateCostFromUsageTokens(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  pricing: Readonly<Record<string, { readonly input: number; readonly output: number }>>,
  modelName: string,
): number {
  if (typeof inputTokens !== "number" && typeof outputTokens !== "number") return 0;
  const rate = pricing[modelName];
  if (!rate) return 0;
  const input = Math.max(0, inputTokens ?? 0);
  const output = Math.max(0, outputTokens ?? 0);
  return Number(((input * rate.input + output * rate.output) / 1_000_000).toFixed(6));
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
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

function describe(e: unknown): string {
  const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  // Defensive: a network error must never smuggle a key into an error message.
  return redact(message);
}

const defaultTransport: HttpTransport = {
  async post(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<HttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: signal ?? controller.signal,
      });
      const parsed = (await response.json()) as unknown;
      return { status: response.status, body: parsed };
    } finally {
      clearTimeout(timer);
    }
  },

  /**
   * Streaming transport seam (D11). The AbortSignal reaches `fetch` itself,
   * so a cancelled/timed-out invocation tears down the socket, not merely
   * the caller's wait. The returned body is a raw-byte stream parsed by
   * `parseSseEvents`; nothing here invents cost or text.
   */
  async postStream(
    url: string,
    body: unknown,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<StreamTransportResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: signal ?? controller.signal,
      });
      if (!response.body) {
        throw new Error(`${url} returned no streamable body`);
      }
      return { status: response.status, events: parseSseEvents(response.body) };
    } finally {
      clearTimeout(timer);
    }
  },
};

/**
 * Parse an SSE stream of Anthropic Messages frames into StreamEvents.
 * Anthropic frames carry an `event:` line naming the frame type and a `data:`
 * line carrying the JSON payload. Tolerates `: keepalive` comments and blank
 * separators; an unparseable `data:` payload becomes a typed failure — it is
 * never swallowed, and no partial content is reported as complete.
 */
async function* parseSseEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<StreamEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const event of eventsFromBlock(block)) yield event;
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail.length > 0) {
      for (const event of eventsFromBlock(tail)) yield event;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* the socket may already be closed by an abort — that is the point */
    }
  }
}

/**
 * Map one Anthropic SSE block to StreamEvents. The `event:` line selects the
 * frame semantics; `message_start` carries the input-token budget,
 * `content_block_start` announces a tool call, `content_block_delta` carries
 * prose and argument fragments, and `message_delta` carries the stop reason
 * and the output-token count.
 */
function eventsFromBlock(block: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  let eventType = "";
  let dataLine = "";
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLine = line.slice(5).trim();
    }
  }
  if (dataLine.length === 0) return events;
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataLine);
  } catch {
    throw new AllInOneError(
      `Provider sent an unparseable SSE frame: ${redact(dataLine.slice(0, 120))}`,
      "PROVIDER_CALL_FAILED",
      "unavailable",
      { retryable: false },
    );
  }
  const frame = parsed as AnthropicStreamFrame;
  if (frame.error) {
    throw new AllInOneError(
      `Provider returned an error frame: ${redact(String(frame.error.message ?? "unknown"))}`,
      "PROVIDER_CALL_FAILED",
      "unavailable",
      { retryable: false },
    );
  }

  switch (eventType) {
    case "message_start": {
      const inputTokens = frame.message?.usage?.input_tokens;
      if (typeof inputTokens === "number") {
        events.push({ kind: "usage", promptTokens: inputTokens });
      }
      break;
    }
    case "content_block_start": {
      const cb = frame.content_block;
      if (
        cb &&
        cb.type === "tool_use" &&
        typeof cb.id === "string" &&
        typeof cb.name === "string"
      ) {
        events.push({
          kind: "tool-call-delta",
          index: typeof frame.index === "number" ? frame.index : 0,
          id: cb.id,
          toolName: cb.name,
        });
      }
      break;
    }
    case "content_block_delta": {
      const delta = frame.delta;
      if (!delta) break;
      if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
        events.push({ kind: "text", text: delta.text });
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string" && delta.partial_json.length > 0) {
        events.push({
          kind: "tool-call-delta",
          index: typeof frame.index === "number" ? frame.index : 0,
          argumentsDelta: delta.partial_json,
        });
      }
      break;
    }
    case "message_delta": {
      const stopReason = frame.delta?.stop_reason;
      if (stopReason) events.push({ kind: "finish", finishReason: stopReason });
      const outputTokens = frame.usage?.output_tokens;
      if (typeof outputTokens === "number") {
        events.push({ kind: "usage", completionTokens: outputTokens });
      }
      break;
    }
  }
  return events;
}
