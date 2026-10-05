/**
 * Deterministic stubs. Every role has a zero-cost fallback so the loop can
 * never die from a missing model. Stubs produce canned, schema-valid output
 * and make zero network calls.
 */
import type { ModelRole } from "./roles.ts";
import type { ModelDefinition } from "./model.registry.ts";
import { MODEL_ROLES } from "./roles.ts";

export function stubFor(role: ModelRole): string {
  return `stub/${role.toLowerCase()}`;
}

export function stubModel(role: ModelRole): ModelDefinition {
  return {
    id: stubFor(role),
    provider: "stub",
    roles: [role],
    pricing: "free",
    modalities: { input: ["text"], output: ["text"] },
    capabilities: { structuredJson: true, tools: false, context: 8192, output: 4096 },
    availability: true,
    priority: -1000, // stubs only win when nothing else qualifies
    enabled: true,
  };
}

/** Register a deterministic stub for every role, as the ultimate fallback. */
export function registerStubs(registry: {
  register(def: ModelDefinition): void;
}): void {
  for (const role of MODEL_ROLES) {
    if (role === "MAIN_CODER") continue; // Atria is a fixed binding, not a stub
    registry.register(stubModel(role));
  }
}
