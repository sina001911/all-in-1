/**
 * Baseline capability catalogue.
 *
 * The capability system is extensible: this tuple seeds the capabilities named
 * in the P3 specification, but the router, catalog, and selector all treat a
 * capability id as an opaque string and look metadata up in the
 * `CapabilityRegistry`. Adding a capability is a *registration*, never a
 * rewrite of the router.
 *
 * Nothing here describes a provider. Capability requirements are derived from
 * the nature of the task, so a future provider is judged against the same
 * contract as a known one.
 */
import type { CapabilityDescriptor } from "./types.ts";

export const CAPABILITIES = [
  // --- text / coding -------------------------------------------------------
  {
    id: "CODING",
    category: "text-generation",
    description: "Write, refactor, and complete source code.",
    requiresInput: ["TEXT"],
    requiresOutput: ["TEXT"],
  },
  {
    id: "CODE_REVIEW",
    category: "text-generation",
    description: "Advisory review of a diff or change set. Never applies anything.",
    requiresInput: ["TEXT"],
    requiresOutput: ["TEXT"],
  },
  {
    id: "DEBUGGING",
    category: "text-generation",
    description: "Diagnose failures and propose fixes from code, logs, and stack traces.",
    requiresInput: ["TEXT"],
    requiresOutput: ["TEXT"],
  },
  {
    id: "REASONING",
    category: "reasoning",
    description: "General-purpose multi-step reasoning.",
    requiresInput: ["TEXT"],
    requiresOutput: ["TEXT"],
  },
  {
    id: "DEEP_REASONING",
    category: "reasoning",
    description: "Architecture and hard-analysis tasks needing a long reasoning budget.",
    requiresInput: ["TEXT"],
    requiresOutput: ["TEXT"],
  },
  {
    id: "PLANNING",
    category: "reasoning",
    description: "Decompose a goal into an ordered, verifiable plan.",
    requiresInput: ["TEXT"],
    requiresOutput: ["TEXT"],
  },
  // --- perception ----------------------------------------------------------
  {
    id: "VISION",
    category: "perception",
    description: "Image -> structured visual analysis.",
    requiresInput: ["IMAGE"],
    requiresOutput: ["TEXT"],
  },
  {
    id: "SCREENSHOT_ANALYSIS",
    category: "perception",
    description: "Screenshot -> structured UI/UX analysis suitable for Visual QA.",
    requiresInput: ["IMAGE"],
    requiresOutput: ["TEXT"],
  },
  {
    id: "DOCUMENT_VISION",
    category: "perception",
    description: "Page/document images -> structured extraction.",
    requiresInput: ["IMAGE"],
    requiresOutput: ["TEXT"],
  },
  {
    id: "OCR",
    category: "perception",
    description: "Image -> machine-readable text.",
    requiresInput: ["IMAGE"],
    requiresOutput: ["TEXT"],
  },
  {
    id: "VIDEO_UNDERSTANDING",
    category: "perception",
    description: "Video -> structured analysis.",
    requiresInput: ["VIDEO"],
    requiresOutput: ["TEXT"],
  },
  // --- image generation (media-gated) --------------------------------------
  {
    id: "IMAGE_GENERATION",
    category: "image-generation",
    description: "Text -> image.",
    requiresInput: ["TEXT"],
    requiresOutput: ["IMAGE"],
    mediaGated: true,
  },
  {
    id: "IMAGE_EDITING",
    category: "image-generation",
    description: "Image edit / inpaint / upscale.",
    requiresInput: ["IMAGE"],
    requiresOutput: ["IMAGE"],
    mediaGated: true,
  },
  {
    id: "IMAGE_TO_IMAGE",
    category: "image-generation",
    description: "Image -> image transformation.",
    requiresInput: ["IMAGE"],
    requiresOutput: ["IMAGE"],
    mediaGated: true,
  },
  {
    id: "IMAGE_TO_VIDEO",
    category: "video-generation",
    description: "Image -> video.",
    requiresInput: ["IMAGE"],
    requiresOutput: ["VIDEO"],
    mediaGated: true,
  },
  // --- video generation (media-gated) --------------------------------------
  {
    id: "VIDEO_GENERATION",
    category: "video-generation",
    description: "Text -> video.",
    requiresInput: ["TEXT"],
    requiresOutput: ["VIDEO"],
    mediaGated: true,
  },
  {
    id: "VIDEO_EDITING",
    category: "video-generation",
    description: "Video editing / cuts / transitions.",
    requiresInput: ["VIDEO"],
    requiresOutput: ["VIDEO"],
    mediaGated: true,
  },
  // --- audio (media-gated) ---------------------------------------------------
  {
    id: "AUDIO_GENERATION",
    category: "audio-generation",
    description: "Text -> audio / sound effects.",
    requiresInput: ["TEXT"],
    requiresOutput: ["AUDIO"],
    mediaGated: true,
  },
  {
    id: "SPEECH_TO_TEXT",
    category: "audio-generation",
    description: "Audio -> transcript. Perception-side; not media generation.",
    requiresInput: ["AUDIO"],
    requiresOutput: ["TEXT"],
  },
  {
    id: "TEXT_TO_SPEECH",
    category: "audio-generation",
    description: "Text -> speech.",
    requiresInput: ["TEXT"],
    requiresOutput: ["AUDIO"],
    mediaGated: true,
  },
  {
    id: "MUSIC_GENERATION",
    category: "audio-generation",
    description: "Text -> music.",
    requiresInput: ["TEXT"],
    requiresOutput: ["AUDIO"],
    mediaGated: true,
  },
  // --- embedding + utility ---------------------------------------------------
  {
    id: "EMBEDDING",
    category: "embedding",
    description: "Text (or media) -> fixed-length vector embedding.",
    requiresInput: ["TEXT"],
    requiresOutput: ["TEXT"],
  },
  {
    id: "FAST_TASK",
    category: "utility",
    description: "Summaries, labels, triage, small structured JSON. Latency-sensitive.",
    requiresInput: ["TEXT"],
    requiresOutput: ["TEXT"],
  },
] as const satisfies readonly CapabilityDescriptor[];

export type CapabilityId = (typeof CAPABILITIES)[number]["id"];

/** ids of every media-gated baseline capability. */
export const MEDIA_GATED_CAPABILITIES: readonly string[] = CAPABILITIES
  .filter((c) => "mediaGated" in c && c.mediaGated === true)
  .map((c) => c.id);

/** Register every baseline capability into a registry. */
export function registerBaselineCapabilities(
  registry: { register(def: CapabilityDescriptor): void },
): void {
  for (const capability of CAPABILITIES) registry.register(capability);
}
