/**
 * browser.capture (D2). Screenshots a localhost-or-allowlisted page.
 *
 * This tool adds no browser capability of its own: it delegates entirely to the
 * existing `ScreenshotEngine`, which already enforces the frozen host policy
 * inside `open()` *before* any navigation. A capture is therefore read-only by
 * construction and can never become an exfiltration channel through this tool.
 *
 * The captured bytes land in the content-addressed artifact store; the tool
 * returns an artifact reference, not the bytes, so large images stay out of the
 * conversation transcript and out of the audit trail.
 */
import type { Tool, ToolContext, ToolOutput } from "../types.ts";
import type { ScreenshotEngine } from "../../screenshot/engine.ts";
import { toolFailure } from "../files/util.ts";

interface CaptureInput {
  readonly url: string;
  readonly fullPage?: boolean;
  readonly width?: number;
  readonly height?: number;
  readonly waitForSelector?: string;
}

const MAX_VIEWPORT = 4096;

export function createBrowserCaptureTool(engine: ScreenshotEngine): Tool {
  return {
    schema: {
      name: "browser.capture",
      description: "Capture a screenshot of a localhost or allowlisted page into the artifact store.",
      permission: "capture",
      timeoutMs: 45_000,
      input: {
        type: "object",
        required: ["url"],
        additionalProperties: false,
        properties: {
          url: { type: "string", description: "http(s) URL; the host policy is enforced by the browser engine" },
          fullPage: { type: "boolean", description: "capture the full page height" },
          width: { type: "integer", description: "viewport width" },
          height: { type: "integer", description: "viewport height" },
          waitForSelector: { type: "string", description: "wait for this selector before capturing" },
        },
      },
    },

    async execute(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
      const req = input as CaptureInput;
      if (ctx.signal.aborted) return toolFailure("TOOL_CANCELLED", "run cancelled before capture");
      const width = req.width ?? 1280;
      const height = req.height ?? 800;
      if (width < 1 || height < 1 || width > MAX_VIEWPORT || height > MAX_VIEWPORT) {
        return toolFailure(
          "TOOL_VALIDATION_FAILED",
          `viewport ${width}x${height} is outside the 1..${MAX_VIEWPORT} range`,
        );
      }
      let outcome;
      try {
        outcome = await engine.capture({
          url: req.url,
          fullPage: req.fullPage,
          viewport: { width, height },
          waitForSelector: req.waitForSelector,
          runId: ctx.runId,
        });
      } catch {
        return toolFailure("SCREENSHOT_FAILED", `failed to capture ${req.url}`);
      }
      return {
        ok: true,
        content: [
          {
            type: "image",
            artifactId: outcome.artifact.metadata.artifactId,
            contentType: outcome.contentType,
            bytes: outcome.bytes,
          },
        ],
        metadata: {
          artifactId: outcome.artifact.metadata.artifactId,
          sha256: outcome.artifact.metadata.sha256,
          title: outcome.title,
          url: req.url,
        },
      };
    },
  };
}
