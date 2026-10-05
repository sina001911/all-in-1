/**
 * Media layer types — SCAFFOLD ONLY. `media.enabled = false` in the MVP, so no
 * media model is ever selected or called. These interfaces exist so future
 * providers can be added by registration, not redesign.
 *
 * No provider capabilities or pricing are invented here. Capability metadata
 * is only ever recorded from verified provider output, and in the MVP nothing
 * has been verified, so no provider is registered.
 */
export const MEDIA_MODALITIES = ["IMAGE", "VIDEO", "AUDIO", "MULTIMODAL", "3D"] as const;
export type MediaModality = (typeof MEDIA_MODALITIES)[number];

export const MEDIA_CAPABILITIES = [
  "TEXT_TO_IMAGE",
  "IMAGE_TO_IMAGE",
  "IMAGE_EDIT",
  "IMAGE_UPSCALE",
  "INPAINT",
  "OUTPAINT",
  "IMAGE_ANALYSIS",
  "TEXT_TO_VIDEO",
  "IMAGE_TO_VIDEO",
  "VIDEO_TO_VIDEO",
  "VIDEO_EDIT",
  "VIDEO_ANALYSIS",
  "VIDEO_UPSCALE",
] as const;
export type MediaCapability = (typeof MEDIA_CAPABILITIES)[number];

export interface MediaProviderDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly protocol: string;
  readonly auth: {
    readonly type: "bearer" | "header" | "query";
    readonly apiKeyEnv: string; // NAME only, never the key
  };
  readonly capabilities: readonly MediaCapability[];
  readonly supportedInputs: readonly ("text" | "image" | "video")[];
  readonly supportedOutputs: readonly ("image" | "video")[];
  readonly models: readonly MediaModelDefinition[];
  readonly pricing: "free" | "premium" | "unknown";
  readonly availability: { readonly healthy: boolean; readonly lastCheck?: number };
}

export interface MediaModelDefinition {
  readonly provider: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly modality: MediaModality;
  readonly inputTypes: readonly string[];
  readonly outputTypes: readonly string[];
  readonly capabilities: readonly MediaCapability[];
  readonly resolution?: { readonly max?: [number, number]; readonly presets?: readonly [number, number][] };
  readonly duration?: { readonly maxSeconds?: number };
  readonly maxInputSize?: number;
  readonly pricing: "free" | "premium" | "unknown";
  readonly availability: boolean;
  readonly priority: number;
  readonly enabled: boolean;
  readonly fallback?: string;
}

export interface MediaRequest {
  readonly capability: MediaCapability;
  readonly prompt?: string;
  readonly referenceArtifactIds?: readonly string[];
  readonly params?: {
    readonly aspectRatio?: string;
    readonly resolution?: [number, number];
    readonly durationSeconds?: number;
    readonly seed?: number;
  };
}

export interface MediaArtifact {
  readonly artifactId: string;
  readonly modality: MediaModality;
  readonly mimeType: string;
  readonly bytes: number;
}

export interface MediaResult {
  readonly ok: boolean;
  readonly artifacts: readonly MediaArtifact[];
  readonly provider?: string;
  readonly model?: string;
  readonly warnings?: readonly string[];
}
