/**
 * Vision layer — structured visual analysis contract (P3).
 *
 * The vision layer turns a captured image (typically a P2 screenshot artifact)
 * into deterministic, schema-valid structured JSON. It never edits, never
 * decides, and never calls a tool: analysis output is consumed by Atria.
 *
 * Cost model: the vision layer does NOT have its own pricing logic. A vision
 * model is selected through the existing ModelRouter on the VISION role, so
 * the frozen FREE_ONLY / spendBudgetUsd = 0 / UNKNOWN_COST rules apply
 * unchanged. The only provider registered in the MVP is the deterministic
 * fake, which is genuinely zero-cost and needs no credentials.
 *
 * Secrets: providers are referenced by environment-variable NAME only. The
 * layer never reads, stores, or logs a key value.
 */

/** Capabilities a vision provider must declare for capability detection. */
export interface VisionCapabilities {
  /** Maximum supported image edge (longest side), in pixels. */
  readonly maxImageEdge: number;
  /** Supported MIME types for input images. */
  readonly inputMimeTypes: readonly string[];
  /** Whether structured JSON output is guaranteed. */
  readonly structuredJson: boolean;
  /** Locale codes the provider can respond in. */
  readonly locales: readonly string[];
}

/** Request shape. `imageBytes` is the only required payload. */
export interface VisualAnalysisRequest {
  readonly imageBytes: Uint8Array;
  readonly mimeType: string;
  /** Locale for the response prose; defaults to the config locale. */
  readonly locale?: string;
  /** Structured focus hints; providers ignore what they cannot support. */
  readonly focus?: ReadonlyArray<
    | "layout"
    | "typography"
    | "color"
    | "spacing"
    | "contrast"
    | "responsiveness"
    | "defects"
  >;
  /** Optional provenance, recorded for tracing. Never a secret. */
  readonly sourceArtifactId?: string;
  readonly sourceUrl?: string;
}

/**
 * The structured analysis contract. Every field is machine-checkable so
 * downstream consumers (Visual QA, feedback) never parse prose.
 */
export interface VisualAnalysis {
  readonly provider: string;
  readonly model: string;
  readonly locale: string;
  readonly imageDimensions: { readonly width: number; readonly height: number };
  readonly focus: readonly string[];
  readonly summary: string;
  readonly layout: {
    readonly detectedRegions: ReadonlyArray<{
      readonly role: string;
      readonly confidence: number;
    }>;
    readonly readingDirection: "ltr" | "rtl" | "unknown";
  };
  readonly typography: {
    readonly estimatedScale: number;
    readonly notes: readonly string[];
  };
  readonly color: {
    readonly dominantHint: string;
    readonly contrastRatioEstimate: number;
  };
  readonly defects: ReadonlyArray<{
    readonly kind: string;
    readonly severity: "low" | "medium" | "high";
    readonly description: string;
  }>;
  readonly warnings: readonly string[];
}

export interface VisionProvider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: VisionCapabilities;
  /** Whether this provider can serve the request (capability detection). */
  supports(request: VisualAnalysisRequest): boolean;
  analyze(request: VisualAnalysisRequest): Promise<VisualAnalysis>;
}

/** Page-level analysis focus derived from an image, deterministically. */
export function deriveFocus(imageBytes: Uint8Array): string[] {
  const dims = pngDimensions(imageBytes);
  if (!dims) return ["defects"];
  const focus = new Set<string>();
  if (dims.width < 480) focus.add("responsiveness");
  if (dims.width > dims.height * 2) focus.add("layout");
  focus.add("color");
  focus.add("typography");
  focus.add("spacing");
  focus.add("contrast");
  focus.add("defects");
  return [...focus];
}

/**
 * Read PNG dimensions from the IHDR chunk. Pure, dependency-free, and used to
 * enforce `maxImageEdge` before any bytes reach a provider.
 */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 24) return null;
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height) return null;
  return { width, height };
}
