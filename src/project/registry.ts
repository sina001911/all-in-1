/**
 * Adapter registry. Adapters register by id; detection picks the highest
 * confidence, with `generic` always available as the ultimate fallback so no
 * project is ever unsupported.
 */
import type { ProjectAdapter } from "./types.ts";

export class AdapterRegistry {
  private readonly adapters = new Map<string, ProjectAdapter>();
  private fallback: ProjectAdapter | null = null;

  register(adapter: ProjectAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Adapter already registered: ${adapter.id}`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  /** The fallback adapter is consulted last and always resolves a project. */
  registerFallback(adapter: ProjectAdapter): void {
    this.fallback = adapter;
  }

  get(id: string): ProjectAdapter | undefined {
    return this.adapters.get(id) ?? (this.fallback && this.fallback.id === id ? this.fallback : undefined);
  }

  list(): readonly ProjectAdapter[] {
    return [...this.adapters.values()];
  }

  getFallback(): ProjectAdapter | null {
    return this.fallback;
  }
}
