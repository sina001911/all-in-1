/**
 * Deterministic media stub. Zero-cost, zero-network stand-in so the media
 * *orchestration* (registries, router shape, artifact quarantine) is testable
 * without any provider. It generates nothing real; it only records intents.
 */
import type {
  MediaArtifact,
  MediaCapability,
  MediaModelDefinition,
  MediaProviderDefinition,
  MediaRequest,
  MediaResult,
} from "./types.ts";

const stubModel: MediaModelDefinition = {
  provider: "stub",
  modelId: "stub-media",
  displayName: "Deterministic Media Stub",
  modality: "MULTIMODAL",
  inputTypes: ["text"],
  outputTypes: ["image"],
  capabilities: [],
  pricing: "free",
  availability: true,
  priority: -1000,
  enabled: false, // disabled: the stub never executes either
};

export const stubMediaProvider: MediaProviderDefinition = {
  id: "stub",
  displayName: "Deterministic Media Stub",
  protocol: "none",
  auth: { type: "bearer", apiKeyEnv: "STUB_NO_KEY_NEEDED" },
  capabilities: [],
  supportedInputs: ["text"],
  supportedOutputs: ["image"],
  models: [stubModel],
  pricing: "free",
  availability: { healthy: false },
};

/**
 * The stub records an intent without producing anything. It exists so that
 * pipelines can be wired and tested end-to-end while media is disabled.
 */
export function stubMediaExecute(req: MediaRequest): MediaResult {
  void req;
  return {
    ok: false,
    artifacts: [] as readonly MediaArtifact[],
    provider: "stub",
    model: "stub-media",
    warnings: ["media disabled in MVP; intent recorded only"],
  };
}

export function stubMediaModelFor(_capability: MediaCapability): MediaModelDefinition {
  return stubModel;
}
