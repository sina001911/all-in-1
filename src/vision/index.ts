/**
 * Vision composition root. Wires the analyzer to the frozen registries and
 * registers the deterministic fake as the only (verified zero-cost) provider.
 *
 * No credentials are read, requested, or logged anywhere in this module. A real
 * provider is registered only when its pricing has been verified per
 * docs/reconnaissance.md — unverified pricing is UNKNOWN_COST and the router
 * blocks it, so the fake remains the effective provider.
 */
import { ModelRouter } from "../registry/model.router.ts";
import { ModelRegistry } from "../registry/model.registry.ts";
import { ProviderRegistry } from "../registry/provider.registry.ts";
import { ApprovalStore } from "../registry/approvals.ts";
import { BudgetLedger } from "../registry/budget.ts";
import { registerStubs } from "../registry/stub.ts";
import { ArtifactStore } from "../artifacts/store.ts";
import { ScreenshotEngine } from "../screenshot/engine.ts";
import { VisualAnalyzer } from "./analyzer.ts";
import { VisionProviderRegistry } from "./registry.ts";
import { FakeVisionProvider } from "./fake-vision.ts";

export interface VisionStackOptions {
  readonly maxImageEdge: number;
  readonly locale: string;
  readonly budgetUsd?: number;
  readonly maxImageBytes?: number;
}

export interface VisionStack {
  readonly analyzer: VisualAnalyzer;
  readonly providers: VisionProviderRegistry;
  readonly router: ModelRouter;
  readonly screenshotEngine: ScreenshotEngine;
  readonly artifacts: ArtifactStore;
}

/**
 * Build the vision stack. `screenshotEngine` is required from the caller so the
 * browser lifecycle stays owned by one component (P2 contract).
 */
export function buildVisionStack(
  screenshotEngine: ScreenshotEngine,
  artifacts: ArtifactStore,
  opts: VisionStackOptions,
): VisionStack {
  const models = new ModelRegistry();
  registerStubs(models);
  const router = new ModelRouter({
    registry: models,
    approvals: new ApprovalStore(),
    budget: new BudgetLedger(opts.budgetUsd ?? 0),
    policy: "PREFERRED_FREE",
  });

  const providers = new VisionProviderRegistry();
  providers.registerFallback(new FakeVisionProvider());

  const analyzer = new VisualAnalyzer({
    router,
    providers,
    maxImageEdge: opts.maxImageEdge,
    locale: opts.locale,
    maxImageBytes: opts.maxImageBytes,
  });

  return { analyzer, providers, router, screenshotEngine, artifacts };
}

export { FakeVisionProvider, VisionProviderRegistry, VisualAnalyzer };
export type {
  VisualAnalysis,
  VisualAnalysisRequest,
  VisionProvider,
  VisionCapabilities,
} from "./types.ts";
export { deriveFocus, pngDimensions } from "./types.ts";

/**
 * Build a vision analyzer WITHOUT a screenshot engine. The full
 * `buildVisionStack` pairs the analyzer with a browser for P2 capture; this
 * lighter entry point is for paths that only need to ANALYZE bytes that are
 * already in the artifact store — a user upload, a captured screenshot, etc.
 * The cost model is identical: the VISION role routes through the frozen
 * PREFERRED_FREE policy, and the deterministic fake is the zero-cost fallback.
 */
export function buildVisionAnalyzer(opts: VisionStackOptions): VisualAnalyzer {
  const models = new ModelRegistry();
  registerStubs(models);
  const router = new ModelRouter({
    registry: models,
    approvals: new ApprovalStore(),
    budget: new BudgetLedger(opts.budgetUsd ?? 0),
    policy: "PREFERRED_FREE",
  });
  const providers = new VisionProviderRegistry();
  providers.registerFallback(new FakeVisionProvider());
  return new VisualAnalyzer({
    router,
    providers,
    maxImageEdge: opts.maxImageEdge,
    locale: opts.locale,
    maxImageBytes: opts.maxImageBytes,
  });
}
