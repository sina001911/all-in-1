/**
 * Egress + media-router integration checks (P1-6 / D35).
 *
 * Verifies the security boundary the user's Phase 2 instructions asked for:
 *   1. A registered OpenRouter provider contributes exactly its hostname to the
 *      egress allowlist — nothing more, nothing less.
 *   2. The default deny-all policy blocks OpenRouter until the host is added.
 *   3. A non-https remote endpoint is refused even when its host is allowlisted.
 *   4. Loopback providers contribute nothing (loopback is already allowed).
 *
 * These run against the real code, not a mock: `hostsForProviders` and
 * `assertEgressAllowed` are the same functions the desktop stack uses at
 * startup and on every provider reload.
 */
import { describe, expect, it } from "vitest";
import { assertEgressAllowed, DEFAULT_EGRESS_POLICY, allowHost } from "../src/execution/egress.ts";
import { hostsForProviders } from "../desktop/src/desktop-stack.ts";
import type { SettingsProvider } from "../desktop/src/persistence/types.ts";

function openRouterProvider(): SettingsProvider {
  return {
    id: "openrouter",
    displayName: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1",
    protocol: "openai-compatible",
    apiKeyEnv: "OPENROUTER_API_KEY",
    models: [{ id: "bytedance-seed/seedream-5-0-flash", displayName: "Seedream 5.0 Flash" }],
  };
}

describe("egress allowlist for a media provider", () => {
  it("adds exactly the provider's hostname", () => {
    const hosts = hostsForProviders([openRouterProvider()]);
    expect(hosts).toEqual(["openrouter.ai"]);
  });

  it("deduplicates and ignores loopback", () => {
    const hosts = hostsForProviders([
      openRouterProvider(),
      {
        id: "local",
        displayName: "Local",
        endpoint: "http://127.0.0.1:11434/v1",
        models: [{ id: "llama3", displayName: "llama3" }],
      },
      openRouterProvider(), // duplicate
    ]);
    expect(hosts).toEqual(["openrouter.ai"]);
  });

  it("drops unparseable endpoints without throwing", () => {
    const hosts = hostsForProviders([
      {
        id: "bad",
        displayName: "Bad",
        endpoint: "not a url",
        models: [{ id: "x", displayName: "x" }],
      },
    ]);
    expect(hosts).toEqual([]);
  });
});

describe("egress assertion against the OpenRouter endpoint", () => {
  it("is blocked by the default deny-all policy", () => {
    expect(() => assertEgressAllowed("https://openrouter.ai/api/v1", DEFAULT_EGRESS_POLICY)).toThrow(
      /deny-all/,
    );
  });

  it("is allowed once the host is on the allowlist", () => {
    const policy = { ...DEFAULT_EGRESS_POLICY, kind: "explicit-allowlist" as const, allowlist: ["openrouter.ai"] };
    expect(() => assertEgressAllowed("https://openrouter.ai/api/v1", policy)).not.toThrow();
  });

  it("refuses a remote plain-http endpoint even when allowlisted", () => {
    const policy = { ...DEFAULT_EGRESS_POLICY, kind: "explicit-allowlist" as const, allowlist: ["evil.example"] };
    expect(() => assertEgressAllowed("http://evil.example/api", policy)).toThrow(
      /must use https/,
    );
  });

  it("permits loopback http without an allowlist entry", () => {
    expect(() => assertEgressAllowed("http://127.0.0.1:8080/v1", DEFAULT_EGRESS_POLICY)).not.toThrow();
    expect(() => assertEgressAllowed("http://localhost:8080/v1", DEFAULT_EGRESS_POLICY)).not.toThrow();
  });
});