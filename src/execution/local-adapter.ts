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
import type { ProviderInvokeRequest } from "../providers/types.ts";
import type { ProviderInvokeResult } from "./types.ts";

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

  override async invoke(request: ProviderInvokeRequest): Promise<ProviderInvokeResult> {
    const started = Date.now();
    const hash = sha256(JSON.stringify({ model: request.model, inputs: request.inputs }));
    const text = buildText(request, hash);
    return {
      providerId: this.id,
      modelId: request.model,
      capability: request.capability,
      ok: true,
      text,
      structured: request.structuredOutputSchema ? { summary: text } : undefined,
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
    streaming: false,
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
    streaming: false,
    pricing: { costClass: "FREE", notes: "zero cost by construction — no network, no credential" },
    available: true,
    locality: "local",
    status: "active",
    providerAdapter: "local",
    priority: 0,
    enabled: true,
  });
}
