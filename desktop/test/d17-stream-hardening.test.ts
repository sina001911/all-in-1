/**
 * D17: streaming bridge hardening.
 *
 * Terminal entries are retained just long enough for a poll to return the last
 * reachable state, then pruned. The public contract broadly matches D12/D16 —
 * append/start/runId, cursor advancement, in-memory only — but the payload for
 * a terminal entry is not expected to hang around forever.
 */
import { describe, expect, it } from "vitest";
import { AgentStreamBridge } from "../src/stream-bridge.ts";

function event(text: string) {
  return { kind: "text" as const, text };
}

describe("AgentStreamBridge lifecycle", () => {
  it("terminal entries stay readable for the short retention window, then vanish", () => {
    let now = 1_000_000;
    const bridge = new AgentStreamBridge({ terminalRetentionMs: 1_000, now: () => now });
    bridge.start("r1");
    bridge.append("r1", event("hello"));
    bridge.done("r1");

    expect(bridge.getSince("r1", 0)?.events).toHaveLength(1);
    expect(bridge.getSince("r1", 1)?.state).toBe("done");

    now += 1_001;
    expect(bridge.getSince("r1", 0)).toBeUndefined();
  });

  it("a running run's envelope is never pruned by the terminal clock", () => {
    let now = 5_000_000;
    const bridge = new AgentStreamBridge({ terminalRetentionMs: 100, now: () => now });
    bridge.start("r2");
    bridge.append("r2", event("still running"));
    now += 10_000;
    expect(bridge.getSince("r2", 0)?.state).toBe("running");
  });

  it("concurrent runIds kept while one of them terminates expires", () => {
    let now = 10_000_000;
    const bridge = new AgentStreamBridge({ terminalRetentionMs: 10, now: () => now });
    bridge.start("a");
    bridge.start("b");
    bridge.append("a", event("a1"));
    bridge.append("b", event("b1"));
    bridge.failed("a", { code: "PROVIDER_STREAM_INTERRUPTED", message: "interrupted" });
    now += 20;
    expect(bridge.getSince("a", 0)).toBeUndefined();
    expect(bridge.getSince("b", 0)?.events).toHaveLength(1);
  });

  it("a later start for the same runId resets prior state", () => {
    const bridge = new AgentStreamBridge({ terminalRetentionMs: 60_000 });
    bridge.start("r3");
    bridge.append("r3", event("old"));
    bridge.done("r3");
    bridge.start("r3");
    expect(bridge.getSince("r3", 0)?.events).toEqual([]);
    expect(bridge.getSince("r3", 0)?.state).toBe("running");
  });

  it("transition to failed is terminal for the same entry", () => {
    const bridge = new AgentStreamBridge({ terminalRetentionMs: 60_000 });
    bridge.start("r4");
    bridge.append("r4", event("x"));
    bridge.failed("r4", { code: "X", message: "x" });
    bridge.done("r4");
    const envelope = bridge.getSince("r4", 0);
    expect(envelope?.state).toBe("failed");
  });
});
