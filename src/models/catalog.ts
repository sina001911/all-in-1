/**
 * Model catalogue — the provider/model registry (P3).
 *
 * Describes models, not calls. Selection is a separate concern
 * (`selection.ts`); the catalogue only owns lookup, filtering, and a cached
 * static snapshot so repeated routing is cheap and network-free.
 */
import type { ModelDescriptor, ModelStatus } from "./types.ts";

const SELECTABLE_STATUS: readonly ModelStatus[] = ["active", "beta"];

export interface CatalogStats {
  readonly total: number;
  readonly enabled: number;
  readonly selectable: number;
  readonly fixed: number;
  readonly byCostClass: Readonly<Record<string, number>>;
  readonly byLocality: Readonly<Record<string, number>>;
}

export class ModelCatalog {
  private readonly models = new Map<string, ModelDescriptor>();
  private cache: readonly ModelDescriptor[] | null = null;

  register(def: ModelDescriptor): void {
    if (def.id !== `${def.provider}/${def.modelId}`) {
      throw new Error(`Model id must equal "provider/model": ${def.id}`);
    }
    if (this.models.has(def.id)) {
      throw new Error(`Model already registered: ${def.id}`);
    }
    if (def.contextLimit < 0 || def.outputLimit < 0) {
      throw new Error(`Model context/output limits must be non-negative: ${def.id}`);
    }
    this.models.set(def.id, def);
    this.cache = null;
  }

  get(id: string): ModelDescriptor | undefined {
    return this.models.get(id);
  }

  getOrThrow(id: string): ModelDescriptor {
    const def = this.models.get(id);
    if (!def) throw new Error(`Model not registered: ${id}`);
    return def;
  }

  has(id: string): boolean {
    return this.models.has(id);
  }

  byProvider(providerId: string): readonly ModelDescriptor[] {
    return this.snapshot().filter((m) => m.provider === providerId);
  }

  byCapability(capability: string): readonly ModelDescriptor[] {
    return this.snapshot().filter((m) => m.capabilities.includes(capability));
  }

  /**
   * Candidates for a capability: models that DECLARE the capability, are
   * enabled, available, non-fixed, and in a selectable lifecycle status.
   *
   * A model never becomes a candidate merely because it is registered — it must
   * declare the capability and be operationally selectable. Cost is NOT
   * filtered here; that is the selector's job, so paid models stay *visible*
   * even while the policy blocks them.
   */
  candidatesFor(capability: string): readonly ModelDescriptor[] {
    return this.snapshot().filter(
      (m) =>
        m.capabilities.includes(capability) &&
        m.enabled &&
        m.available &&
        !m.fixed &&
        SELECTABLE_STATUS.includes(m.status),
    );
  }

  /**
   * Cached, immutable snapshot of static registry data. Safe to cache: the
   * catalogue is built once and then read-only for the lifetime of the layer,
   * so automatic routing never performs any per-call recomputation or network
   * discovery.
   */
  snapshot(): readonly ModelDescriptor[] {
    if (!this.cache) this.cache = Object.freeze([...this.models.values()]);
    return this.cache;
  }

  list(): readonly ModelDescriptor[] {
    return this.snapshot();
  }

  stats(): CatalogStats {
    const all = this.snapshot();
    const byCostClass: Record<string, number> = {};
    const byLocality: Record<string, number> = {};
    let enabled = 0;
    let selectable = 0;
    let fixed = 0;
    for (const m of all) {
      byCostClass[m.pricing.costClass] = (byCostClass[m.pricing.costClass] ?? 0) + 1;
      byLocality[m.locality] = (byLocality[m.locality] ?? 0) + 1;
      if (m.enabled) enabled += 1;
      if (m.fixed) fixed += 1;
      if (
        m.enabled &&
        m.available &&
        !m.fixed &&
        SELECTABLE_STATUS.includes(m.status)
      ) {
        selectable += 1;
      }
    }
    return { total: all.length, enabled, selectable, fixed, byCostClass, byLocality };
  }
}
