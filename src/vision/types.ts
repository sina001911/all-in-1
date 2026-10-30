/**
 * Vision layer — structured visual analysis contract (P3).
 *
 * The vision layer turns a captured image (typically a P2 screenshot artifact)
 * into deterministic, schema-valid structured JSON. It never edits, never
 * decides, and never calls a tool: analysis output is consumed by Atria.
 *
 * Cost model: the vision layer does NOT have its own pricing logic. A vision
 * model is selected through the existing ModelRouter on the VISION role, so
 * the frozen PREFERRED_FREE / spendBudgetUsd = 0 / UNKNOWN_COST rules apply
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
  const dims = imageDimensions(imageBytes);
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
 * Read image dimensions from the file header. PNG is decoded from the IHDR
 * chunk; JPEG and WebP are decoded from their own headers. Used to enforce
 * `maxImageEdge` before any bytes reach a provider. Returns null when the
 * format is unknown or the header cannot be parsed — the caller then falls
 * back to the byte ceiling alone.
 */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  return pngDimensions(bytes) ?? jpegDimensions(bytes) ?? webpDimensions(bytes);
}

/** PNG: 8-byte signature + IHDR chunk (length 4, type 4, width 4, height 4). */
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

/**
 * JPEG: scan SOFn markers (0xFF 0xC0..0xC3, 0xC5..0xC7, 0xC9..0xCB,
 * 0xCD..0xCF) for the height/width pair. Returns null on a malformed or
 * truncated header — the caller falls back to the byte ceiling.
 */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 20 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 8 < bytes.byteLength) {
    if (bytes[i] !== 0xff) {
      // Standalone restart marker (0xD8/0xD9) or fill byte; skip one.
      i++;
      continue;
    }
    const marker = bytes[i + 1]!;
    if (marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) break; // EOI / RSTn
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const segLen = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (segLen < 8 || i + 2 + segLen > bytes.byteLength) return null;
    // SOFn markers: 0xC0..0xC3, 0xC5..0xC7, 0xC9..0xCB, 0xCD..0xCF
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const height = view.getUint16(i + 5);
      const width = view.getUint16(i + 7);
      if (!width || !height) return null;
      return { width, height };
    }
    i += 2 + segLen;
  }
  return null;
}

/**
 * WebP: "RIFF"...."WEBP" then a chunk. VP8L (lossless) and VP8 (lossy) both
 * carry the dimensions in their first few bytes; VP8X (extended) carries them
 * at a fixed offset. Returns null on an unrecognized chunk.
 */
export function webpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 30) return null;
  if (bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x56) return null; // RIFF
  if (bytes[8] !== 0x57 || bytes[9] !== 0x45 || bytes[10] !== 0x42 || bytes[11] !== 0x50) return null; // WEBP
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fourCC = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (fourCC === "VP8 ") {
    // Lossy: frame tag (3 bytes) + start code 0x9d 0x01 0x2a + width(2) + height(2)
    if (bytes.byteLength < 26) return null;
    const width = view.getUint16(26) & 0x3fff;
    const height = view.getUint16(28) & 0x3fff;
    if (!width || !height) return null;
    return { width, height };
  }
  if (fourCC === "VP8L") {
    // Lossless: 1-byte signature + 14 bits width-1 + 14 bits height-1
    if (bytes.byteLength < 25) return null;
    if (bytes[20] !== 0x2f) return null;
    const bits = view.getUint32(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    if (!width || !height) return null;
    return { width, height };
  }
  if (fourCC === "VP8X") {
    // Extended: 24-bit width-1 and height-1 at fixed offsets
    const width = (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1;
    const height = (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1;
    if (!width || !height) return null;
    return { width, height };
  }
  return null;
}
