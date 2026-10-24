/**
 * D34: Collaborate orchestrator, unit-tested with a deterministic mock runner.
 *
 * The mock returns canned `SpecialistResponse`s, so no engine, no gate, and no
 * network is involved — the tests pin down the orchestrator's own logic:
 * strategy dispatch, bounded concurrency, sequential context forwarding,
 * pairwise disagreement detection, synthesis provenance, and cancellation.
 */
import { describe, it, expect, vi } from "vitest";
import { CollaborateOrchestrator } from "../src/collab/orchestrator.ts";
import type { CollaborateOrchestratorOptions } from "../src/collab/orchestrator.ts";
import type { SpecialistResponse, SpecialistRequest } from "../src/specialists/types.ts";
import type { SpecialistRunner } from "../src/specialists/runner.ts";
import type { InvokeOptions } from "../src/execution/engine.ts";

/** A fake runner that emits deterministic responses for the roles it knows. */
function mockRunner(responses: Map<string, SpecialistResponse>): {
  runner: SpecialistRunner;
  seen: { role: string; prompt: string }[];
} {
  const seen: { role: string; prompt: string }[] = [];
  const runner = {
    run: async (req: SpecialistRequest, _opts?: InvokeOptions): Promise<SpecialistResponse> => {
      seen.push({ role: req.role, prompt: req.prompt });
      const r = responses.get(req.role);
      if (!r) {
        return {
          ok: false,
          error: { code: "SPECIALIST_NOT_FOUND", message: `No specialist for ${req.role}`, retryable: false },
        };
      }
      return r;
    },
  } as unknown as SpecialistRunner;
  return { runner, seen };
}

function okResponse(
  role: string,
  structured: unknown,
  modelId: string,
): SpecialistResponse {
  return {
    ok: true,
    structured,
    accounting: {
      modelId,
      adapterId: "mock",
      capability: "MOCK",
      committedUsd: 0,
      latencyMs: 1,
    },
  };
}

function failResponse(code: string, retryable = false): SpecialistResponse {
  return {
    ok: false,
    error: { code, message: `mock ${code}`, retryable },
  };
}

function makeOpts(
  req: import("../src/collab/types.ts").CollaborateRequest,
  responses: Map<string, SpecialistResponse>,
  onStreamEvent?: CollaborateOrchestratorOptions["onStreamEvent"],
): CollaborateOrchestratorOptions {
  const { runner } = mockRunner(responses);
  return { runner, request: req, onStreamEvent };
}

function twoParticipants(over?: Partial<import("../src/collab/types.ts").CollaborateRequest>): import("../src/collab/types.ts").CollaborateRequest {
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

describe("CollaborateOrchestrator — validation", () => {
  it("rejects a request with fewer than two participants", async () => {
    const req = twoParticipants();
    const opts = makeOpts({ ...req, participants: [req.participants[0]] }, new Map());
    const result = await new CollaborateOrchestrator(opts).run();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("NO_PARTICIPANTS");
  });

  it("rejects a blank task", async () => {
    const req = twoParticipants({ task: "   " });
    const opts = makeOpts(req, new Map());
    const result = await new CollaborateOrchestrator(opts).run();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_COLLAB_REQUEST");
  });

  it("rejects an unknown strategy", async () => {
    const req = twoParticipants();
    const opts = makeOpts({ ...req, strategy: "diagonal" as "parallel" }, new Map());
    const result = await new CollaborateOrchestrator(opts).run();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_STRATEGY");
  });
});

describe("CollaborateOrchestrator — parallel", () => {
  it("runs every participant and reports them all ok", async () => {
    const responses = new Map<string, SpecialistResponse>([
      ["DEEP_REASONING", okResponse("DEEP_REASONING", { decision: "A", rationale: "because A" }, "local/deep")],
      ["CODE_REVIEWER", okResponse("CODE_REVIEWER", { decision: "A", rationale: "A looks fine" }, "local/review")],
    ]);
    const opts = makeOpts(twoParticipants(), responses);
    const result = await new CollaborateOrchestrator(opts).run();
    expect(result.ok).toBe(true);
    expect(result.participants).toHaveLength(2);
    expect(result.participants[0].ok).toBe(true);
    expect(result.participants[1].ok).toBe(true);
    expect(result.participants[0].modelId).toBe("local/deep");
    expect(result.participants[1].modelId).toBe("local/review");
  });

  it("isolates one participant's failure from its siblings", async () => {
    const responses = new Map<string, SpecialistResponse>([
      ["DEEP_REASONING", failResponse("PROVIDER_TIMEOUT")],
      ["CODE_REVIEWER", okResponse("CODE_REVIEWER", { decision: "B" }, "local/review")],
    ]);
    const opts = makeOpts(twoParticipants(), responses);
    const result = await new CollaborateOrchestrator(opts).run();
    expect(result.ok).toBe(true); // one succeeded
    expect(result.participants[0].ok).toBe(false);
    expect(result.participants[0].error?.code).toBe("PROVIDER_TIMEOUT");
    expect(result.participants[1].ok).toBe(true);
  });

  it("fails when every participant fails", async () => {
    const responses = new Map<string, SpecialistResponse>([
      ["DEEP_REASONING", failResponse("PROVIDER_CALL_FAILED")],
      ["CODE_REVIEWER", failResponse("PROVIDER_CALL_FAILED")],
    ]);
    const opts = makeOpts(twoParticipants(), responses);
    const result = await new CollaborateOrchestrator(opts).run();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("COLLAB_ALL_FAILED");
  });
});

describe("CollaborateOrchestrator — sequential", () => {
  it("forwards the previous participant's answer as context", async () => {
    const responses = new Map<string, SpecialistResponse>([
      ["DEEP_REASONING", okResponse("DEEP_REASONING", { text: "first analysis" }, "local/deep")],
      ["CODE_REVIEWER", okResponse("CODE_REVIEWER", { text: "second review" }, "local/review")],
    ]);
    const req = twoParticipants({ strategy: "sequential" });
    const { runner, seen } = mockRunner(responses);
    const opts: CollaborateOrchestratorOptions = { runner, request: req };
    await new CollaborateOrchestrator(opts).run();
    // The second participant's prompt should reference the first participant's output.
    expect(seen[1].prompt).toContain("first analysis");
  });

  it("stops the chain on a non-retryable failure and skips the rest", async () => {
    const responses = new Map<string, SpecialistResponse>([
      ["DEEP_REASONING", failResponse("PROVIDER_CALL_FAILED", false)],
      ["CODE_REVIEWER", okResponse("CODE_REVIEWER", { text: "should not run" }, "local/review")],
    ]);
    const req = twoParticipants({ strategy: "sequential" });
    const opts = makeOpts(req, responses);
    const result = await new CollaborateOrchestrator(opts).run();
    expect(result.participants[0].ok).toBe(false);
    expect(result.participants[1].ok).toBe(false);
    expect(result.participants[1].error?.code).toBe("COLLAB_SKIPPED");
  });
});

describe("CollaborateOrchestrator — debate + synthesis", () => {
  it("detects a disagreement on a field two participants set differently", async () => {
    const responses = new Map<string, SpecialistResponse>([
      ["DEEP_REASONING", okResponse("DEEP_REASONING", { decision: "A", confidence: 0.9 }, "local/deep")],
      ["CODE_REVIEWER", okResponse("CODE_REVIEWER", { decision: "B", confidence: 0.7 }, "local/review")],
    ]);
    const req = twoParticipants({ strategy: "debate" });
    const opts = makeOpts(req, responses);
    const result = await new CollaborateOrchestrator(opts).run();
    // Both common fields differ, so both are surfaced — the disagreement list
    // is a complete inventory, not a single example.
    expect(result.disagreements?.length).toBe(2);
    const fields = result.disagreements!.map((d) => d.field).sort();
    expect(fields).toEqual(["confidence", "decision"]);
    const decision = result.disagreements!.find((d) => d.field === "decision");
    expect(decision?.between).toEqual(["p1", "p2"]);
    // Values are carried as their JSON representation, so a structured field's
    // raw value is never ambiguous (a string "A" vs the bare token A).
    expect(decision?.a).toBe('"A"');
    expect(decision?.b).toBe('"B"');
    expect(decision?.resolution).toBe("unresolved");
  });

  it("synthesizes when a synthesis model is named and carries provenance", async () => {
    const responses = new Map<string, SpecialistResponse>([
      ["DEEP_REASONING", okResponse("DEEP_REASONING", { text: "A" }, "local/deep")],
      ["CODE_REVIEWER", okResponse("CODE_REVIEWER", { text: "B" }, "local/review")],
    ]);
    const req = twoParticipants({
      strategy: "debate",
      synthesis: { provider: "local", modelId: "synth" },
    });
    const opts = makeOpts(req, responses);
    const result = await new CollaborateOrchestrator(opts).run();
    expect(result.synthesis).toBeDefined();
    expect(result.synthesis!.text).toBe("A");
    // `modelId` is the model that ACTUALLY executed the synthesis, which the
    // mock runner chose — never a silent substitution of the requested one.
    expect(result.synthesis!.modelId).toBe("local/deep");
    expect(result.synthesis!.provenance).toHaveLength(2);
    expect(result.synthesis!.provenance[0].participantId).toBe("p1");
    expect(result.synthesis!.provenance[1].participantId).toBe("p2");
  });

  it("reports no synthesis when one was not requested", async () => {
    const responses = new Map<string, SpecialistResponse>([
      ["DEEP_REASONING", okResponse("DEEP_REASONING", { text: "A" }, "local/deep")],
      ["CODE_REVIEWER", okResponse("CODE_REVIEWER", { text: "B" }, "local/review")],
    ]);
    const req = twoParticipants({ strategy: "parallel" });
    const opts = makeOpts(req, responses);
    const result = await new CollaborateOrchestrator(opts).run();
    expect(result.synthesis).toBeUndefined();
  });
});

describe("CollaborateOrchestrator — cancellation", () => {
  it("records every participant as cancelled when the signal aborts before the run", async () => {
    const controller = new AbortController();
    controller.abort();
    const responses = new Map<string, SpecialistResponse>();
    const req = twoParticipants({ signal: controller.signal });
    const opts = makeOpts(req, responses);
    const result = await new CollaborateOrchestrator(opts).run();
    expect(result.participants).toHaveLength(2);
    for (const p of result.participants) {
      expect(p.ok).toBe(false);
      expect(p.error?.code).toBe("COLLAB_CANCELLED");
    }
  });

  it("honours the signal between participants in a sequential run", async () => {
    const controller = new AbortController();
    const responses = new Map<string, SpecialistResponse>([
      ["DEEP_REASONING", okResponse("DEEP_REASONING", { text: "A" }, "local/deep")],
      ["CODE_REVIEWER", okResponse("CODE_REVIEWER", { text: "B" }, "local/review")],
    ]);
    const req = twoParticipants({ strategy: "sequential", signal: controller.signal });
    // Abort after the first participant's mock completes.
    const seen: unknown[] = [];
    const { runner } = mockRunner(responses);
    const wrappedRunner = {
      run: async (r: import("../src/specialists/types.ts").SpecialistRequest, o?: InvokeOptions) => {
        const out = await runner.run(r, o);
        seen.push(out);
        controller.abort();
        return out;
      },
    } as unknown as SpecialistRunner;
    const opts: CollaborateOrchestratorOptions = { runner: wrappedRunner, request: req };
    const result = await new CollaborateOrchestrator(opts).run();
    expect(result.participants[0].ok).toBe(true);
    expect(result.participants[1].ok).toBe(false);
    expect(result.participants[1].error?.code).toBe("COLLAB_CANCELLED");
  });
});

describe("CollaborateOrchestrator — accounting", () => {
  it("surfaces accounting from every settled participant", async () => {
    const responses = new Map<string, SpecialistResponse>([
      ["DEEP_REASONING", okResponse("DEEP_REASONING", { text: "A" }, "local/deep")],
      ["CODE_REVIEWER", okResponse("CODE_REVIEWER", { text: "B" }, "local/review")],
    ]);
    const req = twoParticipants();
    const opts = makeOpts(req, responses);
    const result = await new CollaborateOrchestrator(opts).run();
    expect(result.participants[0].accounting).toBeDefined();
    expect(result.participants[0].accounting?.modelId).toBe("local/deep");
    expect(result.participants[1].accounting?.modelId).toBe("local/review");
  });
});

describe("CollaborateOrchestrator — MAIN_CODER immutability", () => {
  it("does not default to MAIN_CODER; an unregistered role fails per participant", async () => {
    // MAIN_CODER has no registered specialist, so a participant that names it
    // gets `SPECIALIST_NOT_FOUND` for that slot, and the run still succeeds if
    // its siblings are ok.
    const responses = new Map<string, SpecialistResponse>([
      ["CODE_REVIEWER", okResponse("CODE_REVIEWER", { text: "fine" }, "local/review")],
    ]);
    const req: import("../src/collab/types.ts").CollaborateRequest = {
      task: "verify immutability",
      strategy: "parallel",
      mode: "INSPECT",
      participants: [
        { id: "atria", provider: "s1", modelId: "Atria-Dawn-Preview", role: "MAIN_CODER", task: "decide" },
        { id: "reviewer", provider: "local", modelId: "review", role: "CODE_REVIEWER", task: "check" },
      ],
    };
    const opts = makeOpts(req, responses);
    const result = await new CollaborateOrchestrator(opts).run();
    expect(result.participants[0].ok).toBe(false);
    expect(result.participants[0].error?.code).toBe("SPECIALIST_NOT_FOUND");
    expect(result.participants[1].ok).toBe(true);
    expect(result.ok).toBe(true);
  });
});
