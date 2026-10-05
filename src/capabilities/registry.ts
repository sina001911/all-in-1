/**
 * Capability registry.
 *
 * Extensibility contract: the router and selector never hard-code a capability
 * list. They ask this registry for a descriptor; a capability that was added
 * later is handled identically to a baseline one. An *unknown* capability id is
 * not an error — it simply carries no hard modality requirements, so
 * compatibility is decided entirely by the request.
 */
import type { CapabilityDescriptor, Modality } from "./types.ts";

const CAPABILITY_ID_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export interface CapabilityRequirements {
  readonly requiresInput: readonly Modality[];
  readonly requiresOutput: readonly Modality[];
  readonly mediaGated: boolean;
}

const NO_REQUIREMENTS: CapabilityRequirements = {
  requiresInput: [],
  requiresOutput: [],
  mediaGated: false,
};

export class CapabilityRegistry {
  private readonly capabilities = new Map<string, CapabilityDescriptor>();

  register(def: CapabilityDescriptor): void {
    if (!CAPABILITY_ID_PATTERN.test(def.id)) {
      throw new Error(`Invalid capability id: ${def.id} (expected UPPER_SNAKE_CASE)`);
    }
    if (this.capabilities.has(def.id)) {
      throw new Error(`Capability already registered: ${def.id}`);
    }
    this.capabilities.set(def.id, def);
  }

  get(id: string): CapabilityDescriptor | undefined {
    return this.capabilities.get(id);
  }

  has(id: string): boolean {
    return this.capabilities.has(id);
  }

  list(): readonly CapabilityDescriptor[] {
    return [...this.capabilities.values()];
  }

  /**
   * The modality requirements a model must satisfy for this capability.
   * Unknown (extensible) capabilities impose none.
   */
  requirements(id: string): CapabilityRequirements {
    const def = this.capabilities.get(id);
    if (!def) return NO_REQUIREMENTS;
    return {
      requiresInput: def.requiresInput,
      requiresOutput: def.requiresOutput,
      mediaGated: def.mediaGated === true,
    };
  }
}
