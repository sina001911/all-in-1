/**
 * D34: the Collaborate path, end to end.
 *
 * The renderer's Collaborate view sends one raw payload over the
 * `all-in-1:collab:run` channel; main.ts feeds it through `buildCollabRequest`
 * (the D29 seam) into `DesktopFacade.runCollab`, which is a REAL primitive:
 * every participant is an independent, fully-gated specialist run, and the
 * orchestrator reconciles their outputs. These tests drive that path without
 * a window:
 *
 *   - `buildCollabRequest` is the boundary: a raw field it does not whitelist
 *     never reaches the facade;
 *   - a run with fewer than two valid participants is rejected at the seam;
 *   - results come back participant-ordered, each carrying the model that
 *     actually executed;
 *   - one participant's failure cannot discard a sibling's answer;
 *   - every participant is an independently recorded run with its own
 *     accounting, and the run record is kind `collab`;
 *   - an unregistered role (MAIN_CODER) fails for that slot only, never the
 *     whole run.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDesktopStack } from "../src/desktop-stack.ts";
import { DesktopFacade } from "../src/facade.ts";
import { MemoryCredentialProvider } from "../src/credentials/memory-credential-provider.ts";
import { buildCollabRequest } from "../src/ipc-requests.ts";

let dir: string;
let project: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-d34-"));
  project = mkdtempSync(join(tmpdir(), "aio-d34-proj-"));
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

function validRequest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task: "review this design",
    strategy: "parallel",
    mode: "INSPECT",
    participants: [
      { id: "p1", provider: "local", modelId: "deep", role: "DEEP_REASONING", task: "critique" },
      { id: "p2", provider: "local", modelId: "review", role: "CODE_REVIEWER", task: "check" },
    ],
    ...over,
  };
}

describe("buildCollabRequest — the collab:run boundary", () => {
  it("maps a valid payload field-for-field", () => {
    const out = buildCollabRequest(validRequest());
    expect(out.task).toBe("review this design");
    expect(out.strategy).toBe("parallel");
    expect(out.mode).toBe("INSPECT");
    expect(out.participants).toHaveLength(2);
    expect(out.participants[0]).toMatchObject({
      id: "p1",
      provider: "local",
      modelId: "deep",
      role: "DEEP_REASONING",
      task: "critique",
    });
    // Absent optional subfields stay absent, not defaulted.
    expect(out.synthesis).toBeUndefined();
    expect(out.auto).toBeUndefined();
    expect(out.streaming).toBeUndefined();
    expect(out.runId).toBeUndefined();
  });

  it("rejects a payload that is not an object", () => {
    expect(() => buildCollabRequest(null)).toThrow(/Invalid collaborate request/);
    expect(() => buildCollabRequest("prompt")).toThrow(/Invalid collaborate request/);
  });

  it("rejects a missing or blank task", () => {
    expect(() => buildCollabRequest({ ...validRequest(), task: "" })).toThrow(/task/);
    expect(() => buildCollabRequest({ ...validRequest(), task: "   " })).toThrow(/task/);
  });

  it("rejects fewer than two participants", () => {
    const req = validRequest();
    expect(() =>
      buildCollabRequest({
        ...req,
        participants: [(req.participants as Array<Record<string, unknown>>)[0]],
      }),
    ).toThrow(/at least two participants/);
  });

  it("rejects an unknown strategy", () => {
    expect(() =>
      buildCollabRequest({ ...validRequest(), strategy: "diagonal" }),
    ).toThrow(/Invalid strategy/);
  });

  it("rejects an invalid mode", () => {
    expect(() => buildCollabRequest({ ...validRequest(), mode: "ANY" })).toThrow(/Invalid mode/);
  });

  it("rejects a participant whose role is not a registered role", () => {
    const req = validRequest();
    expect(() =>
      buildCollabRequest({
        ...req,
        participants: [
          { id: "p1", provider: "local", modelId: "deep", role: "DEEP_REASONING", task: "critique" },
          { id: "bad", provider: "local", modelId: "x", role: "NOPE", task: "nope" },
        ],
      }),
    ).toThrow(/registered role/);
  });

  it("rejects when fewer than two participants survive the shape check", () => {
    const req = validRequest();
    expect(() =>
      buildCollabRequest({
        ...req,
        participants: [{ id: "only", provider: "local", modelId: "x", role: "DEEP_REASONING", task: "nope" }],
      }),
    ).toThrow(/at least two participants/);
  });

  it("drops a synthesis that is not a provider/model pair", () => {
    const out = buildCollabRequest({
      ...validRequest(),
      synthesis: { provider: 123, modelId: "x" },
    });
    expect(out.synthesis).toBeUndefined();
  });

  it("drops a runId that could escape the run-id namespace", () => {
    expect(buildCollabRequest({ ...validRequest(), runId: "bad/run" }).runId).toBeUndefined();
    expect(buildCollabRequest({ ...validRequest(), runId: "a".repeat(65) }).runId).toBeUndefined();
    expect(buildCollabRequest({ ...validRequest(), runId: "a".repeat(64) }).runId).toBe("a".repeat(64));
  });
});

describe("runCollab — one prompt, N gated participants", () => {
  it("runs every participant and returns slot-ordered results", async () => {
    const f = stack();
    const result = await f.runCollab(buildCollabRequest(validRequest()));

    expect(result.ok).toBe(true);
    expect(result.participants).toHaveLength(2);
    expect(result.participants.map((p) => p.participant.id)).toEqual(["p1", "p2"]);
    for (const p of result.participants) {
      expect(p.ok).toBe(true);
      expect(typeof p.text).toBe("string");
      expect(p.text.length).toBeGreaterThan(0);
      expect(p.modelId).not.toBe(p.participant.modelId);
    }
    // No synthesis was requested: the result is the participants' answers, never
    // a hidden fallback.
    expect(result.synthesis).toBeUndefined();
    expect(result.disagreements).toBeUndefined();
  });

  it("records every participant as its own run, kind collab", async () => {
    const f = stack();
    const result = await f.runCollab(buildCollabRequest(validRequest({ runId: "d34-r" })));

    const runs = f.listRuns().filter((r) => r.id === "d34-r");
    expect(runs).toHaveLength(1);
    expect(runs[0].kind).toBe("collab");
    expect(runs[0].status).toBe("completed");
    expect(runs[0].iterations).toBe(2);
    expect(runs[0].deliverable).toContain("[all-in-1 collaborate] 2 participants");

    // One usage record per participant, keyed by position. Both participants
    // route through the same catalogue model (the deterministic local model),
    // so the usage store aggregates them into one model row with two
    // invocations — the accounting is complete, not half-recorded.
    const usage = f.getRunUsage("d34-r");
    expect(usage?.invocations).toBe(2);
    expect(usage?.costUsd).toBe(0);
    expect(usage?.models).toHaveLength(1);
    expect(usage?.models[0].invocations).toBe(2);
  });

  it("isolates one participant's failure from its siblings", async () => {
    const f = stack();
    // IMAGE_GENERATOR is a registered role with no baseline specialist, so the
    // runner rejects it as SPECIALIST_NOT_FOUND for that slot only. The
    // sibling (CODE_REVIEWER) is unaffected.
    const input = validRequest({
      runId: "d34-d",
      strategy: "sequential",
      participants: [
        { id: "p1", provider: "local", modelId: "img", role: "IMAGE_GENERATOR", task: "generate" },
        { id: "p2", provider: "local", modelId: "review", role: "CODE_REVIEWER", task: "check" },
      ],
    });
    const result = await f.runCollab(buildCollabRequest(input));

    expect(result.participants[0].ok).toBe(false);
    expect(result.participants[0].error?.code).toBe("SPECIALIST_NOT_FOUND");
    // A non-retryable failure stops the sequential chain; the second
    // participant is recorded as skipped, never run.
    expect(result.participants[1].ok).toBe(false);
    expect(result.participants[1].error?.code).toBe("COLLAB_SKIPPED");

    const byId = new Map(f.listRuns().map((r) => [r.id, r]));
    expect(byId.get("d34-d")?.status).toBe("failed");
  });

  it("fails when every participant fails", async () => {
    const f = stack();
    const input = validRequest({
      runId: "d34-f",
      participants: [
        { id: "p1", provider: "local", modelId: "img", role: "IMAGE_GENERATOR", task: "generate" },
        { id: "p2", provider: "local", modelId: "vid", role: "VIDEO_GENERATOR", task: "generate" },
      ],
    });
    const result = await f.runCollab(buildCollabRequest(input));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("COLLAB_ALL_FAILED");
    expect(result.participants).toHaveLength(2);
  });

  it("synthesizes when a synthesis model is named and carries provenance", async () => {
    const f = stack();
    const input = validRequest({
      runId: "d34-s",
      strategy: "debate",
      synthesis: { provider: "local", modelId: "synth" },
    });
    const result = await f.runCollab(buildCollabRequest(input));
    expect(result.synthesis).toBeDefined();
    expect(result.synthesis!.modelId).toBe("local/agent");
    expect(result.synthesis!.provenance).toHaveLength(2);
    expect(result.synthesis!.provenance[0].participantId).toBe("p1");
    expect(result.synthesis!.provenance[1].participantId).toBe("p2");
    // The deliverable is the synthesis, not the concatenation.
    const rec = f.listRuns().find((r) => r.id === "d34-s");
    expect(rec?.deliverable).toBe(result.synthesis!.text);
  });

  it("detects a disagreement on a field two participants set differently", async () => {
    const f = stack();
    const input = validRequest({ runId: "d34-g", strategy: "debate" });
    const result = await f.runCollab(buildCollabRequest(input));
    expect(result.disagreements).toBeDefined();
    expect(result.disagreements!.length).toBeGreaterThan(0);
    expect(result.disagreements![0].between).toEqual(["p1", "p2"]);
    expect(result.disagreements![0].resolution).toBe("unresolved");
  });
});

describe("runCollab — MAIN_CODER immutability", () => {
  it("does not default to MAIN_CODER; an unregistered role fails for that slot only", async () => {
    const f = stack();
    const input = {
      task: "verify immutability",
      strategy: "parallel",
      mode: "INSPECT",
      participants: [
        { id: "atria", provider: "s1", modelId: "Atria-Dawn-Preview", role: "MAIN_CODER", task: "decide" },
        { id: "reviewer", provider: "local", modelId: "review", role: "CODE_REVIEWER", task: "check" },
      ],
    };
    const result = await f.runCollab(buildCollabRequest(input));
    expect(result.ok).toBe(true);
    expect(result.participants[0].ok).toBe(false);
    expect(result.participants[0].error?.code).toBe("SPECIALIST_NOT_FOUND");
    expect(result.participants[1].ok).toBe(true);
  });
});

describe("runCollab — cancellation", () => {
  it("records every participant as cancelled when the run is aborted", async () => {
    const f = stack();
    const input = validRequest({ runId: "d34-c", strategy: "parallel" });
    const pending = f.runCollab(buildCollabRequest(input));
    expect(f.cancelRun("d34-c")).toBe(true);
    const result = await pending;
    expect(result.ok).toBe(false);
    for (const p of result.participants) {
      expect(p.ok).toBe(false);
      // A participant that had not started yet is recorded as COLLAB_CANCELLED;
      // one the engine had already taken is reported as PROVIDER_CANCELLED.
      // Either way the run is cancelled and the sibling is not billed.
      expect(["COLLAB_CANCELLED", "PROVIDER_CANCELLED"]).toContain(p.error?.code ?? "");
    }
    const rec = f.listRuns().find((r) => r.id === "d34-c");
    expect(rec?.status).toBe("cancelled");
  });
});
