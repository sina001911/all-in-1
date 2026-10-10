/**
 * User-registered providers (D7).
 *
 * The execution stack ships inert: only the deterministic local models are
 * wired, egress is deny-all, and the budget is zero. This module is the
 * ADDITIVE path by which a user opens the stack to a real model server —
 * without touching a single frozen default.
 *
 * The intended target is a LOCAL OpenAI-compatible server (Ollama, LM Studio,
 * vLLM) on loopback. Loopback egress is permitted by the default policy, a
 * local server costs nothing, needs no credential, and so satisfies the frozen
 * FREE_ONLY policy and the zero budget at once. A REMOTE host works too, but
 * only after the user has allowlisted it AND granted a budget — the frozen
 * defaults remain exactly what they are.
 *
 * Every field is validated here, in the main process, BEFORE anything reaches
 * the engine. The renderer never supplies a path, a key VALUE, or an adapter
 * instance; it supplies a description, and this module decides what it may do.
 */
import { ModelCatalog } from "../models/catalog.ts";
import type { ModelDescriptor, Locality, ModelStatus } from "../models/types.ts";
import { AdapterRegistry as ProviderAdapterRegistry } from "./adapter-registry.ts";
import { OpenAICompatibleAdapter } from "./openai-compatible-adapter.ts";

/** One model a user declared at a provider. */
export interface UserProvidedModel {
  /** The model name the server knows it by. */
  readonly id: string;
  /**
   * Optional: registration falls back to the model id when it is absent (and
   * again to the provider id), so a descriptor that omits it is still valid.
   */
  readonly displayName?: string;
  readonly capabilities?: readonly string[];
  readonly contextLimit?: number;
  readonly outputLimit?: number;
  readonly tools?: boolean;
  /** USD per 1M tokens. Omit for a free/local server. */
  readonly costPer1MUsd?: { readonly input: number; readonly output: number };
  /**
   * Whether the model genuinely streams (D11). Defaults to false: a model is
   * only selectable for a streaming request when its descriptor says so.
   */
  readonly streaming?: boolean;
}

/** A provider a user wants the engine to talk to. */
export interface UserProvidedProvider {
  /** Registry id. Must not collide with the built-in `local` adapter. */
  readonly id: string;
  /**
   * Optional: registration falls back to the provider id when it is absent, so
   * a persisted provider that omits it is still a valid registration.
   */
  readonly displayName?: string;
  /** Base URL, e.g. `http://127.0.0.1:11434/v1`. */
  readonly endpoint: string;
  /**
   * Environment-variable NAME of the key, or null/omitted for a keyless local
   * server. A VALUE never enters this structure, the settings file, or the UI.
   */
  readonly apiKeyEnv?: string | null;
  readonly models: ReadonlyArray<UserProvidedModel>;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly enabled?: boolean;
}

export interface RegistrationResult {
  readonly providerId: string;
  readonly adapterId: string;
  readonly modelIds: readonly string[];
  /** Reasons a provider or model was skipped, for the user to see. */
  readonly warnings: readonly string[];
}

const BUILTIN_ADAPTER_IDS = new Set(["local"]);
const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Register one user provider: an adapter plus each of its models. Validation
 * failures SKIP the offending entry and return a warning rather than throwing,
 * because one bad entry in a saved settings file must not make the whole
 * application unsusable at startup.
 */
export function registerUserProvider(
  provider: UserProvidedProvider,
  adapters: ProviderAdapterRegistry,
  catalog: ModelCatalog,
): RegistrationResult {
  const warnings: string[] = [];
  const id = String(provider.id ?? "").trim();
  if (!SAFE_ID.test(id)) {
    return {
      providerId: id,
      adapterId: "",
      modelIds: [],
      warnings: [`provider id "${id}" is not a valid id (lowercase letters, digits, hyphens)`],
    };
  }
  if (BUILTIN_ADAPTER_IDS.has(id) || adapters.has(id)) {
    return {
      providerId: id,
      adapterId: "",
      modelIds: [],
      warnings: [`provider "${id}" is already registered; skipping`],
    };
  }
  const endpoint = String(provider.endpoint ?? "").trim();
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    return {
      providerId: id,
      adapterId: "",
      modelIds: [],
      warnings: [`provider "${id}" endpoint "${endpoint}" is not a valid URL`],
    };
  }
  // A remote endpoint must be https; plain http is refused even before the
  // egress gate sees it, so a mis-typed address never sends a key in clear.
  if (endpointUrl.protocol !== "https:" && !isLoopbackHost(endpointUrl.hostname)) {
    return {
      providerId: id,
      adapterId: "",
      modelIds: [],
      warnings: [
        `provider "${id}" endpoint must use https (or be a loopback address); refusing plain http to ${endpointUrl.hostname}`,
      ],
    };
  }

  const apiKeyEnv = provider.apiKeyEnv ? String(provider.apiKeyEnv).trim() : null;
  const adapter = new OpenAICompatibleAdapter({
    id,
    displayName: String(provider.displayName ?? id).slice(0, 80) || id,
    endpoint: endpoint.replace(/\/+$/, ""),
    apiKeyEnv: apiKeyEnv || null,
    capabilities: ["CODING", "CHAT", "DEEP_REASONING", "PLANNING", "FAST_TASK"],
    timeoutMs: provider.timeoutMs,
    maxRetries: provider.maxRetries,
    pricing: Object.fromEntries(
      (provider.models ?? [])
        .filter((m) => m.costPer1MUsd)
        .map((m) => [String(m.id), { input: m.costPer1MUsd!.input, output: m.costPer1MUsd!.output }]),
    ),
  });
  adapters.register(adapter);

  const modelIds: string[] = [];
  for (const m of provider.models ?? []) {
    const modelId = String(m.id ?? "").trim();
    if (modelId.length === 0) {
      warnings.push(`provider "${id}": a model with no id was skipped`);
      continue;
    }
    const composite = `${id}/${modelId}`;
    if (catalog.has(composite)) {
      warnings.push(`provider "${id}": model "${modelId}" is already registered; skipping`);
      continue;
    }
    const free = !m.costPer1MUsd;
    catalog.register({
      id: composite,
      provider: id,
      modelId,
      displayName: String(m.displayName ?? modelId).slice(0, 80) || modelId,
      capabilities: m.capabilities && m.capabilities.length > 0 ? m.capabilities : ["CODING", "CHAT"],
      inputModalities: ["TEXT"],
      outputModalities: ["TEXT"],
      contextLimit: Math.min(Math.max(m.contextLimit ?? 8_192, 1_024), 4_000_000),
      outputLimit: Math.min(Math.max(m.outputLimit ?? 4_096, 256), 1_000_000),
      tools: m.tools ?? true,
      structuredOutput: false,
      streaming: m.streaming === true,
      pricing: {
        costClass: free ? "FREE" : "PAID",
        inputPer1M: m.costPer1MUsd?.input,
        outputPer1M: m.costPer1MUsd?.output,
        notes: free
          ? "Declared by the user as a local/free endpoint"
          : "Declared by the user; pricing not independently verified",
      },
      available: provider.enabled !== false,
      enabled: provider.enabled !== false,
      locality: isLoopbackHost(endpointUrl.hostname) ? "local" : "remote",
      status: "active" as ModelStatus,
      providerAdapter: id,
      priority: 0,
    });
    modelIds.push(composite);
  }

  return { providerId: id, adapterId: id, modelIds, warnings };
}

/** Loopback literal check, kept free of any node import so it is testable anywhere. */
function isLoopbackHost(host: string): boolean {
  const lower = host.toLowerCase();
  return lower === "localhost" || lower === "127.0.0.1" || lower === "::1" || lower === "[::1]";
}

/** Re-exported so callers can describe a registered stack without importing the registry type. */
export type { Locality };
