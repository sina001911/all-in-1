/**
 * D33: the Compare path, end to end.
 *
 * The renderer's Compare view sends one raw payload over the
 * `all-in-1:agent:many` channel; main.ts feeds it through
 * `buildManyRequest` (the D29 seam) into `DesktopFacade.runMany`, which is a
 * REAL primitive: one independent, fully-gated agent run per selected model,
 * each bound to its own preference and runId through a bounded pool. These
 * tests drive that path without a window:
 *
 *   - `buildManyRequest` is the boundary: a raw field it does not whitelist
 *     never reaches the facade;
 *   - `runMany` dedups a repeated selection instead of billing it twice;
 *   - results come back slot-ordered, each carrying the requested model AND
 *     the model that actually executed, so a substitution is a flagged
 *     mismatch, never a silent re-point;
 *   - one slot's failure cannot discard a sibling slot's answer;
 *   - every slot is an independently recorded run with its own accounting.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDesktopStack } from "../src/desktop-stack.ts";
import { DesktopFacade } from "../src/facade.ts";
import { MemoryCredentialProvider } from "../src/credentials/memory-credential-provider.ts";
import { buildManyRequest } from "../src/ipc-requests.ts";

let dir: string;
let project: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-d33-"));
  project = mkdtempSync(join(tmpdir(), "aio-d33-proj-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function stack(): DesktopFacade {
  const s = buildDesktopStack({
    baseDir: dir,
    credentials: new MemoryCredentialProvider(),
  });
  s.settingsStore.patch({ workspaceRoots: [project] });
  return new DesktopFacade(s);
}

describe("buildManyRequest — the agent:many boundary", () => {
  it("maps a valid payload field-for-field", () => {
    const out = buildManyRequest({
      prompt: "answer plainly",
      modelIds: ["local/agent", "local/deterministic"],
      batchId: "ok-1",
      mode: "BUILD",
      auto: { auto: true, maxIterations: 3 },
      timeoutMs: 5000,
      concurrency: 2,
      streaming: true,
    });
    expect(out).toMatchObject({
      prompt: "answer plainly",
      modelIds: ["local/agent", "local/deterministic"],
      batchId: "ok-1",
      mode: "BUILD",
      auto: { auto: true, maxIterations: 3 },
      timeoutMs: 5000,
      concurrency: 2,
      streaming: true,
    });
    // Absent optional subfields stay absent, not defaulted.
    expect(out.auto?.maxEdits).toBeUndefined();
    expect(out.auto?.dryRunFirst).toBeUndefined();
  });

  it("rejects a payload that is not an object", () => {
    expect(() => buildManyRequest(null)).toThrow(/Invalid compare request/);
    expect(() => buildManyRequest("prompt")).toThrow(/Invalid compare request/);
  });

  it("rejects a missing or blank prompt", () => {
    expect(() => buildManyRequest({ modelIds: ["local/agent"] })).toThrow(/prompt/);
    expect(() => buildManyRequest({ prompt: "   ", modelIds: ["local/agent"] })).toThrow(/prompt/);
  });

  it("keeps only string model entries", () => {
    const out = buildManyRequest({
      prompt: "p",
      modelIds: [42, "local/agent", null, "local/deterministic"],
    });
    expect(out.modelIds).toEqual(["local/agent", "local/deterministic"]);
  });

  it("drops a batchId that could escape the run-id namespace", () => {
    // A separator would let a batch seed two runIds; 65 chars overruns the
    // id budget. Both must come back undefined, not coerced through.
    expect(buildManyRequest({ prompt: "p", batchId: "bad/batch" }).batchId).toBeUndefined();
    expect(buildManyRequest({ prompt: "p", batchId: "a".repeat(65) }).batchId).toBeUndefined();
    expect(buildManyRequest({ prompt: "p", batchId: "a".repeat(64) }).batchId).toBe("a".repeat(64));
  });

  it("rejects an invalid mode but omits it when absent", () => {
    expect(() => buildManyRequest({ prompt: "p", mode: "ANY" })).toThrow(/Invalid mode/);
    expect(buildManyRequest({ prompt: "p" }).mode).toBeUndefined();
  });

  it("forwards concurrency and streaming only when they mean something", () => {
    const zero = buildManyRequest({ prompt: "p", concurrency: 0 });
    expect(zero.concurrency).toBeUndefined();
    const str = buildManyRequest({ prompt: "p", concurrency: "2", streaming: "true" });
    expect(str.concurrency).toBeUndefined();
    expect(str.streaming).toBe(false);
  });
});

describe("runMany — one prompt, N models", () => {
  it("runs every selected model and returns slot-ordered results", async () => {
    const f = stack();
    const results = await f.runMany({
      batchId: "d33-a",
      prompt: "answer in plain text, call no tools",
      modelIds: ["local/deterministic", "local/agent", "local/vision"],
    });

    expect(results.map((r) => r.requestedModel)).toEqual([
      "local/deterministic",
      "local/agent",
      "local/vision",
    ]);
    // Each slot got its own stable runId off the batch.
    expect(results.map((r) => r.runId)).toEqual(["d33-a-0", "d33-a-1", "d33-a-2"]);
    for (const r of results) {
      expect(r.ok).toBe(true);
      expect(typeof r.text).toBe("string");
      expect(r.text).toBeDefined();
      expect(r.text!.length).toBeGreaterThan(0);
    }
    // In INSPECT mode the agent loop makes tools visible, so the selector
    // requires model.tools === true. local/deterministic has tools:false, so
    // the preference is rejected and the chain falls back to local/agent.
    expect(results[0]?.executedModel).toBe("local/agent");
    expect(results[1]?.executedModel).toBe("local/agent");
    // local/vision cannot serve CODING at all: the selector fell back to the
    // chain head (local/agent), and the result shows the substitution.
    expect(results[2]?.executedModel).toBeDefined();
    expect(results[2]?.executedModel).not.toBe("local/vision");
  });

  it("records every slot as its own run, with its own accounting", async () => {
    const f = stack();
    await f.runMany({
      batchId: "d33-r",
      prompt: "answer in plain text, call no tools",
      modelIds: ["local/deterministic", "local/agent"],
    });
    const runs = f.listRuns().filter((r) => r.id === "d33-r-0" || r.id === "d33-r-1");
    expect(runs).toHaveLength(2);
    for (const rec of runs) {
      expect(rec.kind).toBe("agent");
      expect(rec.status).toBe("completed");
      expect(rec.ok).toBe(true);
    }
    const usage = f.getRunUsage("d33-r-0");
    expect(usage?.invocations).toBeGreaterThanOrEqual(1);
    expect(usage?.costUsd).toBe(0);
    // local/deterministic has tools:false; in INSPECT mode the agent loop
    // exposes tools, so the selector rejected the preference and fell back
    // to the chain head local/agent.
    expect(usage?.models[0]?.modelId).toBe("local/agent");
  });

  it("dedups a repeated selection instead of billing it twice", async () => {
    const f = stack();
    const results = await f.runMany({
      batchId: "d33-b",
      prompt: "answer in plain text, call no tools",
      // The duplicate and the malformed entries are dropped; the first
      // occurrence keeps its position.
      modelIds: ["local/agent", "local/deterministic", "local/agent", "no-slash", 42 as unknown as string],
    });
    expect(results.map((r) => r.requestedModel)).toEqual(["local/agent", "local/deterministic"]);
    expect(results.map((r) => r.runId)).toEqual(["d33-b-0", "d33-b-1"]);
    expect(f.listRuns().filter((r) => r.id.startsWith("d33-b-"))).toHaveLength(2);
  });

  it("throws when nothing valid is left after filtering", async () => {
    const f = stack();
    await expect(
      f.runMany({
        prompt: "answer",
        modelIds: ["no-slash", ""],
      }),
    ).rejects.toThrow(/at least one provider\/model/);
  });

  it("isolates one slot's failure from its siblings", async () => {
    const f = stack();
    const input = {
      batchId: "d33-d",
      prompt: "answer in plain text, call no tools",
      modelIds: ["local/deterministic", "local/agent"],
      concurrency: 2,
    };
    const pending = f.runMany(input);
    // Both slots' signals exist by the time the facade returns (each runAgent
    // grabs its hub signal synchronously), so this aborts slot 0 mid-run,
    // deterministically — and slot 1 keeps going.
    expect(f.cancelRun("d33-d-0")).toBe(true);
    const results = await pending;

    const failed = results[0];
    const sibling = results[1];
    expect(failed?.ok).toBe(false);
    expect(failed?.error).toBeDefined();
    expect(["AGENT_CANCELLED", "PROVIDER_CANCELLED"]).toContain(failed?.error?.code);
    expect(failed?.text).toBeUndefined();
    // The failure must not have discarded the sibling's answer.
    expect(sibling?.ok).toBe(true);
    expect(typeof sibling?.text).toBe("string");
    expect(sibling?.text).toBeDefined();
    expect(sibling!.text!.length).toBeGreaterThan(0);
    expect(sibling?.executedModel).toBe("local/agent");
    // The runs view agrees: one cancelled, one completed.
    const byId = new Map(f.listRuns().map((r) => [r.id, r]));
    expect(byId.get("d33-d-0")?.status).toBe("cancelled");
    expect(byId.get("d33-d-1")?.status).toBe("completed");
  });
});
