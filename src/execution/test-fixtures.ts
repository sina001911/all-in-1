/**
 * Test factory: a ModelCatalog + CapabilityRegistry + PriorityChains wired
 * together, so the selector and execution engine can be exercised without a
 * real provider. All models are deterministic fixtures; none performs I/O.
 */
import { ModelCatalog } from "../models/catalog.ts";
import { CapabilityRegistry } from "../capabilities/registry.ts";
import { registerBaselineCapabilities } from "../capabilities/capabilities.ts";
import { PriorityChains } from "../models/priorities.ts";
import type { ModelDescriptor } from "../models/types.ts";
import type { CostClass } from "../capabilities/types.ts";

export interface FixtureModel {
  readonly id: string;
  readonly capabilities: readonly string[];
  readonly costClass?: CostClass;
  readonly inputPer1M?: number;
  readonly outputPer1M?: number;
  readonly providerAdapter?: string;
  readonly priority?: number;
  readonly enabled?: boolean;
  readonly available?: boolean;
  readonly status?: ModelDescriptor["status"];
  readonly locality?: ModelDescriptor["locality"];
  readonly fallback?: string;
  readonly inputModalities?: ModelDescriptor["inputModalities"];
  readonly outputModalities?: ModelDescriptor["outputModalities"];
}

export interface CatalogFixture {
  readonly catalog: ModelCatalog;
  readonly capabilities: CapabilityRegistry;
  readonly chains: PriorityChains;
}

export function buildCatalogFixture(models: readonly FixtureModel[]): CatalogFixture {
  const catalog = new ModelCatalog();
  const capabilities = new CapabilityRegistry();
  registerBaselineCapabilities(capabilities);
  for (const model of models) {
    const slash = model.id.indexOf("/");
    const provider = model.id.slice(0, slash);
    const modelId = model.id.slice(slash + 1);
    const descriptor: ModelDescriptor = {
      id: model.id,
      provider,
      modelId,
      displayName: modelId,
      capabilities: [...model.capabilities],
      inputModalities: [...(model.inputModalities ?? ["TEXT"])],
      outputModalities: [...(model.outputModalities ?? ["TEXT"])],
      contextLimit: 128000,
      outputLimit: 8192,
      tools: false,
      structuredOutput: true,
      streaming: false,
      pricing: {
        costClass: model.costClass ?? "FREE",
        inputPer1M: model.inputPer1M,
        outputPer1M: model.outputPer1M,
      },
      available: model.available ?? true,
      locality: model.locality ?? "remote",
      status: model.status ?? "active",
      providerAdapter: model.providerAdapter ?? `${provider}-adapter`,
      priority: model.priority ?? 0,
      enabled: model.enabled ?? true,
      fallback: model.fallback,
    };
    catalog.register(descriptor);
  }
  const chains = new PriorityChains(catalog);
  return { catalog, capabilities, chains };
}
