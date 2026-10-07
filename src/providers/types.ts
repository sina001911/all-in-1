/**
 * Provider adapter abstraction (P3).
 *
 * A provider adapter is the *representation* of how to talk to a provider:
 * its protocol, where it lives, how it authenticates (by env-variable NAME
 * only), and which capabilities it is allowed to serve. It is the extension
 * point for every provider — Atria, OpenAI-compatible APIs, OpenRouter, local
 * servers, and providers not yet known.
 *
 * P3 implements adapters as metadata + validation only. The live call path is
 * declared by the contract but NOT implemented: `invoke()` always throws
 * NOT_IMPLEMENTED. No adapter performs network I/O, and none reads, stores, or
 * logs a credential value.
 *
 * Provider isolation is enforced by `validateModel` / `supportsCapability`: a
 * model may only be served by the adapter that owns its provider id, and only
 * for capabilities that provider is registered to serve.
 */
import type { Locality } from "../models/types.ts";
import type { ModelDescriptor } from "../models/types.ts";
import type { ProviderInvokeResult, ProviderToolDeclaration } from "../execution/types.ts";
import { AllInOneError } from "../errors.ts";

export const PROVIDER_PROTOCOLS = [
  "atria",
  "openai-compatible",
  "openrouter",
  "local",
  "fake",
] as const;
export type ProviderProtocol = (typeof PROVIDER_PROTOCOLS)[number] | (string & {});

export interface ProviderAdapterOptions {
  readonly id: string;
  readonly displayName: string;
  readonly protocol: ProviderProtocol;
  readonly locality: Locality;
  /** Environment variable NAME holding the key, or null for keyless providers. */
  readonly apiKeyEnv: string | null;
  readonly endpoint: string | null;
  /** Capability ids this provider is allowed to serve. */
  readonly capabilities: readonly string[];
  readonly knownEndpointIssues?: readonly string[];
  /** True only when the provider can actually be reached without credentials. */
  readonly availableWithoutCredentials?: boolean;
}

/**
 * One structured message in a provider conversation (D7). Defined with the
 * other wire contracts in `execution/types.ts` and re-exported here so the
 * adapter abstraction is self-contained.
 */
export type { ProviderMessage } from "../execution/types.ts";
import type { ProviderMessage } from "../execution/types.ts";

export interface ProviderInvokeRequest {
  readonly model: string; // "provider/model"
  readonly capability: string;
  readonly inputs: ReadonlyArray<
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "image"; readonly artifactId: string }
  >;
  readonly structuredOutputSchema?: object;
  /**
   * The tools the model may call (D4), already filtered to what the caller
   * permits. An adapter passes these to the model so it can shape a request;
   * it never executes or approves one.
   */
  readonly tools?: readonly ProviderToolDeclaration[];
  /**
   * The conversation so far (D7). When present it is the faithful
   * representation and `inputs` is the flattened fallback for adapters (and
   * single-shot callers) that do not use a message list.
   */
  readonly messages?: readonly ProviderMessage[];
}

export interface ProviderAdapter extends ProviderAdapterOptions {
  /** Whether this provider may serve the capability (isolation check). */
  supportsCapability(capability: string): boolean;
  /** Validate that a model belongs to this provider. Returns a rejection reason or true. */
  validateModel(model: ModelDescriptor): true | string;
  /** Validate an invocation request against provider isolation rules. */
  validateInvoke(request: ProviderInvokeRequest, catalog: {
    get(id: string): ModelDescriptor | undefined;
  }): void;
  /**
   * Live model invocation. P3 declared this but left it throwing
   * NOT_IMPLEMENTED; P4 replaces the return type with the result contract.
   * The base class still throws NOT_IMPLEMENTED, so any adapter that has not
   * implemented a real call path fails safely and typed.
   */
  invoke(request: ProviderInvokeRequest): Promise<ProviderInvokeResult>;
}

/**
 * Shared adapter base. Subclasses configure options; validation and the
 * not-implemented invocation are common to every provider.
 */
export class BaseProviderAdapter implements ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly protocol: ProviderProtocol;
  readonly locality: Locality;
  readonly apiKeyEnv: string | null;
  readonly endpoint: string | null;
  readonly capabilities: readonly string[];
  readonly knownEndpointIssues: readonly string[];
  readonly availableWithoutCredentials: boolean;

  constructor(opts: ProviderAdapterOptions) {
    this.id = opts.id;
    this.displayName = opts.displayName;
    this.protocol = opts.protocol;
    this.locality = opts.locality;
    this.apiKeyEnv = opts.apiKeyEnv;
    this.endpoint = opts.endpoint;
    this.capabilities = opts.capabilities;
    this.knownEndpointIssues = opts.knownEndpointIssues ?? [];
    this.availableWithoutCredentials = opts.availableWithoutCredentials ?? false;
  }

  supportsCapability(capability: string): boolean {
    return this.capabilities.includes(capability);
  }

  validateModel(model: ModelDescriptor): true | string {
    if (model.provider !== this.id) {
      return `model provider '${model.provider}' does not match adapter '${this.id}'`;
    }
    if (model.providerAdapter !== this.id) {
      return `model '${model.id}' declares adapter '${model.providerAdapter}', not '${this.id}'`;
    }
    return true;
  }

  validateInvoke(
    request: ProviderInvokeRequest,
    catalog: { get(id: string): ModelDescriptor | undefined },
  ): void {
    const model = catalog.get(request.model);
    if (!model) {
      throw new AllInOneError(
        `Provider ${this.id}: unknown model ${request.model}`,
        "MODEL_NOT_FOUND",
        "config",
      );
    }
    if (model.provider !== this.id) {
      throw new AllInOneError(
        `Provider ${this.id} cannot serve model ${request.model} owned by ${model.provider}`,
        "PROVIDER_ISOLATION_VIOLATION",
        "security",
      );
    }
    if (!model.enabled || !model.available) {
      throw new AllInOneError(
        `Provider ${this.id}: model ${request.model} is not enabled and available`,
        "MODEL_UNAVAILABLE",
        "unavailable",
      );
    }
    if (!model.capabilities.includes(request.capability)) {
      throw new AllInOneError(
        `Provider ${this.id}: model ${request.model} does not declare capability ${request.capability}`,
        "CAPABILITY_NOT_SUPPORTED",
        "config",
      );
    }
    if (!this.supportsCapability(request.capability)) {
      throw new AllInOneError(
        `Provider ${this.id} is not registered to serve capability ${request.capability}`,
        "CAPABILITY_NOT_SUPPORTED",
        "security",
      );
    }
  }

  async invoke(_request: ProviderInvokeRequest): Promise<ProviderInvokeResult> {
    throw new AllInOneError(
      `${this.id}: live model invocation is not implemented in P3 (metadata + validation only)`,
      "NOT_IMPLEMENTED",
      "unavailable",
      { retryable: false },
    );
  }

  /**
   * Whether the provider could be reached given the current environment.
   * Deterministic and credential-free: it only inspects whether a key NAME is
   * required and whether the adapter declares itself available without one.
   * It never reads a value and never opens a connection.
   */
  isReachableWithoutCredentials(): boolean {
    return this.availableWithoutCredentials;
  }
}
