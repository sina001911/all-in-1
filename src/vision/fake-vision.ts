/**
 * Deterministic fake Vision engine (P3).
 *
 * This is the ONLY vision provider registered in the MVP, and it is genuinely
 * zero-cost: it makes no network call, reads no credential, and stores no
 * secret. It exists so the entire vision pipeline — request validation,
 * capability detection, cost enforcement via the router, structured output,
 * and artifact integration — is testable end to end without a provider.
 *
 * Its output is deterministic and content-derived: identical input bytes always
 * produce identical analysis. Nothing is invented about a real image; the
 * values are derived from verifiable image properties (dimensions, byte hash)
 * so the contract shape, not the judgement, is what is under test.
 */
import { createHash } from "node:crypto";
import type {
  VisualAnalysis,
  VisualAnalysisRequest,
  VisionProvider,
} from "./types.ts";
import { pngDimensions } from "./types.ts";

const LOCALES = ["en", "fa"];

export class FakeVisionProvider implements VisionProvider {
  readonly id = "fake-vision";
  readonly displayName = "Deterministic Vision Stub";
  readonly capabilities = {
    maxImageEdge: 4096,
    inputMimeTypes: ["image/png", "image/jpeg", "image/webp"],
    structuredJson: true,
    locales: LOCALES,
  };

  supports(request: VisualAnalysisRequest): boolean {
    return this.capabilities.inputMimeTypes.includes(request.mimeType);
  }

  async analyze(request: VisualAnalysisRequest): Promise<VisualAnalysis> {
    const dims = pngDimensions(request.imageBytes);
    const locale = request.locale ?? "en";
    const hash = sha256(request.imageBytes);
    // A stable 0..1 scalar derived only from content.
    const scalar = parseInt(hash.slice(0, 8), 16) / 0xffffffff;

    const focus = request.focus ?? [];
    const defects = deriveDefects(dims, scalar, focus);

    return {
      provider: this.id,
      model: "fake-vision-1",
      locale,
      imageDimensions: dims ?? { width: 0, height: 0 },
      focus: focus.length ? [...focus] : ["defects"],
      summary: `Deterministic analysis of ${dims ? `${dims.width}x${dims.height}` : "unknown-size"} image (${hash.slice(0, 12)}).`,
      layout: {
        detectedRegions: [
          { role: "header", confidence: round(0.5 + scalar * 0.4) },
          { role: "main", confidence: round(0.4 + scalar * 0.5) },
        ],
        readingDirection: locale === "fa" ? "rtl" : "ltr",
      },
      typography: {
        estimatedScale: round(14 + scalar * 6),
        notes: [`base size estimated at ${Math.round(14 + scalar * 6)}px`],
      },
      color: {
        dominantHint: pick(["neutral", "warm", "cool", "vivid"], hash),
        contrastRatioEstimate: round(4 + scalar * 8),
      },
      defects,
      warnings: dims
        ? []
        : ["input is not a decodable PNG; dimensions are unknown"],
    };
  }
}

type Defect = VisualAnalysis["defects"][number];

function deriveDefects(
  dims: { width: number; height: number } | null,
  scalar: number,
  focus: readonly string[],
): VisualAnalysis["defects"] {
  if (!dims) {
    return [
      {
        kind: "undecodable-image",
        severity: "high",
        description: "Image bytes are not a decodable PNG; analysis is shape-only.",
      },
    ];
  }
  const defects: Defect[] = [];
  if (focus.includes("contrast") && scalar < 0.18) {
    defects.push({
      kind: "low-contrast",
      severity: "medium",
      description: "Estimated contrast is below the 4.5:1 WCAG AA target for body text.",
    });
  }
  if (focus.includes("responsiveness") && dims.width < 480) {
    defects.push({
      kind: "narrow-viewport",
      severity: "low",
      description: `Captured width ${dims.width}px is below the 480px small-screen threshold.`,
    });
  }
  return defects;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

function pick<T>(items: readonly T[], hash: string): T {
  const n = parseInt(hash.slice(8, 12), 16);
  return items[n % items.length] as T;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
