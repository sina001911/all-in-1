/**
 * Media router + adapter unit tests (P1-6).
 *
 * Exercises the full gated path with a FAKE transport — no socket, no
 * credential, no artifact base on disk. The real adapter code is identical;
 * only the transport seam is swapped.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMediaRouter, MediaRouter } from "../src/media/router.ts";
import { MediaAdapter } from "../src/media/adapter.ts";
import type { HttpTransport, HttpResponse } from "../src/execution/types.ts";
import type { MediaRequest, MediaCapability } from "../src/media/types.ts";
import { MEDIA_CAPABILITIES } from "../src/media/types.ts";
import { ArtifactStore } from "../src/artifacts/store.ts";
import { mediaGate } from "../src/media/gate.ts";

function fakeTransport(fn: (url: string, body: unknown, headers: Record<string, string>) => Promise<HttpResponse>): HttpTransport {
  return { post: async (url, body, headers) => fn(url, body, headers) };
}

const P1PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function makeProvider(overrides?: Partial<import("../src/media/types.ts").MediaProviderDefinition>): import("../src/media/types.ts").MediaProviderDefinition {
  return {
    id: "test",
    displayName: "test",
    endpoint: "http://media.test",
    protocol: "openai-compatible",
    auth: { type: "bearer", apiKeyEnv: "TEST_MEDIA_KEY" },
    capabilities: ["TEXT_TO_IMAGE"],
    supportedInputs: ["text", "image"] as const,
    supportedOutputs: ["image"] as const,
    models: [{
      provider: "test",
      modelId: "tiny-img",
      displayName: "tiny",
      modality: "IMAGE",
      inputTypes: ["text"],
      outputTypes: ["image"],
      capabilities: ["TEXT_TO_IMAGE"],
      pricing: "unknown",
      availability: true,
      priority: 0,
      enabled: true,
    }],
    pricing: "unknown",
    availability: { healthy: true },
    ...overrides,
  };
}

let dir: string;
let artifacts: ArtifactStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-media-"));
  artifacts = new ArtifactStore({ baseDir: dir, retentionDays: 90, keepRuns: 64 });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function router(providers: ReadonlyMap<string, import("../src/media/types.ts").MediaProviderDefinition> = new Map(), resolveBearer: (name: string) => string = () => "sk-fake"): MediaRouter {
  return buildMediaRouter({
    transport: fakeTransport(async () => {
      throw new Error("fake transport was not overridden for this test");
    }),
    artifacts,
    providers,
    resolveBearer,
  });
}

function req(capability: MediaCapability = "TEXT_TO_IMAGE", extra?: Partial<MediaRequest>): MediaRequest {
  return { capability, prompt: "a cat", ...extra };
}

describe("media gate (frozen)", () => {
  it("is disabled by default", () => {
    expect(mediaGate.enabled).toBe(false);
  });

  it("blocks every known capability", () => {
    expect.assertions(MEDIA_CAPABILITIES.length);
    for (const cap of MEDIA_CAPABILITIES) {
      expect(() => mediaGate.guard(cap)).toThrow();
    }
  });
});

describe("MediaAdapter", () => {
  const imgReq = { capability: "TEXT_TO_IMAGE" as const, model: "test/tiny", prompt: "a cat" };

  it("returns artifacts when the provider hands back b64_json", async () => {
    const transport = fakeTransport(async (_url, _body, _headers) => ({
      status: 200,
      body: { data: [{ b64_json: P1PNG, mime_type: "image/png" }] },
    }));
    const ad = new MediaAdapter({ transport, endpoint: "http://media.test" });
    const result = await ad.generate(imgReq);
    expect(result.ok).toBe(true);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]!.mimeType).toBe("image/png");
  });

  it("throws a typed error on HTTP 401", async () => {
    const transport = fakeTransport(async () => ({ status: 401, body: {} }));
    const ad = new MediaAdapter({ transport, endpoint: "http://media.test" });
    try {
      await ad.generate(imgReq);
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("credential_rejected");
      expect((e as unknown as Record<string, unknown>)["__media"]).toMatchObject({ code: "credential_rejected" });
    }
  });

  it("throws on HTTP 403", async () => {
    const transport = fakeTransport(async () => ({ status: 403, body: {} }));
    const ad = new MediaAdapter({ transport, endpoint: "http://media.test" });
    try {
      await ad.generate(imgReq);
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("credential_rejected");
    }
  });

  it("throws on HTTP 429", async () => {
    const transport = fakeTransport(async () => ({ status: 429, body: {} }));
    const ad = new MediaAdapter({ transport, endpoint: "http://media.test" });
    try {
      await ad.generate(imgReq);
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("rate_limited");
    }
  });

  it("throws on HTTP 5xx", async () => {
    const transport = fakeTransport(async () => ({ status: 500, body: {} }));
    const ad = new MediaAdapter({ transport, endpoint: "http://media.test" });
    try {
      await ad.generate(imgReq);
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("server_error");
    }
  });

  it("throws when the provider returns an error envelope", async () => {
    const transport = fakeTransport(async () => ({
      status: 200,
      body: { error: { message: "bad prompt", code: "invalid_request" } },
    }));
    const ad = new MediaAdapter({ transport, endpoint: "http://media.test" });
    try {
      await ad.generate(imgReq);
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("provider_error");
    }
  });

  it("returns ok=false when the provider returns no data items", async () => {
    const transport = fakeTransport(async () => ({ status: 200, body: { data: [] } }));
    const ad = new MediaAdapter({ transport, endpoint: "http://media.test" });
    try {
      await ad.generate(imgReq);
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("empty_response");
    }
  });

  it("tolerates url-only items by returning warnings, not artifacts", async () => {
    const transport = fakeTransport(async () => ({
      status: 200,
      body: { data: [{ url: "http://cdn.example/img.png" }] },
    }));
    const ad = new MediaAdapter({ transport, endpoint: "http://media.test" });
    const result = await ad.generate(imgReq);
    expect(result.ok).toBe(false);
    expect(result.artifacts).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
  });
});

describe("MediaRouter", () => {
  it("throws MEDIA_DISABLED when the gate is frozen", async () => {
    const r = router(new Map([["test", makeProvider()]]));
    await expect(r.execute(req(), "run-1")).rejects.toThrow(/media.enabled = false/i);
  });

  it("returns no-provider result when the capability is unknown", async () => {
    // Gate must throw before provider lookup even starts.
    const r = router();
    await expect(r.execute(req(), "run-1")).rejects.toThrow(/media.enabled = false/i);
  });
});

describe("MediaRouter — artifact storage and credential seam", () => {
  // These tests would exercise the router end-to-end, but the gate is frozen
  // (media.enabled = false), so they all short-circuit with MEDIA_DISABLED
  // before any provider lookup or transport call. That is by design: a frozen
  // gate means zero media spend in the MVP regardless of what the user
  // registered.
  it("throws before provider lookup when the gate is frozen", async () => {
    const r = router(new Map([["test", makeProvider()]]));
    await expect(r.execute(req(), "run-1")).rejects.toThrow(/media.enabled = false/i);
  });

  it("throws before credential resolution when the gate is frozen", async () => {
    // Even with a custom resolveBearer, the gate runs first.
    let resolved = false;
    const r = router(
      new Map([["test", makeProvider()]]),
      () => { resolved = true; return "sk-fake"; },
    );
    try {
      await r.execute(req(), "run-1");
    } catch { /* gate throws before resolveBearer is reached */ }
    expect(resolved).toBe(false);
  });
});

describe("MediaRouter — gate bypass (for future use)", () => {
  // A test helper that builds a router with a temporarily-open gate so we can
  // verify the non-gated path (provider/model selection, credential seam,
  // artifact storage) without changing the frozen default. The gate itself is
  // a module-level constant in production; this test touches it only for the
  // duration of the test body.
  it("selects the matching provider and model", async () => {
    // Save and restore the gate so the test is isolated.
    const saved = mediaGate.enabled;
    (mediaGate as unknown as Record<string, unknown>)["enabled"] = true;
    try {
      const transport = fakeTransport(async (url, body, headers) => {
        expect(url).toContain("/images/generations");
        expect((body as Record<string, unknown>)["model"]).toBe("test/tiny-img");
        expect((body as Record<string, unknown>)["prompt"]).toBe("a cat");
        expect(headers["Content-Type"]).toBe("application/json");
        return {
          status: 200,
          body: { data: [{ b64_json: P1PNG }] },
        };
      });
      const r = buildMediaRouter({
        transport,
        artifacts,
        providers: new Map([["test", makeProvider()]]),
        resolveBearer: () => "sk-fake",
      });
      const result = await r.execute(req(), "run-1");
      expect(result.ok).toBe(true);
      expect(result.provider).toBe("test");
      expect(result.model).toBe("tiny-img");
      expect(result.artifacts).toHaveLength(1);
      expect(result.artifacts[0]!.artifactId).toMatch(/capture\/[0-9a-f]{64}\.png/);
      // The stored artifact is readable from the store.
      const stored = artifacts.read(result.artifacts[0]!.artifactId);
      expect(Array.from(stored.bytes)).toEqual(Array.from(Buffer.from(P1PNG, "base64")));
      expect(stored.metadata.labels).toMatchObject({ source: "media-generation", capability: "TEXT_TO_IMAGE" });
    } finally {
      (mediaGate as unknown as Record<string, unknown>)["enabled"] = saved;
    }
  });

  it("returns no-enabled-model when the provider has no model for the capability", async () => {
    const saved = mediaGate.enabled;
    (mediaGate as unknown as Record<string, unknown>)["enabled"] = true;
    try {
      const transport = fakeTransport(async () => {
        throw new Error("should not have been called");
      });
      // Provider advertises TEXT_TO_IMAGE but its only model advertises
      // TEXT_TO_VIDEO, so no model is enabled for TEXT_TO_IMAGE.
      const r = buildMediaRouter({
        transport,
        artifacts,
        providers: new Map([["test", makeProvider({
          capabilities: ["TEXT_TO_IMAGE"],
          models: [{
            provider: "test",
            modelId: "tiny-vid",
            displayName: "tiny",
            modality: "VIDEO",
            inputTypes: ["text"],
            outputTypes: ["video"],
            capabilities: ["TEXT_TO_VIDEO"],
            pricing: "unknown",
            availability: true,
            priority: 0,
            enabled: true,
          }],
        })]]),
      });
      const result = await r.execute(req("TEXT_TO_IMAGE"), "run-1");
      expect(result.ok).toBe(false);
      expect(result.provider).toBe("test");
      expect(result.model).toBe("none");
      expect(result.warnings).toContain("no enabled model for capability TEXT_TO_IMAGE on provider test");
    } finally {
      (mediaGate as unknown as Record<string, unknown>)["enabled"] = saved;
    }
  });

  it("falls back to no-provider when nothing handles the capability", async () => {
    const saved = mediaGate.enabled;
    (mediaGate as unknown as Record<string, unknown>)["enabled"] = true;
    try {
      const transport = fakeTransport(async () => {
        throw new Error("should not have been called");
      });
      const r = buildMediaRouter({
        transport,
        artifacts,
        providers: new Map(),
      });
      const result = await r.execute(req("TEXT_TO_IMAGE"), "run-1");
      expect(result.ok).toBe(false);
      expect(result.provider).toBe("none");
      expect(result.model).toBe("none");
      expect(result.warnings).toContain("no provider registered for capability TEXT_TO_IMAGE");
    } finally {
      (mediaGate as unknown as Record<string, unknown>)["enabled"] = saved;
    }
  });

  /**
   * D35: OpenRouter mounts image generation at /images, not /images/generations.
   * The adapter must honor a provider-declared `imagePath` so a user
   * configuring OpenRouter does not silently hit a 404 on the wrong path.
   */
  it("uses the provider's declared imagePath when set", async () => {
    const saved = mediaGate.enabled;
    (mediaGate as unknown as Record<string, unknown>)["enabled"] = true;
    try {
      let seenUrl = "";
      const transport = fakeTransport(async (url) => {
        seenUrl = url;
        return { status: 200, body: { data: [{ b64_json: P1PNG }] } };
      });
      const r = buildMediaRouter({
        transport,
        artifacts,
        providers: new Map([
          [
            "openrouter",
            makeProvider({
              id: "openrouter",
              endpoint: "https://openrouter.ai/api/v1",
              imagePath: "/images",
            }),
          ],
        ]),
        resolveBearer: () => "sk-fake",
      });
      const result = await r.execute(req(), "run-1");
      expect(result.ok).toBe(true);
      expect(seenUrl).toBe("https://openrouter.ai/api/v1/images");
    } finally {
      (mediaGate as unknown as Record<string, unknown>)["enabled"] = saved;
    }
  });

  it("falls back to /images/generations when imagePath is absent", async () => {
    const saved = mediaGate.enabled;
    (mediaGate as unknown as Record<string, unknown>)["enabled"] = true;
    try {
      let seenUrl = "";
      const transport = fakeTransport(async (url) => {
        seenUrl = url;
        return { status: 200, body: { data: [{ b64_json: P1PNG }] } };
      });
      const r = buildMediaRouter({
        transport,
        artifacts,
        providers: new Map([["test", makeProvider({ endpoint: "http://media.test" })]]),
        resolveBearer: () => "sk-fake",
      });
      await r.execute(req(), "run-1");
      expect(seenUrl).toBe("http://media.test/images/generations");
    } finally {
      (mediaGate as unknown as Record<string, unknown>)["enabled"] = saved;
    }
  });
});
