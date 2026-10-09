/**
 * Workflow orchestration suite (P5): the human-in-the-loop loop.
 *
 * Pinned properties:
 * - INSPECT may analyze only; planning is refused with MODE_VIOLATION;
 * - without `--auto` the loop pauses for the human after every step;
 * - `--auto` is opt-in and bounded: it stops at maxIterations (5);
 * - escalation pauses the loop and asks for a human, even under `--auto`;
 * - cancellation stops the loop cleanly with WORKFLOW_CANCELLED;
 * - no file-writing capability exists in the workflow at all.
 */
import { describe, expect, it } from "vitest";
import { WorkflowLoop, WORKFLOW_MAX_ITERATIONS } from "../src/workflow/index.ts";
import type { StepResult, WorkflowResult } from "../src/workflow/index.ts";
import type { SpecialistRequest, SpecialistResponse } from "../src/specialists/types.ts";
import type { SpecialistRunner } from "../src/specialists/index.ts";
import type { ModelRole } from "../src/registry/roles.ts";

const MAX = WORKFLOW_MAX_ITERATIONS;

/** A controllable runner: returns queued responses in order. */
function fakeRunner(
  responses: ReadonlyArray<SpecialistResponse>,
  onStep?: (request: SpecialistRequest) => void,
): SpecialistRunner {
  let i = 0;
  const run = async (request: SpecialistRequest): Promise<SpecialistResponse> => {
    onStep?.(request);
    const next = responses[i];
    i += 1;
    return next ?? ({ ok: true, structured: { summary: "ok" } } as SpecialistResponse);
  };
  return { run } as unknown as SpecialistRunner;
}

function steps(count: number, role: ModelRole = "FAST_TASK"): SpecialistRequest[] {
  return Array.from({ length: count }, () => ({
    role,
    prompt: "x",
    inputs: [{ kind: "text", text: "x" }],
    outputSchema: {},
  }));
}

function okSummary(summary: string): SpecialistResponse {
  return { ok: true, structured: { summary } };
}

function retryable(): SpecialistResponse {
  return {
    ok: false,
    error: { code: "PROVIDER_RATE_LIMITED", message: "busy", retryable: true },
  };
}

function fatal(): SpecialistResponse {
  return {
    ok: false,
    error: { code: "STRUCTURED_OUTPUT_INVALID", message: "bad shape", retryable: false },
  };
}

describe("workflow mode enforcement", () => {
  it("runs an analysis step in INSPECT", async () => {
    const loop = new WorkflowLoop({
      runner: fakeRunner([okSummary("a")]),
      request: { mode: "INSPECT", steps: steps(1) },
    });
    const result = await loop.run();
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(1);
  });

  it("refuses planning in INSPECT with MODE_VIOLATION", async () => {
    const loop = new WorkflowLoop({
      runner: fakeRunner([]),
      request: { mode: "INSPECT", steps: steps(1), plan: true },
    });
    const result = await loop.run();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("MODE_VIOLATION");
    expect(result.results).toHaveLength(0);
  });

  it("allows planning in SUGGEST and builds a plan", async () => {
    const loop = new WorkflowLoop({
      runner: fakeRunner([okSummary("do the thing")]),
      request: { mode: "SUGGEST", steps: steps(1), plan: true },
    });
    const result = await loop.run();
    expect(result.ok).toBe(true);
    expect(result.plan).toEqual(["- [FAST_TASK] do the thing"]);
  });

  it("uses a fallback label when the output has no summary", async () => {
    const loop = new WorkflowLoop({
      runner: fakeRunner([{ ok: true, structured: { findings: [] } }]),
      request: { mode: "SUGGEST", steps: steps(1), plan: true },
    });
    const result = await loop.run();
    expect(result.plan).toEqual(["- [FAST_TASK] analysis completed"]);
  });
});

describe("workflow human-in-the-loop", () => {
  it("pauses after one step when not autonomous", async () => {
    const loop = new WorkflowLoop({
      runner: fakeRunner([okSummary("a"), okSummary("b")]),
      request: { mode: "BUILD", steps: steps(3) },
    });
    const result = await loop.run();
    expect(result.ok).toBe(true);
    expect(result.pausedForHuman).toBe(true);
    expect(result.iterations).toBe(1);
    expect(result.auto).toBe(false);
  });

  it("resumes on the next call from where it paused", async () => {
    const loop = new WorkflowLoop({
      runner: fakeRunner([okSummary("a"), okSummary("b"), okSummary("c")]),
      request: { mode: "BUILD", steps: steps(3) },
    });
    const first = await loop.run();
    expect(first.iterations).toBe(1);
    const second = await loop.run();
    expect(second.iterations).toBe(2);
    const third = await loop.run();
    expect(third.iterations).toBe(3);
    expect(third.pausedForHuman).toBe(false);
  });

  it("runs every step without pausing under --auto", async () => {
    const loop = new WorkflowLoop({
      runner: fakeRunner([okSummary("a"), okSummary("b"), okSummary("c")]),
      request: { mode: "BUILD", steps: steps(3), auto: { auto: true } },
    });
    const result = await loop.run();
    expect(result.pausedForHuman).toBe(false);
    expect(result.iterations).toBe(3);
    expect(result.auto).toBe(true);
  });

  it("caps --auto at the frozen maximum of 5 iterations", async () => {
    const loop = new WorkflowLoop({
      runner: fakeRunner(Array.from({ length: 10 }, () => okSummary("a"))),
      request: { mode: "BUILD", steps: steps(10), auto: { auto: true } },
    });
    const result = await loop.run();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("WORKFLOW_AUTO_LIMIT");
    expect(result.iterations).toBe(MAX);
  });

  it("cannot raise the iteration ceiling past the frozen maximum", async () => {
    const loop = new WorkflowLoop({
      runner: fakeRunner(Array.from({ length: 20 }, () => okSummary("a"))),
      request: {
        mode: "BUILD",
        steps: steps(20),
        auto: { auto: true, maxIterations: 100 },
      },
    });
    const result = await loop.run();
    expect(result.iterations).toBe(MAX);
  });
});

describe("workflow escalation and cancellation", () => {
  it("escalates and pauses for a human on a retryable failure", async () => {
    const loop = new WorkflowLoop({
      runner: fakeRunner([retryable()]),
      request: { mode: "BUILD", steps: steps(3), auto: { auto: true } },
    });
    const result = await loop.run();
    expect(result.ok).toBe(false);
    expect(result.escalated).toBe(true);
    expect(result.error?.code).toBe("WORKFLOW_ESCALATED");
    expect(result.error?.retryable).toBe(true);
  });

  it("stops on a non-retryable failure without escalating", async () => {
    const loop = new WorkflowLoop({
      runner: fakeRunner([fatal()]),
      request: { mode: "BUILD", steps: steps(3), auto: { auto: true } },
    });
    const result = await loop.run();
    expect(result.ok).toBe(false);
    expect(result.escalated).toBe(false);
    expect(result.error?.code).toBe("STRUCTURED_OUTPUT_INVALID");
  });

  it("stops with WORKFLOW_CANCELLED when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const loop = new WorkflowLoop({
      runner: fakeRunner([okSummary("a")]),
      request: { mode: "BUILD", steps: steps(3), signal: controller.signal },
    });
    const result = await loop.run();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("WORKFLOW_CANCELLED");
    expect(result.iterations).toBe(0);
  });

  it("cancels between steps when the signal aborts mid-run", async () => {
    const controller = new AbortController();
    let calls = 0;
    const runner = {
      run: async (): Promise<SpecialistResponse> => {
        calls += 1;
        if (calls === 1) controller.abort();
        return okSummary("a");
      },
    } as unknown as SpecialistRunner;
    const loop = new WorkflowLoop({
      runner,
      request: { mode: "BUILD", steps: steps(3), signal: controller.signal },
    });
    const first = await loop.run();
    expect(first.iterations).toBe(1);
    expect(first.pausedForHuman).toBe(true);
    // The abort happened during the first step; the next turn observes it
    // before it touches the second step and stops with WORKFLOW_CANCELLED.
    const second = await loop.run();
    expect(second.error?.code).toBe("WORKFLOW_CANCELLED");
    expect(second.iterations).toBe(1);
  });
});

describe("workflow has no file-writing capability", () => {
  it("exposes no edit or write field in its result contract", async () => {
    const loop = new WorkflowLoop({
      runner: fakeRunner([okSummary("a")]),
      request: { mode: "BUILD", steps: steps(1) },
    });
    const result = await loop.run();
    // The result carries structured analysis only: no path, no diff, no edit.
    const forbidden = ["path", "diff", "edit", "write", "changes", "files"];
    for (const key of Object.keys(result)) {
      expect(forbidden).not.toContain(key);
    }
    for (const key of Object.keys(result.results[0] as StepResult)) {
      expect(forbidden).not.toContain(key);
    }
  });

  it("never produces a step result that carries a file path", async () => {
    const loop = new WorkflowLoop({
      runner: fakeRunner([okSummary("a")]),
      request: { mode: "BUILD", steps: steps(1) },
    });
    const result = await loop.run();
    // D25 adds an optional `accounting` field: it carries cost/token counters
    // only, never a path or an edit surface, so the invariant above is intact.
    const stepKeys: ReadonlyArray<keyof StepResult> = ["role", "response", "accounting"];
    for (const step of result.results) {
      for (const key of Object.keys(step)) {
        expect(stepKeys).toContain(key as keyof StepResult);
      }
    }
  });
});
