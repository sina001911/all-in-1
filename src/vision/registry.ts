/**
 * Vision provider registry. Mirrors the ProviderRegistry pattern: metadata and
 * capability lookup only. Providers are registered, never hardcoded callers.
 *
 * Only the deterministic fake is registered in the MVP, because it is the only
 * vision provider whose zero cost has actually been verified (it makes no
 * network call at all). Registering a real provider requires verified pricing
 * metadata per docs/reconnaissance.md — unverified pricing is UNKNOWN_COST and
 * is blocked by the router.
 */
import type { VisionProvider } from "./types.ts";

export class VisionProviderRegistry {
  private readonly providers = new Map<string, VisionProvider>();
  private fallback: VisionProvider | null = null;

  register(provider: VisionProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Vision provider already registered: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }

  /** The fallback resolves any request when no real provider qualifies. */
  registerFallback(provider: VisionProvider): void {
    this.fallback = provider;
  }

  get(id: string): VisionProvider | undefined {
    return this.providers.get(id) ?? (this.fallback?.id === id ? this.fallback : undefined);
  }

  list(): readonly VisionProvider[] {
    return [...this.providers.values()];
  }

  getFallback(): VisionProvider | null {
    return this.fallback;
  }

  /** Capability detection: first provider that declares support, else fallback. */
  select(request: import("./types.ts").VisualAnalysisRequest): VisionProvider {
    for (const provider of this.providers.values()) {
      if (provider.supports(request)) return provider;
    }
    if (this.fallback) return this.fallback;
    throw new Error("No vision provider registered");
  }
}
