/**
 * Provider adapter registry (P4). Maps adapter ids to live adapters.
 *
 * Deliberately separate from the frozen `ProviderRegistry` (metadata only) and
 * from the capability catalogue (models): this registry owns *how to reach* a
 * provider, nothing about what it costs or what it can do.
 *
 * Only the deterministic local adapter is registered by default. Registering a
 * remote adapter is an explicit, reviewed act that no frozen default performs.
 */
import type { BaseProviderAdapter } from "../providers/types.ts";

export class AdapterRegistry {
  private readonly adapters = new Map<string, BaseProviderAdapter>();

  register(adapter: BaseProviderAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Provider adapter already registered: ${adapter.id}`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): BaseProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  list(): readonly BaseProviderAdapter[] {
    return [...this.adapters.values()];
  }
}
