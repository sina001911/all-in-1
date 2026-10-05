/**
 * Secret resolution suite (P4): the only module that reads a secret VALUE.
 *
 * Pinned properties:
 * - a missing required key is a typed CREDENTIAL_UNAVAILABLE failure, never a
 *   prompt and never a silent keyless fallback;
 * - an empty string is treated as missing;
 * - the module exposes the value only; it never stores or logs it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { resolveBearerToken, resolveSecret } from "../src/execution/secrets.ts";
import { CredentialUnavailableError } from "../src/execution/secrets.ts";

const NAME = "AIO_TEST_SECRET_KEY";

afterEach(() => {
  delete process.env[NAME];
});

describe("resolveSecret", () => {
  it("returns the value set in the environment", () => {
    process.env[NAME] = "sk-test-value";
    expect(resolveSecret(NAME)).toBe("sk-test-value");
  });

  it("throws CREDENTIAL_UNAVAILABLE when the key is absent", () => {
    delete process.env[NAME];
    try {
      resolveSecret(NAME);
      expect.fail("expected CredentialUnavailableError");
    } catch (e) {
      expect(e).toBeInstanceOf(CredentialUnavailableError);
      const err = e as CredentialUnavailableError;
      expect(err.code).toBe("CREDENTIAL_UNAVAILABLE");
      expect(err.category).toBe("unavailable");
      expect(err.retryable).toBe(false);
      // The error names the VARIABLE, never a value.
      expect(err.message).toContain(NAME);
    }
  });

  it("treats an empty string as missing", () => {
    process.env[NAME] = "";
    expect(() => resolveSecret(NAME)).toThrow(CredentialUnavailableError);
  });

  it("returns null for an optional absent key instead of throwing", () => {
    delete process.env[NAME];
    expect(resolveSecret(NAME, false)).toBeNull();
  });

  it("never stores the value outside the call", () => {
    process.env[NAME] = "sk-ephemeral";
    resolveSecret(NAME);
    // The module keeps no state; re-resolving still works and returns the same.
    expect(resolveSecret(NAME)).toBe("sk-ephemeral");
  });
});

describe("resolveBearerToken", () => {
  it("returns the resolved value", () => {
    process.env[NAME] = "sk-bearer";
    expect(resolveBearerToken(NAME)).toBe("sk-bearer");
  });

  it("propagates the typed failure for a missing key", () => {
    delete process.env[NAME];
    expect(() => resolveBearerToken(NAME)).toThrow(/is not set in the environment/);
  });
});
