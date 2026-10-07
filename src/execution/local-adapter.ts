/**
 * Local provider adapter (P4) — the deterministic, zero-network adapter.
 *
 * It is registered by default because it is the only adapter whose zero cost
 * is verifiable by construction: it makes no network call, reads no
 * credential, and touches no file. Under the frozen defaults (`FREE_ONLY`,
 * `spendBudgetUsd = 0`) it is the effective provider for every capability that
 * has no verified remote model, so the execution layer is always exercisable
 * without credentials.
 *
 * Output is deterministic and content-derived from the request hash: identical
 * inputs always produce identical outputs. Nothing is invented about a real
 * model's judgement; the *contract shape*, not the judgement, is what is under
 * test.
 *
 * Protocol: `local` (already declared in `PROVIDER_PROTOCOLS`).
 */
import { createHash } from "node:crypto";
import { BaseProviderAdapter } from "../providers/types.ts";
import type { ProviderInvokeRequest, ProviderInvokeOptions } from "../providers/types.ts";
import type { ProviderInvokeResult, ProviderToolCall } from "./types.ts";

export class LocalAdapter extends BaseProviderAdapter {
  constructor() {
    super({
      id: "local",
      displayName: "Deterministic Local Adapter",
      protocol: "local",
      locality: "local",
      apiKeyEnv: null,
      endpoint: null,
      capabilities: [
        "CODING",
        "CODE_REVIEW",
        "DEBUGGING",
        "REASONING",
        "DEEP_REASONING",
        "PLANNING",
        "FAST_TASK",
        "VISION",
        "SCREENSHOT_ANALYSIS",
        "DOCUMENT_VISION",
        "OCR",
        "EMBEDDING",
      ],
      availableWithoutCredentials: true,
    });
  }

  override async invoke(
    request: ProviderInvokeRequest,
    opts?: ProviderInvokeOptions,
  ): Promise<ProviderInvokeResult> {
    const started = Date.now();
    const hash = sha256(JSON.stringify({ model: request.model, inputs: request.inputs }));
    const text = buildText(request, hash);
    // The deterministic adapter has no network stream; when a caller asks for
    // streaming it still honours the contract by emitting exactly one event
    // carrying its whole deterministic payload. It never claims postStream.
    if (opts?.stream === true) {
      try {
        opts.onEvent?.({ kind: "text", text });
        opts.onEvent?.({ kind: "finish", finishReason: "stop" });
      } catch {
        /* a failing consumer never breaks the call */
      }
    }
    return {
      providerId: this.id,
      modelId: request.model,
      capability: request.capability,
      ok: true,
      text,
      structured: request.structuredOutputSchema ? { summary: text } : undefined,
      toolCalls: parseToolCalls(request),
      costUsd: 0, // genuinely zero-cost by construction
      latencyMs: Date.now() - started,
      finishReason: "stop",
      raw: undefined,
    };
  }
}

function buildText(request: ProviderInvokeRequest, hash: string): string {
  const textInputs = request.inputs
    .filter((i) => i.kind === "text")
    .map((i) => (i as { kind: "text"; text: string }).text);
  const imageInputs = request.inputs.filter((i) => i.kind === "image").length;
  const parts = [
    `[local:${request.capability}] deterministic response for model ${request.model}`,
    `content-hash: ${hash.slice(0, 16)}`,
    `text-inputs: ${textInputs.length}`,
  ];
  if (imageInputs > 0) parts.push(`image-inputs: ${imageInputs} (not decoded by the local adapter)`);
  if (textInputs.length) {
    const first = textInputs[0] as string;
    parts.push(`echo: ${first.slice(0, 120)}`);
  }
  return parts.join("\n");
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Deterministic tool-call protocol (D4).
 *
 * A real model decides which tools to call from the declarations it is offered.
 * The local adapter has no judgement, so the last text input may state the
 * decision directly in a fenced block, and the adapter replays it verbatim:
 *
 *     ```tool-calls
 *     [{ "id": "1", "toolName": "files.read", "input": { "path": "a.txt" },
 *        "justification": "need the config" }]
 *     ```
 *
 * This keeps the adapter honest about what it is — a deterministic stand-in for
 * a model — while making the whole agent loop exercisable offline and without
 * credentials. Malformed JSON is ignored (no tool calls), never thrown: a
 * broken directive degrades to a text turn.
 *
 * The match is anchored to the END of the input, so only a block in the
 * CURRENT prompt is honoured: a conversation transcript carries earlier
 * prompts, and replaying a past turn's calls would make this deterministic
 * model say something its current instruction never asked for.
 */
const TOOL_CALLS_RE = /```tool-calls\s*\n?([\s\S]*?)```/g;

function parseToolCalls(request: ProviderInvokeRequest): ProviderToolCall[] | undefined {
  const texts = request.inputs.filter((i) => i.kind === "text") as { kind: "text"; text: string }[];
  const last = texts[texts.length - 1];
  if (!last) return undefined;
  // The current prompt is the last user message in the transcript, so its
  // directive is the LAST fenced block. Honour it only when nothing but
  // whitespace follows it — a block mid-transcript belongs to an earlier turn.
  const matches = [...last.text.matchAll(TOOL_CALLS_RE)];
  const match = matches[matches.length - 1];
  if (!match || match.index === undefined) return undefined;
  if (last.text.slice(match.index + match[0].length).trim() !== "") return undefined;
  try {
    const parsed = JSON.parse(match[1] as string);
    if (!Array.isArray(parsed)) return undefined;
    const calls = parsed.filter(
      (c): c is ProviderToolCall =>
        c !== null &&
        typeof c === "object" &&
        typeof (c as ProviderToolCall).id === "string" &&
        typeof (c as ProviderToolCall).toolName === "string" &&
        (c as ProviderToolCall).input !== null &&
        typeof (c as ProviderToolCall).input === "object",
    );
    return calls.length > 0 ? calls : undefined;
  } catch {
    return undefined;
  }
}

const TEXT_CAPABILITIES = [
  "CODING",
  "CODE_REVIEW",
  "DEBUGGING",
  "REASONING",
  "DEEP_REASONING",
  "PLANNING",
  "FAST_TASK",
  "EMBEDDING",
];

const VISION_CAPABILITIES = [
  "VISION",
  "SCREENSHOT_ANALYSIS",
  "DOCUMENT_VISION",
  "OCR",
];

/**
 * Register the deterministic local models into a catalogue. These are the ONLY
 * models that ship enabled by default: their zero cost is verifiable by
 * construction, so the execution layer is always exercisable offline and
 * without credentials. Every real provider stays unregistered until a user
 * explicitly and deliberately adds it.
 */
export function registerLocalModels(catalog: import("../models/catalog.ts").ModelCatalog): void {
  catalog.register({
    id: "local/deterministic",
    provider: "local",
    modelId: "deterministic",
    displayName: "Deterministic Local Model",
    capabilities: TEXT_CAPABILITIES,
    inputModalities: ["TEXT"],
    outputModalities: ["TEXT"],
    contextLimit: 128_000,
    outputLimit: 8_192,
    tools: false,
    structuredOutput: true,
    streaming: true,
    pricing: { costClass: "FREE", notes: "zero cost by construction — no network, no credential" },
    available: true,
    locality: "local",
    status: "active",
    providerAdapter: "local",
    priority: 0,
    enabled: true,
  });
  catalog.register({
    id: "local/vision",
    provider: "local",
    modelId: "vision",
    displayName: "Deterministic Local Vision Model",
    capabilities: VISION_CAPABILITIES,
    inputModalities: ["IMAGE", "TEXT"],
    outputModalities: ["TEXT"],
    contextLimit: 128_000,
    outputLimit: 8_192,
    tools: false,
    structuredOutput: true,
    streaming: true,
    pricing: { costClass: "FREE", notes: "zero cost by construction — no network, no credential" },
    available: true,
    locality: "local",
    status: "active",
    providerAdapter: "local",
    priority: 0,
    enabled: true,
  });
}

/**
 * Register the deterministic agent model (D4). NOT part of the default catalogue:
 * it is opted into by the desktop stack, which needs a tool-capable model so the
 * agent loop can run offline. The frozen default stack stays untouched, so its
 * inertness (no remote provider, deny-all egress, zero budget) is unchanged.
 *
 * Like the other local models its zero cost is verifiable by construction.
 */
export function registerLocalAgentModel(catalog: import("../models/catalog.ts").ModelCatalog): void {
  catalog.register({
    id: "local/agent",
    provider: "local",
    modelId: "agent",
    displayName: "Deterministic Local Agent Model",
    capabilities: AGENT_CAPABILITIES,
    inputModalities: ["TEXT", "IMAGE"],
    outputModalities: ["TEXT"],
    contextLimit: 128_000,
    outputLimit: 8_192,
    tools: true,
    structuredOutput: true,
    streaming: true,
    pricing: { costClass: "FREE", notes: "zero cost by construction — no network, no credential" },
    available: true,
    locality: "local",
    status: "active",
    providerAdapter: "local",
    priority: 0,
    enabled: true,
  });
}

const AGENT_CAPABILITIES = ["CODING", "CODE_REVIEW", "DEBUGGING", "REASONING", "DEEP_REASONING", "PLANNING", "FAST_TASK"];
