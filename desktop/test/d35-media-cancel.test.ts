/**
 * D35: media cancel before the generation has asked for a signal.
 *
 * The desktop stack owns the per-call AbortController for media generation,
 * created lazily by `signalFor`. A cancel issued before that controller
 * exists used to return `false` and the generation would start with a live
 * signal — the human's "Cancel" would be silently dropped. The pending-intent
 * set records the cancel so the controller is aborted the moment it is
 * created.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDesktopStack } from "../src/desktop-stack.ts";
import { MemoryCredentialProvider } from "../src/credentials/memory-credential-provider.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-d35-medcancel-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function stack() {
  return buildDesktopStack({ baseDir: dir, credentials: new MemoryCredentialProvider() });
}

describe("mediaSignals pending cancel", () => {
  it("aborts the controller the moment it is created", () => {
    const s = stack();
    // Cancel before the generation has asked for a signal.
    expect(s.mediaSignals.cancel("media-preempt")).toBe(true);
    const signal = s.mediaSignals.signalFor("media-preempt");
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(true);
  });

  it("still aborts when the controller already exists", () => {
    const s = stack();
    const signal = s.mediaSignals.signalFor("media-live");
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);
    expect(s.mediaSignals.cancel("media-live")).toBe(true);
    expect(signal!.aborted).toBe(true);
  });

  it("returns true for a cancel that arrives first, even on an unknown run", () => {
    const s = stack();
    // The pending-intent path is the whole point: an unknown run is still a
    // cancel the adapter must honour, not a no-op.
    expect(s.mediaSignals.cancel("never-seen")).toBe(true);
    const signal = s.mediaSignals.signalFor("never-seen");
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(true);
  });
});