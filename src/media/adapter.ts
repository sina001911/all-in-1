/**
 * Media adapter — real image generation (P1-6).
 *
 * Talks to an OpenAI-compatible `/images/generations` endpoint. The adapter is
 * a standalone class that takes an injectable `HttpTransport` so tests can feed
 * it a fake response without opening a socket. The default transport uses
 * global `fetch`.
 *
 * The media gate (`media.enabled = false` in the MVP) is enforced by the
 * router, not here. This class is pure: given a request and a transport, it
 * returns bytes or throws. It never touches the artifact store or the budget —
 * the router/facade does that.
 *
 * Supported capabilities: TEXT_TO_IMAGE, IMAGE_TO_IMAGE, IMAGE_EDIT.
 */
import type { HttpTransport, HttpResponse } from "../execution/types.ts";

export interface ImageGenOptions {
  readonly transport?: HttpTransport;
  readonly timeoutMs?: number;
  /**
   * Base endpoint, e.g. "https://openrouter.ai/api/v1". The adapter appends
   * the image-generation path: `/images/generations` by default (OpenAI
   * compatible), or whatever `imagePath` overrides it to — OpenRouter, for
   * instance, mounts image generation at `/images`.
   */
  readonly endpoint?: string;
  /** Override the image-generation path appended to `endpoint`. */
  readonly imagePath?: string;
  /**
   * D35: maximum attempts per call. Transient errors (transport failure,
   * HTTP 429, HTTP 5xx) are retried with a backoff; permanent errors
   * (401/403, 4xx client errors, empty response, no artifacts) are NOT
   * retried — retrying a rejected credential would only burn the human's
   * rate-limit window. Defaults to 1 (no retry).
   */
  readonly maxRetries?: number;
  /** D35: base delay between retries, in ms. The actual delay is
   *  `baseDelay * attempt` (linear backoff), capped at 30s. Defaults to 1s. */
  readonly retryDelayMs?: number;
}

export interface ImageGenRequest {
  readonly capability: string;
  /** Model id (the part after the slash in "provider/model"). */
  readonly model: string;
  readonly prompt: string;
  readonly size?: string;
  /** OpenRouter-style aspect ratio, e.g. "16:9", "1:1", "4:3". */
  readonly aspectRatio?: string;
  readonly n?: number;
  readonly seed?: number;
  /**
   * Reference images for image-to-image or editing. Each entry is a
   * base64-encoded data URI. OpenAI-compatible gateways accept a single
   * `image` field; OpenRouter accepts an `input_references` array.
   */
  readonly referenceImages?: readonly string[];
  /** When set, a base64-encoded image to edit or variant (legacy single-image form). */
  readonly imageUrl?: string;
  /** Optional quality hint ("auto", "low", "medium", "high", "max"). */
  readonly quality?: string;
  /** Optional output format ("png", "jpeg", "webp", "svg"). */
  readonly outputFormat?: string;
  /**
   * Optional resolution override, e.g. "1024x1024". The adapter forwards it to
   * the provider when set; otherwise it falls back to the model's first
   * declared preset. `durationSeconds` (video) is carried on the request but
   * only some providers honor it — the adapter forwards it when present.
   */
  readonly resolution?: string;
  /** Optional video duration in seconds (VIDEO_* capabilities). */
  readonly durationSeconds?: number;
  /**
   * Resolved bearer token, if the provider declares `apiKeyEnv`. The router
   * resolves the credential at call time and hands it here so the adapter can
   * attach the `Authorization` header. The value is never persisted, logged,
   * or included in an error message — the adapter attaches it only to the
   * outgoing request headers.
   */
  readonly apiKey?: string;
  /**
   * D35: an AbortSignal the human can use to cancel a generation mid-flight.
   * The adapter forwards it to the transport; on abort it throws a typed
   * `cancelled` media error so the caller can distinguish a human stop
   * from a transport failure. The signal is read once per attempt: a
   * retry after an abort would be pointless.
   */
  readonly signal?: AbortSignal;
}

export interface ImageGenResult {
  /** True when the provider returned at least one usable image. */
  readonly ok: boolean;
  /** Each entry is the provider's claim on what was generated. */
  readonly artifacts: ReadonlyArray<{ readonly b64Json: string; readonly mimeType: string }>;
  /**
   * Provider-reported cost in USD, if any. `undefined` when the provider did
   * not report one — the router must NOT treat that as free. Zero only when
   * the provider explicitly reports a zero cost.
   */
  readonly costUsd?: number;
  /** Warnings the provider emitted (e.g. deprecated field, fallback model). */
  readonly warnings: readonly string[];
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 1000;
const RETRY_BACKOFF_CAP_MS = 30_000;

/** Codes that are safe to retry: transient infrastructure errors. */
const RETRYABLE_CODES = new Set(["transport", "rate_limited", "server_error"]);

/** Codes that are permanent: retrying them wastes the human's rate-limit window. */
const PERMANENT_CODES = new Set([
  "credential_rejected",
  "bad_status",
  "empty_response",
  "no_artifacts",
  "provider_error",
  "cancelled",
]);

export class MediaAdapter {
  private readonly transport: HttpTransport;
  private readonly timeoutMs: number;
  private readonly endpoint: string;
  private readonly imagePath: string;

  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(opts: ImageGenOptions = {}) {
    this.transport = opts.transport ?? defaultTransport;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.endpoint = opts.endpoint ?? "";
    this.imagePath = opts.imagePath ?? "/images/generations";
    // `maxRetries` is the number of attempts, not the number of retries: the
    // loop runs `attempt <= maxRetries` starting at 1, so 0 would execute the
    // body zero times and every generation would fail before touching the
    // network. The frozen default is 0 ("no retries configured"), so clamp to
    // 1 here — one attempt, no retries — matching the adapter's own default.
    this.maxRetries = Math.max(1, opts.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  /**
   * Call the image generation endpoint and return the resulting bytes as
   * base64+mime pairs. The caller owns budget checks, artifact storage, and
   * the media gate — this is the last-mile call.
   *
   * Retry + cancellation: transient errors (transport failure, HTTP 429,
   * HTTP 5xx) are retried up to `maxRetries` times with linear backoff.
   * Permanent errors (401/403, 4xx client errors, empty response, no
   * artifacts, provider error) are NOT retried — retrying a rejected
   * credential would only burn the human's rate-limit window. A human
   * abort signal cancels the attempt immediately and is never retried.
   */
  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    const url = `${this.endpoint.replace(/\/+$/, "")}${this.imagePath}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    // The credential is resolved by the router and attached here only. It is
    // never stored, logged, or echoed into an error message.
    if (req.apiKey) headers.Authorization = `Bearer ${req.apiKey}`;
    const body = buildPayload(req);
    const signal = req.signal;

    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      if (signal?.aborted) {
        throw mediaError("cancelled", req, new Error("generation cancelled by user"));
      }
      try {
        return await this.invokeOnce(req, url, body, headers);
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        const code = mediaErrorCode(lastError);
        if (code === "cancelled") throw lastError;
        if (!RETRYABLE_CODES.has(code)) throw lastError;
        if (attempt >= this.maxRetries) throw lastError;
        const delay = Math.min(this.retryDelayMs * attempt, RETRY_BACKOFF_CAP_MS);
        await sleep(delay, signal);
      }
    }
    throw lastError ?? mediaError("transport", req, new Error("generation failed"));
  }

  /**
   * Single attempt: one transport call, one status check, one parse. Split
   * out so the retry loop can re-invoke it without duplicating the logic.
   */
  private async invokeOnce(
    req: ImageGenRequest,
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<ImageGenResult> {
    let resp: HttpResponse | undefined;
    let lastStatus = 0;
    try {
      resp = await this.transport.post(url, body, headers, req.signal);
      lastStatus = resp.status;
    } catch (e) {
      throw mediaError("transport", req, e);
    }

    if (lastStatus === 401 || lastStatus === 403) {
      throw mediaError("credential_rejected", req, new Error(`HTTP ${lastStatus}`));
    }
    if (lastStatus === 429) {
      throw mediaError("rate_limited", req, new Error(`HTTP ${lastStatus}`));
    }
    if (lastStatus >= 500) {
      throw mediaError("server_error", req, new Error(`HTTP ${lastStatus}`));
    }
    if (lastStatus < 200 || lastStatus >= 300) {
      throw mediaError("bad_status", req, new Error(`HTTP ${lastStatus}`));
    }

    const parsed = resp.body as {
      data?: ReadonlyArray<{
        url?: string;
        b64_json?: string;
        revised_prompt?: string;
        media_type?: string;
        mime_type?: string;
        error?: { message?: string; code?: string };
      }>;
      error?: { message?: string; code?: string };
      usage?: Record<string, unknown>;
    };
    if (parsed.error) {
      throw mediaError("provider_error", req, new Error(parsed.error.message ?? "unknown provider error"));
    }
    const items = (parsed.data ?? []) as Array<{
      url?: string;
      b64Json?: string;
      revisedPrompt?: string;
      mimeType?: string;
      error?: { message?: string };
    }>;
    // The OpenAI-compatible API returns snake_case keys (`b64_json`,
    // `revised_prompt`, `media_type`); the cast above only changes the
    // TypeScript type at compile time. Map them so the downstream code
    // reads camelCase uniformly. OpenRouter returns `media_type`; some
    // gateways return `mime_type`. Prefer the provider's claim over the
    // capability-based guess so a PNG that reports image/jpeg is not
    // mislabelled.
    for (const item of items) {
      const raw = item as unknown as Record<string, unknown>;
      if (raw["b64_json"] !== undefined) raw["b64Json"] = raw["b64_json"];
      if (raw["revised_prompt"] !== undefined) raw["revisedPrompt"] = raw["revised_prompt"];
      if (raw["media_type"] !== undefined) raw["mimeType"] = raw["media_type"];
      else if (raw["mime_type"] !== undefined) raw["mimeType"] = raw["mime_type"];
    }
    if (items.length === 0) {
      throw mediaError("empty_response", req, new Error("provider returned no images"));
    }

    const artifacts: Array<{ readonly b64Json: string; readonly mimeType: string }> = [];
    const warnings: string[] = [];
    for (const item of items) {
      if (item.error) {
        warnings.push(item.error.message ?? "item error");
        continue;
      }
      if (item.b64Json) {
        // The provider's reported MIME type wins over the capability-based
        // guess; fall back to the guess only when the provider stayed silent.
        artifacts.push({ b64Json: item.b64Json, mimeType: item.mimeType ?? inferMime(req) });
      } else if (item.url) {
        // A URL reference: store it as metadata but do not fetch here — the
        // facade stores the artifact and the renderer downloads it by id.
        warnings.push(`image served as url; bytes not available locally: ${item.url.slice(0, 80)}`);
      }
    }

    if (artifacts.length === 0 && warnings.length === 0) {
      throw mediaError("no_artifacts", req, new Error("provider gave no usable image data"));
    }
    if (artifacts.length === 0 && warnings.length > 0) {
      return { ok: false, artifacts: [], costUsd: 0, warnings };
    }

    // Cost is best-effort: the provider may not report usage on image endpoints.
    // When it does not, `undefined` is returned rather than 0 — the router
    // flags the result as cost-unknown and the facade manages it under the
    // budget policy instead of treating it as a free pass.
    const costUsd = estimateCost(parsed, req.model);

    return {
      ok: true,
      artifacts,
      costUsd,
      warnings: warnings.length > 0 ? warnings : [],
    };
  }

}

function buildPayload(req: ImageGenRequest): unknown {
  const payload: Record<string, unknown> = {
    model: req.model,
    prompt: req.prompt,
    n: req.n ?? 1,
  };
  if (req.size) payload.size = req.size;
  if (req.aspectRatio) payload.aspect_ratio = req.aspectRatio;
  if (typeof req.seed === "number") payload.seed = req.seed;
  if (req.quality) payload.quality = req.quality;
  if (req.outputFormat) payload.output_format = req.outputFormat;
  // The human's resolution/duration overrides are forwarded when set. The
  // model's first declared preset is the fallback (see pickSize in the
  // router); these fields let the human override it without editing config.
  if (req.resolution) payload.size = req.resolution;
  if (typeof req.durationSeconds === "number") payload.duration_seconds = req.durationSeconds;

  // Reference images for image-to-image or editing. OpenAI-compatible
  // gateways accept a single `image` field; OpenRouter accepts an
  // `input_references` array. Send both when a reference is present so the
  // provider picks the one it understands — unknown fields are ignored by
  // every major image-generation gateway.
  const refs: string[] = [];
  if (req.imageUrl) refs.push(req.imageUrl);
  if (req.referenceImages) {
    for (const r of req.referenceImages) {
      if (typeof r === "string" && r.length > 0 && !refs.includes(r)) refs.push(r);
    }
  }
  if (refs.length > 0) {
    if (req.capability === "IMAGE_EDIT" || req.capability === "IMAGE_TO_IMAGE") {
      payload.image = refs[0];
      payload.input_references = refs;
    }
  }
  return payload;
}

function inferMime(req: ImageGenRequest): string {
  if (req.capability === "TEXT_TO_VIDEO" || req.capability === "IMAGE_TO_VIDEO") return "video/mp4";
  return "image/png";
}

function estimateCost(parsed: unknown, _model: string): number | undefined {
  // Image generation providers rarely report token usage. When the response
  // carries no cost, return `undefined` — the router flags the result as
  // cost-unknown and the facade manages it under the budget policy instead of
  // treating it as a free pass. Zero is reserved for a provider that
  // explicitly reports a zero cost.
  const parsedObj = parsed as { usage?: Record<string, unknown> } | undefined;
  const usage = parsedObj?.usage;
  if (usage && typeof usage === "object") {
    const cost = (usage as Record<string, unknown>)["cost"];
    if (typeof cost === "number" && Number.isFinite(cost)) return cost;
  }
  return undefined;
}

function mediaError(code: string, req: ImageGenRequest, cause: unknown): Error {
  const msg = `Media generate ${req.capability} via ${req.model} failed (${code}): ${cause instanceof Error ? cause.message : String(cause)}`;
  const err = new Error(msg);
  (err as unknown as Record<string, unknown>)["__media"] = { code, capability: req.capability, model: req.model };
  return err;
}

const defaultTransport: HttpTransport = {
  async post(
    url: string,
    body: unknown,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<HttpResponse> {
    // Combine the caller's signal with our own timeout. If either fires,
    // the fetch is aborted. A human cancel wins: the timeout only fires
    // after the caller's signal is already dead.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const onCallerAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onCallerAbort, { once: true });
    }
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
      if (signal) signal.removeEventListener("abort", onCallerAbort);
    }
  },
};

function mediaErrorCode(err: Error): string {
  const meta = (err as unknown as Record<string, unknown>)["__media"];
  if (meta && typeof meta === "object") {
    const code = (meta as Record<string, unknown>)["code"];
    if (typeof code === "string") return code;
  }
  return "transport";
}

/**
 * Resolvable sleep that honours an abort signal. On abort it rejects with a
 * `cancelled` media error so the caller can distinguish a human stop from a
 * plain timeout.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(mediaError("cancelled", {} as ImageGenRequest, new Error("generation cancelled by user")));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(mediaError("cancelled", {} as ImageGenRequest, new Error("generation cancelled by user")));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}
