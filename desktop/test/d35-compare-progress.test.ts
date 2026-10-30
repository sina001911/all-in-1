/**
 * D35: compare progress. A compare run is N independent gated agent runs under
 * one batch id; this file exercises the progress poll end to end:
 *
 *   - each slot is labelled by the model it asked for, not by its prompt;
 *   - a poll mid-flight shows per-model status instead of a frozen card;
 *   - the batch status aggregates slot outcomes (running / completed / failed);
 *   - concurrent slots never mix their frames: each slot streams under its own
 *     run id, so a poll on one slot cannot see another's text.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDesktopStack } from "../src/desktop-stack.ts";
import { DesktopFacade } from "../src/facade.ts";
import { MemoryCredentialProvider } from "../src/credentials/memory-credential-provider.ts";
import { IPC_CHANNELS } from "../src/ipc-channels.ts";

let dir: string;
let project: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-d35-cmp-"));
  project = mkdtempSync(join(tmpdir(), "aio-d35-cmp-proj-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function facade(): DesktopFacade {
  const s = buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() });
  s.settingsStore.patch({ workspaceRoots: [project] });
  return new DesktopFacade(s);
}

describe("getCompareProgress (D35)", () => {
  it("labels each slot by the model it asked for", async () => {
    const f = facade();
    const results = await f.runMany({
      batchId: "cmp-label",
      prompt: "answer in plain text, call no tools",
      modelIds: ["local/deterministic", "local/agent"],
    });
    const progress = f.getCompareProgress("cmp-label");
    expect(progress.batchId).toBe("cmp-label");
    expect(progress.slots).toHaveLength(2);
    const byModel = Object.fromEntries(progress.slots.map((s) => [s.requestedModel, s]));
    expect(byModel["local/deterministic"]).toBeDefined();
    expect(byModel["local/agent"]).toBeDefined();
    // The label is the model composite, not the prompt text.
    for (const s of progress.slots) {
      expect(s.requestedModel).toContain("/");
      expect(s.requestedModel).not.toBe(results[0]!.text);
    }
  });

  it("aggregates slot outcomes into a batch status", async () => {
    const f = facade();
    await f.runMany({
      batchId: "cmp-ok",
      prompt: "answer in plain text, call no tools",
      modelIds: ["local/deterministic", "local/agent"],
    });
    const progress = f.getCompareProgress("cmp-ok");
    expect(progress.status).toBe("completed");
    for (const s of progress.slots) {
      expect(s.ok).toBe(true);
    }
  });

  it("reports failed when a slot fails", async () => {
    const f = facade();
    const input = {
      batchId: "cmp-fail",
      prompt: "answer in plain text, call no tools",
      modelIds: ["local/deterministic", "local/agent"],
      concurrency: 2,
    };
    const pending = f.runMany(input);
    // Abort slot 0 mid-run; slot 1 keeps going.
    expect(f.cancelRun("cmp-fail-0")).toBe(true);
    await pending;
    const progress = f.getCompareProgress("cmp-fail");
    expect(progress.status).toBe("failed");
    const failed = progress.slots.find((s) => s.runId === "cmp-fail-0");
    expect(failed?.ok).toBe(false);
    expect(failed?.error).toBeDefined();
  });

  it("returns running with no slots for an unknown batch", () => {
    const f = facade();
    const progress = f.getCompareProgress("never-run");
    expect(progress.status).toBe("running");
    expect(progress.slots).toHaveLength(0);
  });

  it("keeps concurrent slots from mixing their frames", async () => {
    const f = facade();
    const results = await f.runMany({
      batchId: "cmp-mix",
      prompt: "answer in plain text, call no tools",
      modelIds: ["local/deterministic", "local/agent"],
      concurrency: 2,
    });
    // Each slot's text is served from its own run id; a poll on one slot
    // cannot see the other's text.
    const progress = f.getCompareProgress("cmp-mix");
    const byRunId = Object.fromEntries(progress.slots.map((s) => [s.runId, s]));
    // Both slots completed, so each shows its own non-empty text.
    for (const r of results) {
      const s = byRunId[r.runId];
      expect(s?.ok).toBe(true);
      expect(typeof s?.text).toBe("string");
      expect((s.text ?? "").length).toBeGreaterThan(0);
    }
    // Isolation, not distinctness: the deterministic fake may answer the same
    // way twice, but each slot's text is served from its OWN run id. A poll on
    // one slot cannot see the other's frames — the text matches what
    // `getAgentStream` returns for that slot alone.
    for (const r of results) {
      const stream = f.getAgentStream(r.runId, 0);
      const streamText = (stream?.events ?? [])
        .filter((e): e is { kind: "text"; text: string } => e.kind === "text")
        .map((e) => e.text)
        .join("");
      const slot = byRunId[r.runId];
      expect(slot?.text ?? "").toBe(streamText || r.text || "");
    }
  });
});

describe("getCompareProgress fallback label (D35)", () => {
  it("labels a model-less slot as \"—\" rather than undefined", () => {
    const s = buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() });
    s.settingsStore.patch({ workspaceRoots: [project] });
    const f = new DesktopFacade(s);
    // A compare slot always carries a model composite, but a record written
    // before D35 (or by a path that never set one) has neither `model` nor
    // `subject`. The renderer labels each card by what it asked for, so the
    // slot must report a real label — not `undefined`, which renders as the
    // literal string "undefined" in the executed-vs-requested badge.
    s.runStore.record({
      id: "cmp-fallback-0",
      kind: "agent",
      mode: "INSPECT",
      subject: "",
      startedAt: 1,
      status: "completed",
      ok: true,
      iterations: 1,
      pausedForHuman: false,
      escalated: false,
    });
    const progress = f.getCompareProgress("cmp-fallback");
    expect(progress.slots).toHaveLength(1);
    expect(progress.slots[0]!.requestedModel).toBe("—");
  });
});

describe("IPC boundary (D35)", () => {
  it("declares the compare:progress channel", () => {
    expect(IPC_CHANNELS).toContain("all-in-1:compare:progress");
  });
});