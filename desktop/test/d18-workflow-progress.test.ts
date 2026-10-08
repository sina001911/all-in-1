/**
 * D18: workflow progress UI is consumption-only. Final DiagnosticResult remains
 * the authority; the renderer uses bridge state only as a live hint.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "desktop", "src");

describe("workflow progress UI", () => {
  it("diagnostic view has a streaming toggle and a bridge-poll implementation", () => {
    const html = readFileSync(join(SRC, "renderer", "index.html"), "utf8");
    expect(html).toContain('id="diag-stream"');

    const renderer = readFileSync(join(SRC, "renderer", "renderer.js"), "utf8");
    expect(renderer).toContain("getWorkflowStream");
    expect(renderer).toContain("diagStreamCursor");
    expect(renderer).toContain("stopDiagStreamPoll");
    expect(renderer).toContain("text(out, result.text)");
  });

  it("progress events render live markers including failure; no new store path", () => {
    const renderer = readFileSync(join(SRC, "renderer", "renderer.js"), "utf8");
    expect(renderer).toContain("pushDiagStreamEvent");
    expect(renderer).toContain("[failed:");
    expect(renderer).toContain("[usage:");
    expect(renderer).toContain("finally {");
    expect(renderer).toContain("stopDiagStreamPoll()");
  });
});

describe("no persistence leak for the progressive stream", () => {
  it("runs/usage store types do not receive stream frames", () => {
    const facade = readFileSync(join(SRC, "facade.ts"), "utf8");
    expect(facade).toContain("workflowStreamBridge.append(runId, e)");
    expect(facade).toContain("streamBridge.done(request.runId)");
    expect(facade).toContain("workflowStreamBridge.done(runId)");
    expect(facade).not.toContain("streamBridge.append(runId, event)");
  });
});
