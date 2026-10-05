/**
 * Provider registry. Providers are described by metadata only — no keys, no
 * clients, no network. API keys are referenced by environment-variable NAME
 * only and are never read, stored, or logged by this layer.
 */
export interface ProviderDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly protocol: "openai-compatible";
  readonly endpoint: string;
  /** Environment variable NAME that holds the key, if any. Never the key itself. */
  readonly apiKeyEnv: string | null;
  readonly knownEndpointIssues?: readonly string[];
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderDefinition>();

  register(def: ProviderDefinition): void {
    if (this.providers.has(def.id)) {
      throw new Error(`Provider already registered: ${def.id}`);
    }
    this.providers.set(def.id, def);
  }

  get(id: string): ProviderDefinition | undefined {
    return this.providers.get(id);
  }

  list(): readonly ProviderDefinition[] {
    return [...this.providers.values()];
  }
}
