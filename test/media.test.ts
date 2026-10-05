/**
 * Media suite: media is disabled in the MVP. Every capability is gated to
 * MEDIA_DISABLED, no provider is registered, and the stub records intents only.
 */
import { describe, expect, it } from "vitest";
import { mediaGate, MediaDisabledError } from "../src/media/gate.ts";
import { stubMediaExecute, stubMediaProvider } from "../src/media/stub.ts";
import { MEDIA_CAPABILITIES } from "../src/media/types.ts";

describe("media gate", () => {
  it("is disabled by default", () => {
    expect(mediaGate.enabled).toBe(false);
  });

  it("blocks every capability with MEDIA_DISABLED", () => {
    expect.assertions(MEDIA_CAPABILITIES.length);
    for (const capability of MEDIA_CAPABILITIES) {
      expect(() => mediaGate.guard(capability)).toThrow(MediaDisabledError);
    }
  });

  it("records no enabled providers", () => {
    expect(stubMediaProvider.availability.healthy).toBe(false);
    expect(stubMediaProvider.models.every((m) => !m.enabled)).toBe(true);
  });

  it("stub records intent and produces no artifact", () => {
    const result = stubMediaExecute({ capability: "TEXT_TO_IMAGE", prompt: "hero" });
    expect(result.ok).toBe(false);
    expect(result.artifacts).toHaveLength(0);
    expect(result.warnings).toContain("media disabled in MVP; intent recorded only");
  });
});
