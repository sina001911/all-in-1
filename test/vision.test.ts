/**
 * Vision layer suite (P3): request validation, router-enforced cost policy,
 * capability detection, locale contract, deterministic fake output, and the
 * capture -> analyze pipeline. No network, no credentials, no real provider.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VisualAnalyzer } from "../src/vision/analyzer.ts";
import { FakeVisionProvider } from "../src/vision/fake-vision.ts";
import { VisionProviderRegistry } from "../src/vision/registry.ts";
import { buildVisionStack } from "../src/vision/index.ts";
import { captureAndAnalyze } from "../src/vision/pipeline.ts";
import { deriveFocus, pngDimensions } from "../src/vision/types.ts";
import type { VisualAnalysis, VisualAnalysisRequest, VisionProvider } from "../src/vision/types.ts";
import { ScreenshotEngine } from "../src/screenshot/engine.ts";
import { ArtifactStore } from "../src/artifacts/store.ts";
import { FakeBrowserEngine } from "../src/browser/fake-engine.ts";
import { ModelRegistry } from "../src/registry/model.registry.ts";
import { ModelRouter } from "../src/registry/model.router.ts";
import { ApprovalStore } from "../src/registry/approvals.ts";
import { BudgetLedger } from "../src/registry/budget.ts";
import { registerStubs } from "../src/registry/stub.ts";
import { isAllInOneError } from "../src/errors.ts";

/** Minimal PNG whose IHDR declares the given dimensions (pngDimensions input). */
function mkPng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i++) bytes[i] = sig[i];
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

const PNG = mkPng(800, 600);

function analyzerWith(
  fallback: VisionProvider,
  overrides: Partial<ConstructorParameters<typeof VisualAnalyzer>[0]> = {},
): VisualAnalyzer {
  const models = new ModelRegistry();
  registerStubs(models);
  const providers = new VisionProviderRegistry();
  providers.registerFallback(fallback);
  const router = new ModelRouter({
    registry: models,
    approvals: new ApprovalStore(),
    budget: new BudgetLedger(0),
    policy: "FREE_ONLY",
  });
  return new VisualAnalyzer({
    router,
    providers,
    maxImageEdge: 1568,
    locale: "fa",
    ...overrides,
  });
}

/** A provider that always reports the wrong locale, violating the contract. */
class IgnoreLocaleProvider implements VisionProvider {
  readonly id = "ignore-locale";
  readonly displayName = "Ignore Locale";
  readonly capabilities = new FakeVisionProvider().capabilities;
  private readonly inner = new FakeVisionProvider();
  supports(request: VisualAnalysisRequest): boolean {
    return this.inner.supports(request);
  }
  async analyze(request: VisualAnalysisRequest): Promise<VisualAnalysis> {
    const analysis = await this.inner.analyze(request);
    return { ...analysis, locale: "en" };
  }
}

/** A provider that fails on every call. */
class BoomProvider implements VisionProvider {
  readonly id = "boom";
  readonly displayName = "Boom";
  readonly capabilities = new FakeVisionProvider().capabilities;
  supports(_request: VisualAnalysisRequest): boolean {
    return true;
  }
  async analyze(): Promise<VisualAnalysis> {
    throw new Error("boom");
  }
}

describe("png dimension parsing", () => {
  it("reads width and height from the IHDR chunk", () => {
    expect(pngDimensions(mkPng(1280, 720))).toEqual({ width: 1280, height: 720 });
  });

  it("returns null for a truncated buffer", () => {
    expect(pngDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it("returns null when the signature is not a PNG", () => {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    bytes.fill(0xff, 8); // valid length, wrong magic replaced below
    const view = new DataView(bytes.buffer);
    view.setUint32(16, 10);
    view.setUint32(20, 10);
    bytes[0] = 0x00; // break the signature
    expect(pngDimensions(bytes)).toBeNull();
  });

  it("returns null for zero dimensions", () => {
    expect(pngDimensions(mkPng(0, 0))).toBeNull();
  });
});

describe("deriveFocus", () => {
  it("flags narrow viewports as responsiveness-relevant", () => {
    const focus = deriveFocus(mkPng(375, 800));
    expect(focus).toContain("responsiveness");
    expect(focus).not.toContain("layout");
  });

  it("flags very wide images as layout-relevant", () => {
    const focus = deriveFocus(mkPng(2000, 500));
    expect(focus).toContain("layout");
    expect(focus).not.toContain("responsiveness");
  });

  it("always includes the baseline dimensions", () => {
    const focus = deriveFocus(mkPng(1280, 720));
    expect(focus).toEqual(
      expect.arrayContaining(["color", "typography", "spacing", "contrast", "defects"]),
    );
  });

  it("degrades to defects-only for undecodable input", () => {
    expect(deriveFocus(new Uint8Array(64))).toEqual(["defects"]);
  });
});

describe("FakeVisionProvider", () => {
  const provider = new FakeVisionProvider();

  it("supports the MIME types it declares", () => {
    expect(provider.supports({ mimeType: "image/png" } as VisualAnalysisRequest)).toBe(true);
    expect(provider.supports({ mimeType: "image/webp" } as VisualAnalysisRequest)).toBe(true);
    expect(provider.supports({ mimeType: "image/gif" } as VisualAnalysisRequest)).toBe(false);
  });

  it("is deterministic for identical input", async () => {
    const a = await provider.analyze({ imageBytes: PNG, mimeType: "image/png" });
    const b = await provider.analyze({ imageBytes: PNG, mimeType: "image/png" });
    expect(a).toEqual(b);
    expect(a.summary).toContain("800x600");
  });

  it("honours the requested locale and reading direction", async () => {
    const fa = await provider.analyze({ imageBytes: PNG, mimeType: "image/png", locale: "fa" });
    const en = await provider.analyze({ imageBytes: PNG, mimeType: "image/png", locale: "en" });
    expect(fa.locale).toBe("fa");
    expect(fa.layout.readingDirection).toBe("rtl");
    expect(en.locale).toBe("en");
    expect(en.layout.readingDirection).toBe("ltr");
  });

  it("defaults to the en locale", async () => {
    const analysis = await provider.analyze({ imageBytes: PNG, mimeType: "image/png" });
    expect(analysis.locale).toBe("en");
  });

  it("passes the requested focus through to the output", async () => {
    const analysis = await provider.analyze({
      imageBytes: PNG,
      mimeType: "image/png",
      focus: ["color", "contrast"],
    });
    expect(analysis.focus).toEqual(["color", "contrast"]);
  });

  it("reports an undecodable image without throwing", async () => {
    const analysis = await provider.analyze({
      imageBytes: new Uint8Array(64),
      mimeType: "image/png",
    });
    expect(analysis.imageDimensions).toEqual({ width: 0, height: 0 });
    expect(analysis.warnings.length).toBeGreaterThan(0);
    expect(analysis.defects).toContainEqual(
      expect.objectContaining({ kind: "undecodable-image", severity: "high" }),
    );
  });

  it("flags a narrow viewport when responsiveness is in focus", async () => {
    const analysis = await provider.analyze({
      imageBytes: mkPng(320, 600),
      mimeType: "image/png",
      focus: ["responsiveness"],
    });
    expect(analysis.defects).toContainEqual(
      expect.objectContaining({ kind: "narrow-viewport", severity: "low" }),
    );
  });

  it("never reports defects outside the declared severity vocabulary", async () => {
    const analysis = await provider.analyze({
      imageBytes: PNG,
      mimeType: "image/png",
      focus: ["defects", "contrast", "responsiveness"],
    });
    for (const defect of analysis.defects) {
      expect(["low", "medium", "high"]).toContain(defect.severity);
      expect(typeof defect.description).toBe("string");
    }
  });
});

describe("VisionProviderRegistry", () => {
  class StubProvider implements VisionProvider {
    constructor(
      readonly id: string,
      readonly displayName: string,
      private readonly mime: string | null,
    ) {}
    readonly capabilities = {
      maxImageEdge: 4096,
      inputMimeTypes: ["image/png", "image/webp"],
      structuredJson: true,
      locales: ["en", "fa"],
    };
    supports(request: VisualAnalysisRequest): boolean {
      return this.mime !== null && request.mimeType === this.mime;
    }
    async analyze(): Promise<VisualAnalysis> {
      throw new Error("not used");
    }
  }

  it("rejects duplicate registration", () => {
    const reg = new VisionProviderRegistry();
    reg.register(new StubProvider("a", "A", "image/png"));
    expect(() => reg.register(new StubProvider("a", "A", "image/png"))).toThrow(
      /already registered/,
    );
  });

  it("selects the first provider that declares support", () => {
    const reg = new VisionProviderRegistry();
    const png = new StubProvider("png", "PNG", "image/png");
    const webp = new StubProvider("webp", "WebP", "image/webp");
    reg.register(png);
    reg.register(webp);
    expect(reg.select({ mimeType: "image/webp" } as VisualAnalysisRequest)).toBe(webp);
    expect(reg.select({ mimeType: "image/png" } as VisualAnalysisRequest)).toBe(png);
  });

  it("falls back when no registered provider supports the request", () => {
    const reg = new VisionProviderRegistry();
    reg.register(new StubProvider("png", "PNG", "image/png"));
    const fallback = new StubProvider("fb", "Fallback", "image/webp");
    reg.registerFallback(fallback);
    expect(reg.select({ mimeType: "image/gif" } as VisualAnalysisRequest)).toBe(fallback);
  });

  it("throws when nothing is registered", () => {
    const reg = new VisionProviderRegistry();
    expect(() => reg.select({ mimeType: "image/png" } as VisualAnalysisRequest)).toThrow(
      /No vision provider/,
    );
  });

  it("exposes the fallback by id but not in list()", () => {
    const reg = new VisionProviderRegistry();
    const fallback = new StubProvider("fb", "Fallback", "image/png");
    reg.registerFallback(fallback);
    expect(reg.get("fb")).toBe(fallback);
    expect(reg.getFallback()).toBe(fallback);
    expect(reg.list()).not.toContain(fallback);
  });
});

describe("VisualAnalyzer", () => {
  it("analyzes a valid image through the fake and records the provider", async () => {
    const analyzer = analyzerWith(new FakeVisionProvider());
    const outcome = await analyzer.analyze({ imageBytes: PNG, mimeType: "image/png", locale: "fa" });
    expect(outcome.providerId).toBe("fake-vision");
    expect(outcome.analysis.locale).toBe("fa");
    expect(outcome.analysis.layout.readingDirection).toBe("rtl");
    expect(outcome.routing.basis).toBe("stub");
    expect(outcome.routing.requiresApproval).toBe(false);
  });

  it("rejects empty image bytes", async () => {
    const analyzer = analyzerWith(new FakeVisionProvider());
    await expect(
      analyzer.analyze({ imageBytes: new Uint8Array(0), mimeType: "image/png" }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_IMAGE" });
  });

  it("rejects an image exceeding the byte ceiling", async () => {
    const analyzer = analyzerWith(new FakeVisionProvider(), { maxImageBytes: 10 });
    await expect(
      analyzer.analyze({ imageBytes: PNG, mimeType: "image/png" }),
    ).rejects.toMatchObject({ code: "IMAGE_TOO_LARGE" });
  });

  it("rejects an image whose longest edge exceeds maxImageEdge", async () => {
    const analyzer = analyzerWith(new FakeVisionProvider());
    await expect(
      analyzer.analyze({ imageBytes: mkPng(2000, 1000), mimeType: "image/png" }),
    ).rejects.toMatchObject({ code: "IMAGE_TOO_LARGE" });
  });

  it("rejects an invalid maxImageEdge configuration", async () => {
    const analyzer = analyzerWith(new FakeVisionProvider(), { maxImageEdge: 0 });
    await expect(
      analyzer.analyze({ imageBytes: PNG, mimeType: "image/png" }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  it("wraps provider failures as VISION_ANALYSIS_FAILED", async () => {
    const analyzer = analyzerWith(new BoomProvider());
    await expect(
      analyzer.analyze({ imageBytes: PNG, mimeType: "image/png" }),
    ).rejects.toMatchObject({ code: "VISION_ANALYSIS_FAILED" });
  });

  it("enforces the locale contract", async () => {
    const analyzer = analyzerWith(new IgnoreLocaleProvider());
    const promise = analyzer.analyze({ imageBytes: PNG, mimeType: "image/png", locale: "fa" });
    await expect(promise).rejects.toMatchObject({ code: "VISION_CAPABILITY_MISMATCH" });
    await expect(promise).rejects.toThrow(/ignored the requested locale/);
  });

  it("surfaces a missing provider as VISION_PROVIDER_UNAVAILABLE", async () => {
    const models = new ModelRegistry();
    registerStubs(models);
    const providers = new VisionProviderRegistry(); // no fallback at all
    const router = new ModelRouter({
      registry: models,
      approvals: new ApprovalStore(),
      budget: new BudgetLedger(0),
      policy: "FREE_ONLY",
    });
    const analyzer = new VisualAnalyzer({
      router,
      providers,
      maxImageEdge: 1568,
      locale: "fa",
    });
    const error = await analyzer
      .analyze({ imageBytes: PNG, mimeType: "image/gif" })
      .catch((e) => e);
    expect(isAllInOneError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("VISION_PROVIDER_UNAVAILABLE");
  });
});

describe("captureAndAnalyze pipeline", () => {
  const URL = "http://localhost:5173/";

  function harness() {
    const base = mkdtempSync(join(tmpdir(), "aio-vision-"));
    const store = new ArtifactStore({ baseDir: base, retentionDays: 30, keepRuns: 5 });
    const shots = new ScreenshotEngine(new FakeBrowserEngine({ hostPolicy: "localhost-only" }), store);
    return { base, shots, store };
  }

  it("captures then analyzes, returning both outcomes", async () => {
    const { base, shots } = harness();
    const analyzer = analyzerWith(new FakeVisionProvider());
    try {
      const result = await captureAndAnalyze(shots, analyzer, "fa", { url: URL, runId: "r1" });
      expect(result.screenshot.bytes).toBeGreaterThan(0);
      expect(result.screenshot.artifact.metadata.kind).toBe("screenshot");
      expect(result.analysis).toBeDefined();
      expect(result.analyzerId).toBe("fake-vision");
      expect(result.analysis?.locale).toBe("fa");
      expect(result.analysisError).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("keeps the screenshot when analysis fails", async () => {
    const { base, shots } = harness();
    const analyzer = analyzerWith(new BoomProvider());
    try {
      const result = await captureAndAnalyze(shots, analyzer, "fa", { url: URL, runId: "r1" });
      expect(result.analysis).toBeUndefined();
      expect(result.analysisError?.code).toBe("VISION_ANALYSIS_FAILED");
      expect(result.screenshot.artifact.metadata.sourceUrl).toBe(URL);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("honours a per-job locale override", async () => {
    const { base, shots } = harness();
    const analyzer = analyzerWith(new FakeVisionProvider());
    try {
      const result = await captureAndAnalyze(shots, analyzer, "fa", {
        url: URL,
        runId: "r1",
        locale: "en",
      });
      expect(result.analysis?.locale).toBe("en");
      expect(result.analysis?.layout.readingDirection).toBe("ltr");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("buildVisionStack", () => {
  it("wires the frozen registries with the deterministic fake", () => {
    const base = mkdtempSync(join(tmpdir(), "aio-stack-"));
    const store = new ArtifactStore({ baseDir: base, retentionDays: 30, keepRuns: 5 });
    const shots = new ScreenshotEngine(new FakeBrowserEngine({ hostPolicy: "localhost-only" }), store);
    try {
      const stack = buildVisionStack(shots, store, { maxImageEdge: 1568, locale: "fa" });
      expect(stack.analyzer).toBeInstanceOf(VisualAnalyzer);
      expect(stack.providers.getFallback()).toBeInstanceOf(FakeVisionProvider);
      expect(stack.router.resolve({ role: "VISION", imageInput: true, structuredJson: true }).basis).toBe(
        "stub",
      );
      expect(stack.screenshotEngine).toBe(shots);
      expect(stack.artifacts).toBe(store);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
