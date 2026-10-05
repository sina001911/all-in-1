/**
 * Secret resolution at call time (P4).
 *
 * This is the ONLY place in the system that reads a secret VALUE. Every other
 * module references keys by environment-variable NAME only. The value is read
 * here, at the last possible moment, and:
 *
 *   1. is never stored in a field that outlives the call,
 *   2. is never passed to the logger (the Logger redacts defensively, but this
 *      module does not rely on that),
 *   3. is never embedded in an error message or an AllInOneError `cause`,
 *   4. is passed straight to the adapter, which puts it into an Authorization
 *      header for a single request.
 *
 * A missing key is a typed `CREDENTIAL_UNAVAILABLE` failure — never a prompt,
 * never a guess, and never a silent fallback to a keyless call.
 */
import { AllInOneError } from "../errors.ts";

export class CredentialUnavailableError extends AllInOneError {
  readonly envName: string;
  constructor(envName: string) {
    super(
      `Credential ${envName} is not set in the environment; refusing to make an authenticated call`,
      "CREDENTIAL_UNAVAILABLE",
      "unavailable",
      { retryable: false },
    );
    this.name = "CredentialUnavailableError";
    this.envName = envName;
  }
}

/**
 * Resolve an environment-variable NAME to its value at call time.
 *
 * `required: false` is used only by adapters that declare
 * `availableWithoutCredentials` and genuinely tolerate an absent key; every
 * other caller must leave it required so a missing key fails loudly.
 */
export function resolveSecret(envName: string, required = true): string | null {
  const value = process.env[envName];
  if (value === undefined || value === "") {
    if (required) throw new CredentialUnavailableError(envName);
    return null;
  }
  return value;
}

/**
 * Resolve a bearer token for an adapter. The returned string is the caller's
 * responsibility; it must not be logged.
 */
export function resolveBearerToken(envName: string): string {
  const value = resolveSecret(envName, true);
  return value as string;
}
