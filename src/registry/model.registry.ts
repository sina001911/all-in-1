/**
 * Model registry. Models are keyed by `providerId/modelId` and tagged with the
 * roles they may serve, plus pricing and capability metadata.
 */
import type { ModelRole } from "./roles.ts";
import type { Pricing } from "./cost-policy.ts";

export interface ModelDefinition {
  readonly id: string; // "provider/model"
  readonly provider: string;
  readonly roles: readonly ModelRole[];
  readonly pricing: Pricing;
  readonly modalities: {
    readonly input: readonly ("text" | "image" | "video")[];
    readonly output: readonly ("text" | "image" | "video")[];
  };
  readonly capabilities: {
    readonly structuredJson: boolean;
    readonly tools: boolean;
    readonly context: number;
    readonly output: number;
  };
  readonly cost?: {
    readonly inputPer1M?: number;
    readonly outputPer1M?: number;
  };
  readonly availability: boolean;
  readonly priority: number; // higher = preferred within the same pricing class
  readonly enabled: boolean;
  readonly fallback?: string; // next model id in the declared fallback chain
  /**
   * Immutable binding. MAIN_CODER carries this flag and is therefore invisible
   * to the router's candidate selection.
   */
  readonly fixed?: boolean;
}

export interface ModelFilter {
  readonly roles?: readonly ModelRole[];
  readonly imageInput?: boolean;
  readonly structuredJson?: boolean;
}

export class ModelRegistry {
  private readonly models = new Map<string, ModelDefinition>();

  register(def: ModelDefinition): void {
    if (this.models.has(def.id)) {
      throw new Error(`Model already registered: ${def.id}`);
    }
    this.models.set(def.id, def);
  }

  get(id: string): ModelDefinition | undefined {
    return this.models.get(id);
  }

  list(filter?: ModelFilter): readonly ModelDefinition[] {
    const all = [...this.models.values()];
    if (!filter) return all;
    return all.filter((m) => {
      if (filter.roles && !filter.roles.some((r) => m.roles.includes(r))) return false;
      if (filter.imageInput && !m.modalities.input.includes("image")) return false;
      if (filter.structuredJson && !m.capabilities.structuredJson) return false;
      return true;
    });
  }

  /** Candidates for a role, EXCLUDING fixed models (MAIN_CODER). */
  candidatesFor(role: ModelRole): readonly ModelDefinition[] {
    return this.list({ roles: [role] }).filter((m) => !m.fixed && m.enabled && m.availability);
  }
}
