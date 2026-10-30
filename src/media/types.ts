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
  /** Base URL the adapter talks to. Carried here so the router can build the
   *  request URL without re-reading the settings store. */
  readonly endpoint: string;
  readonly auth: {
    readonly type: "bearer" | "header" | "query";
    readonly apiKeyEnv: string; // NAME only, never the key
  };
  /**
   * D35: the image-generation path mounted under `endpoint`. The default is
   * `/images/generations` (OpenAI-compatible), but some gateways mount image
   * generation at a different path — OpenRouter, for instance, uses `/images`.
   * When absent the adapter falls back to the OpenAI-compatible default, so a
   * provider that does not set this still gets the standard path.
   */
  readonly imagePath?: string;
  readonly capabilities: readonly MediaCapability[];
  readonly supportedInputs: readonly ("text" | "image" | "video")[];
  readonly supportedOutputs: readonly string[];
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
  /**
   * Per-generation cost in USD, when the provider declares one. Absent means
   * UNKNOWN: the router reserves zero (mirroring the engine's NaN rule) and
   * marks the result rather than pretending the call was free. Never invented
   * from a pricing tier — only carried from an explicit user declaration.
   */
  readonly costEstimateUsd?: number;
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
  /**
   * D35: an AbortSignal the human can use to cancel a generation mid-flight.
   * The router forwards it to the adapter, which honours it per attempt —
   * a cancelled attempt is never retried. Absent means the call runs to
   * completion or its own timeout.
   */
  readonly signal?: AbortSignal;
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
  /**
   * D35: the cost the router actually reserved/committed for this call, in USD.
   * Zero when the model declared no cost AND the call was free; `undefined`
   * when the cost is genuinely UNKNOWN (no declaration, no provider report) —
   * the renderer must not display `0` as "free" in that case.
   */
  readonly costUsd?: number;
  /** D35: true when the model's cost was never declared and the provider did
   *  not report one. The caller treats this as a managed risk, not a free pass. */
  readonly costUnknown?: boolean;
  /** D35: how many generations remain under the configured cap, after this call. */
  readonly generationsRemaining?: number;
}
