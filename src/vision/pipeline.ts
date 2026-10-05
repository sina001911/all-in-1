/**
 * Capture → analyze pipeline. Joins the P2 screenshot/artifact layer with the
 * P3 vision layer without coupling them: both are passed in, and this function
 * only sequences them.
 *
 * Failures in analysis never discard the screenshot — the artifact is already
 * stored, provenance is preserved, and the caller sees both outcomes.
 */
import type { ScreenshotEngine, ScreenshotJob, ScreenshotOutcome } from "../screenshot/engine.ts";
import type { VisualAnalyzer } from "./analyzer.ts";
import type { VisualAnalysis, VisualAnalysisRequest } from "./types.ts";
import { readFileSync } from "node:fs";
import { AllInOneError, toAllInOneError } from "../errors.ts";

export interface CaptureAndAnalyzeJob extends ScreenshotJob {
  readonly focus?: VisualAnalysisRequestFocus;
  readonly locale?: string;
}
type VisualAnalysisRequestFocus = VisualAnalysisRequest["focus"];

export interface CaptureAndAnalyzeResult {
  readonly screenshot: ScreenshotOutcome;
  readonly analysis?: VisualAnalysis;
  readonly analyzerId?: string;
  readonly analysisError?: AllInOneError;
}

export async function captureAndAnalyze(
  shots: ScreenshotEngine,
  analyzer: VisualAnalyzer,
  locale: string,
  job: CaptureAndAnalyzeJob,
): Promise<CaptureAndAnalyzeResult> {
  const screenshot = await shots.capture(job);

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(screenshot.artifact.path));
  } catch (e) {
    return {
      screenshot,
      analysisError: toAllInOneError(e, {
        code: "ARTIFACT_READ_FAILED",
        category: "artifact",
        message: `Could not re-read captured artifact ${screenshot.artifact.path}`,
      }),
    };
  }

  try {
    const outcome = await analyzer.analyze({
      imageBytes: bytes,
      mimeType: "image/png",
      locale: job.locale ?? locale,
      focus: job.focus,
      sourceArtifactId: screenshot.artifact.metadata.artifactId,
      sourceUrl: job.url,
    });
    return {
      screenshot,
      analysis: outcome.analysis,
      analyzerId: outcome.providerId,
    };
  } catch (e) {
    return {
      screenshot,
      analysisError: toAllInOneError(e, {
        code: "VISION_ANALYSIS_FAILED",
        category: "browser",
        message: "Vision analysis failed after capture",
      }),
    };
  }
}
