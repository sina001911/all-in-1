/**
 * Provider adapter suite (P3).
 *
 * P3 adapters are metadata + validation only: no adapter performs network I/O,
 * and `invoke()` is declared but unimplemented. What IS implemented and pinned
 * here is provider isolation — a model may only be served by the adapter that
 * owns its provider id, and only for capabilities that adapter is registered
 * to serve. Secrets are referenced by env-variable NAME only, never a value.
 */
import { describe, expect, it } from "vitest";
import {
  BaseProviderAdapter,
  PROVIDER_PROTOCOLS,
} from "../src/providers/types.ts";
import type { ProviderAdapterOptions } from "../src/providers/types.ts";
import { ModelCatalog } from "../src/models/catalog.ts";
import type { ModelDescriptor } from "../src/models/types.ts";
import type { ProviderInvokeRequest } from "../src/providers/types.ts";
import { isAllInOneError } from "../src/errors.ts";

function invoke(model: string, capability: string): ProviderInvokeRequest {
  return { model, capability, inputs: [{ kind: "text", text: "hello" }] };
}

function mkAdapter(over: Partial<ProviderAdapterOptions> = {}): BaseProviderAdapter {
  return new BaseProviderAdapter({
    id: over.id ?? "acme",
    displayName: over.displayName ?? "Acme",
    protocol: over.protocol ?? "openai-compatible",
    locality: over.locality ?? "remote",
    apiKeyEnv: over.apiKeyEnv ?? "ACME_KEY",
    endpoint: over.endpoint ?? "https://api.acme.example/v1",
    capabilities: over.capabilities ?? ["CODING"],
    knownEndpointIssues: over.knownEndpointIssues,
    availableWithoutCredentials: over.availableWithoutCredentials,
  });
}

function mkModel(over: Partial<ModelDescriptor> & { readonly id: string }): ModelDescriptor {
  const slash = over.id.indexOf("/");
  const provider = over.provider ?? over.id.slice(0, slash);
  const modelId = over.modelId ?? over.id.slice(slash + 1);
  return {
    id: over.id,
    provider,
    modelId,
    displayName: over.displayName ?? modelId,
    capabilities: over.capabilities ?? ["CODING"],
    inputModalities: over.inputModalities ?? ["TEXT"],
    outputModalities: over.outputModalities ?? ["TEXT"],
    contextLimit: over.contextLimit ?? 128000,
    outputLimit: over.outputLimit ?? 8192,
    tools: over.tools ?? false,
    structuredOutput: over.structuredOutput ?? true,
    streaming: over.streaming ?? true,
    pricing: over.pricing ?? { costClass: "FREE" },
    available: over.available ?? true,
    locality: over.locality ?? "remote",
    status: over.status ?? "active",
    providerAdapter: over.providerAdapter ?? `${provider}-adapter`,
    priority: over.priority ?? 0,
    enabled: over.enabled ?? true,
  };
}

describe("BaseProviderAdapter configuration", () => {
  it("records metadata and defaults optional fields", () => {
    const a = mkAdapter();
    expect(a.id).toBe("acme");
    expect(a.displayName).toBe("Acme");
    expect(a.protocol).toBe("openai-compatible");
    expect(a.locality).toBe("remote");
    expect(a.apiKeyEnv).toBe("ACME_KEY");
    expect(a.endpoint).toBe("https://api.acme.example/v1");
    expect(a.knownEndpointIssues).toEqual([]);
    expect(a.availableWithoutCredentials).toBe(false);
  });

  it("keeps declared endpoint issues", () => {
    const a = mkAdapter({ knownEndpointIssues: ["EU endpoint returns 403"] });
    expect(a.knownEndpointIssues).toContain("EU endpoint returns 403");
  });

  it("supports only the capabilities it is registered for", () => {
    const a = mkAdapter({ capabilities: ["CODING", "DEBUGGING"] });
    expect(a.supportsCapability("CODING")).toBe(true);
    expect(a.supportsCapability("DEBUGGING")).toBe(true);
    expect(a.supportsCapability("VISION")).toBe(false);
  });

  it("isReachableWithoutCredentials never reads a key or opens a connection", () => {
    expect(mkAdapter().isReachableWithoutCredentials()).toBe(false);
    expect(mkAdapter({ availableWithoutCredentials: true }).isReachableWithoutCredentials()).toBe(
      true,
    );
  });
});

describe("BaseProviderAdapter validateModel", () => {
  it("accepts a model owned by this provider on this adapter", () => {
    const a = mkAdapter();
    expect(a.validateModel(mkModel({ id: "acme/coder", providerAdapter: "acme" }))).toBe(true);
  });

  it("rejects a model owned by another provider", () => {
    const a = mkAdapter();
    const reason = a.validateModel(mkModel({ id: "beta/coder", provider: "beta" }));
    expect(reason).not.toBe(true);
    expect(reason).toMatch(/does not match adapter 'acme'/);
  });

  it("rejects a model declaring a different adapter", () => {
    const a = mkAdapter();
    const reason = a.validateModel(
      mkModel({ id: "acme/coder", providerAdapter: "legacy-adapter" }),
    );
    expect(reason).not.toBe(true);
    expect(reason).toMatch(/declares adapter 'legacy-adapter'/);
  });
});

describe("BaseProviderAdapter validateInvoke", () => {
  function catalogWith(...models: ModelDescriptor[]): ModelCatalog {
    const catalog = new ModelCatalog();
    for (const model of models) catalog.register(model);
    return catalog;
  }

  it("passes for a healthy, owned, capability-matching model", () => {
    const a = mkAdapter();
    const catalog = catalogWith(mkModel({ id: "acme/coder", capabilities: ["CODING"] }));
    expect(() => a.validateInvoke(invoke("acme/coder", "CODING"), catalog)).not.toThrow();
  });

  it("rejects an unknown model id", () => {
    const a = mkAdapter();
    const catalog = catalogWith();
    const error = catchAllInOne(() => a.validateInvoke(invoke("acme/ghost", "CODING"), catalog));
    expect(error?.code).toBe("MODEL_NOT_FOUND");
    expect(error?.category).toBe("config");
  });

  it("rejects a model owned by another provider (isolation)", () => {
    const a = mkAdapter();
    const catalog = catalogWith(
      mkModel({ id: "beta/coder", provider: "beta", capabilities: ["CODING"] }),
    );
    const error = catchAllInOne(() => a.validateInvoke(invoke("beta/coder", "CODING"), catalog));
    expect(error?.code).toBe("PROVIDER_ISOLATION_VIOLATION");
    expect(error?.category).toBe("security");
  });

  it("rejects a disabled model", () => {
    const a = mkAdapter();
    const catalog = catalogWith(mkModel({ id: "acme/off", enabled: false }));
    const error = catchAllInOne(() => a.validateInvoke(invoke("acme/off", "CODING"), catalog));
    expect(error?.code).toBe("MODEL_UNAVAILABLE");
  });

  it("rejects an unavailable model", () => {
    const a = mkAdapter();
    const catalog = catalogWith(mkModel({ id: "acme/down", available: false }));
    const error = catchAllInOne(() => a.validateInvoke(invoke("acme/down", "CODING"), catalog));
    expect(error?.code).toBe("MODEL_UNAVAILABLE");
    expect(error?.category).toBe("unavailable");
  });

  it("rejects a capability the model does not declare", () => {
    const a = mkAdapter();
    const catalog = catalogWith(mkModel({ id: "acme/coder", capabilities: ["REASONING"] }));
    const error = catchAllInOne(() => a.validateInvoke(invoke("acme/coder", "CODING"), catalog));
    expect(error?.code).toBe("CAPABILITY_NOT_SUPPORTED");
    expect(error?.category).toBe("config");
  });

  it("rejects a capability the provider is not registered to serve", () => {
    const a = mkAdapter({ capabilities: ["VISION"] });
    const catalog = catalogWith(mkModel({ id: "acme/coder", capabilities: ["CODING"] }));
    const error = catchAllInOne(() => a.validateInvoke(invoke("acme/coder", "CODING"), catalog));
    expect(error?.code).toBe("CAPABILITY_NOT_SUPPORTED");
    expect(error?.category).toBe("security");
  });
});

describe("BaseProviderAdapter invoke (P3: not implemented)", () => {
  it("throws NOT_IMPLEMENTED and is not retryable", async () => {
    const a = mkAdapter();
    const error = await a.invoke(invoke("acme/coder", "CODING")).catch((e) => e);
    expect(isAllInOneError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("NOT_IMPLEMENTED");
    expect((error as { category: string }).category).toBe("unavailable");
    expect((error as { retryable: boolean }).retryable).toBe(false);
    expect((error as Error).message).toMatch(/not implemented in P3/);
  });
});

describe("PROVIDER_PROTOCOLS", () => {
  it("declares the baseline protocol vocabulary", () => {
    expect([...PROVIDER_PROTOCOLS]).toEqual(
      expect.arrayContaining([
        "atria",
        "openai-compatible",
        "openrouter",
        "local",
        "fake",
      ]),
    );
  });
});

function catchAllInOne(fn: () => void) {
  try {
    fn();
    return undefined;
  } catch (e) {
    if (isAllInOneError(e)) return e;
    throw new Error(`expected an AllInOneError, got: ${String(e)}`);
  }
}
