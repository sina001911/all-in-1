/**
 * Egress policy suite (P4): the new network security boundary.
 *
 * Pinned properties:
 * - the shipped default is deny-all, so NO remote host is reachable until a
 *   user explicitly allowlists it;
 * - loopback is always permitted (fixture servers), with plain http opt-in;
 * - remote endpoints must use https;
 * - an invalid URL is never silently allowed.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EGRESS_POLICY,
  allowHost,
  assertEgressAllowed,
  isEgressAllowed,
} from "../src/execution/egress.ts";
import { EgressBlockedError } from "../src/execution/egress.ts";

describe("default egress policy", () => {
  it("is deny-all with an empty allowlist", () => {
    expect(DEFAULT_EGRESS_POLICY.kind).toBe("deny-all");
    expect(DEFAULT_EGRESS_POLICY.allowlist).toEqual([]);
  });

  it("permits loopback over https", () => {
    expect(isEgressAllowed("https://127.0.0.1:8443/", DEFAULT_EGRESS_POLICY)).toBe(true);
    expect(isEgressAllowed("https://localhost:8443/", DEFAULT_EGRESS_POLICY)).toBe(true);
  });

  it("permits loopback plain http by default (fixture servers)", () => {
    expect(isEgressAllowed("http://127.0.0.1:3000/", DEFAULT_EGRESS_POLICY)).toBe(true);
  });

  it("blocks every remote host", () => {
    expect(isEgressAllowed("https://api.openai.com/", DEFAULT_EGRESS_POLICY)).toBe(false);
    expect(isEgressAllowed("https://openrouter.ai/api/v1", DEFAULT_EGRESS_POLICY)).toBe(false);
  });

  it("treats a null endpoint as allowed (keyless local adapters)", () => {
    expect(isEgressAllowed(null, DEFAULT_EGRESS_POLICY)).toBe(true);
  });
});

describe("explicit allowlist", () => {
  const policy = allowHost(
    allowHost(DEFAULT_EGRESS_POLICY, "api.openai.com"),
    "openrouter.ai",
  );

  it("permits an allowlisted host over https", () => {
    expect(isEgressAllowed("https://api.openai.com/v1/chat/completions", policy)).toBe(true);
  });

  it("still blocks a host that is not allowlisted", () => {
    expect(isEgressAllowed("https://example.com/", policy)).toBe(false);
  });

  it("blocks an allowlisted host over plain http", () => {
    expect(isEgressAllowed("http://api.openai.com/", policy)).toBe(false);
  });

  it("still permits loopback", () => {
    expect(isEgressAllowed("http://127.0.0.1:3000/", policy)).toBe(true);
  });

  it("is case-insensitive and idempotent", () => {
    const once = allowHost(DEFAULT_EGRESS_POLICY, "API.OpenAI.com");
    expect(once.allowlist).toEqual(["API.OpenAI.com"]);
    const twice = allowHost(once, "api.openai.com");
    expect(twice.allowlist).toHaveLength(1);
    expect(isEgressAllowed("https://api.openai.com/", once)).toBe(true);
  });

  it("ignores a loopback host argument", () => {
    const policy2 = allowHost(DEFAULT_EGRESS_POLICY, "127.0.0.1");
    expect(policy2.allowlist).toEqual([]);
  });
});

describe("assertEgressAllowed", () => {
  it("throws EGRESS_BLOCKED under the default policy", () => {
    expect(() =>
      assertEgressAllowed("https://api.openai.com/", DEFAULT_EGRESS_POLICY),
    ).toThrowError(EgressBlockedError);
    expect(
      () => assertEgressAllowed("https://api.openai.com/", DEFAULT_EGRESS_POLICY),
    ).toThrow(/deny-all/);
  });

  it("names the host that was refused", () => {
    try {
      assertEgressAllowed("https://openrouter.ai/", DEFAULT_EGRESS_POLICY);
      expect.fail("expected EgressBlockedError");
    } catch (e) {
      expect(e).toBeInstanceOf(EgressBlockedError);
      expect((e as EgressBlockedError).host).toBe("openrouter.ai");
      expect((e as EgressBlockedError).code).toBe("EGRESS_BLOCKED");
      expect((e as EgressBlockedError).category).toBe("security");
    }
  });

  it("rejects an unallowlisted host even when others are allowed", () => {
    const policy = allowHost(DEFAULT_EGRESS_POLICY, "api.openai.com");
    expect(() => assertEgressAllowed("https://evil.example/", policy)).toThrow(
      /not on the egress allowlist/,
    );
  });

  it("rejects an invalid URL", () => {
    expect(() => assertEgressAllowed("not a url", DEFAULT_EGRESS_POLICY)).toThrow(
      /not a valid URL/,
    );
  });

  it("does not throw for loopback or a null endpoint", () => {
    expect(() =>
      assertEgressAllowed("http://127.0.0.1:3000/", DEFAULT_EGRESS_POLICY),
    ).not.toThrow();
    expect(() => assertEgressAllowed(null, DEFAULT_EGRESS_POLICY)).not.toThrow();
  });
});
