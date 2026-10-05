/**
 * Visual analyzer — the P3 entrypoint.
 *
 * Takes image bytes (typically a P2 screenshot artifact) and returns the
 * structured visual analysis contract. It owns three concerns and nothing else:
 *
 * 1. Input validation (decode check, MIME check, maxImageEdge enforcement).
 * 2. Cost enforcement — delegated to the EXISTING ModelRouter on the VISION
 *    role, so the frozen FREE_ONLY / spendBudgetUsd = 0 / UNKNOWN_COST rules
 *    apply unchanged. The analyzer never duplicates pricing logic.
 * 3. Provider selection via the VisionProviderRegistry (capability detection).
 *
 * If the router cannot resolve a usable paid/real model under the frozen
 * policy, resolution falls back to the deterministic fake, which is genuinely
 * zero-cost. The analyzer therefore never blocks on missing credentials: the
 * analysis is always available, with the chosen provider recorded in output.
 */
import type { ModelRouter } from "../registry/model.router.ts";
import type { RouterDecision } from "../registry/cost-policy.ts";
import { AllInOneError, toAllInOneError } from "../errors.ts";
import type {
  VisualAnalysis,
  VisualAnalysisRequest,
  VisionProvider,
} from "./types.ts";
import { pngDimensions } from "./types.ts";
import type { VisionProviderRegistry } from "./registry.ts";

export interface AnalyzerOptions {
  readonly router: ModelRouter;
  readonly providers: VisionProviderRegistry;
  /** Mirrors the frozen config default; enforced before provider dispatch. */
  readonly maxImageEdge: number;
  readonly locale: string;
  /** Ceiling on input image bytes. */
  readonly maxImageBytes?: number;
}

const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MiB

export interface AnalysisOutcome {
  readonly analysis: VisualAnalysis;
  readonly routing: RouterDecision;
  readonly providerId: string;
}

export class VisualAnalyzer {
  private readonly opts: Required<AnalyzerOptions>;

  constructor(opts: AnalyzerOptions) {
    this.opts = { maxImageBytes: DEFAULT_MAX_IMAGE_BYTES, ...opts };
  }

  async analyze(request: VisualAnalysisRequest): Promise<AnalysisOutcome> {
    validateRequest(request, this.opts);

    // Cost enforcement: route the VISION role through the frozen policy
    // machinery. A stub/fallback decision is free by construction.
    const routing = this.opts.router.resolve({
      role: "VISION",
      imageInput: true,
      structuredJson: true,
    });

    const provider = this.selectProvider(request, routing);
    let analysis: VisualAnalysis;
    try {
      analysis = await provider.analyze(request);
    } catch (e) {
      throw toAllInOneError(e, {
        code: "VISION_ANALYSIS_FAILED",
        category: "browser",
        message: `Vision analysis failed via ${provider.id}: ${describe(e)}`,
      });
    }

    // Contract guard: the provider must honour the locale it was asked for.
    if (request.locale && analysis.locale !== request.locale) {
      throw new AllInOneError(
        `Vision provider ${provider.id} ignored the requested locale`,
        "VISION_CAPABILITY_MISMATCH",
        "config",
      );
    }
    return { analysis, routing, providerId: provider.id };
  }

  private selectProvider(
    request: VisualAnalysisRequest,
    routing: RouterDecision,
  ): VisionProvider {
    // A stub decision means no real model qualified under the frozen policy;
    // the deterministic fake is the zero-cost path.
    if (routing.basis === "stub") {
      const fallback = this.opts.providers.getFallback();
      if (fallback) return fallback;
    }
    try {
      return this.opts.providers.select(request);
    } catch (e) {
      throw toAllInOneError(e, {
        code: "VISION_PROVIDER_UNAVAILABLE",
        category: "unavailable",
        message: describe(e),
      });
    }
  }
}

function validateRequest(request: VisualAnalysisRequest, opts: Required<AnalyzerOptions>): void {
  if (!(request.imageBytes instanceof Uint8Array) || request.imageBytes.byteLength === 0) {
    throw new AllInOneError(
      "Visual analysis requires non-empty image bytes",
      "UNSUPPORTED_IMAGE",
      "config",
    );
  }
  if (request.imageBytes.byteLength > opts.maxImageBytes) {
    throw new AllInOneError(
      `Image of ${request.imageBytes.byteLength} bytes exceeds the ${opts.maxImageBytes} byte limit`,
      "IMAGE_TOO_LARGE",
      "artifact",
    );
  }
  if (!opts.maxImageEdge || opts.maxImageEdge <= 0) {
    throw new AllInOneError(
      `Invalid maxImageEdge: ${opts.maxImageEdge}`,
      "INVALID_CONFIG",
      "config",
    );
  }
  const dims = pngDimensions(request.imageBytes);
  if (dims) {
    const longest = Math.max(dims.width, dims.height);
    if (longest > opts.maxImageEdge) {
      throw new AllInOneError(
        `Image longest edge ${longest}px exceeds maxImageEdge ${opts.maxImageEdge}px`,
        "IMAGE_TOO_LARGE",
        "artifact",
      );
    }
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
