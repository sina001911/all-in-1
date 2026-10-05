/**
 * Credential provider contracts (D1).
 *
 * The desktop stores provider credentials in OS-protected storage (Windows
 * DPAPI via Electron `safeStorage`). This interface is the ONLY seam through
 * which the core may resolve a key VALUE.
 *
 * Security rules enforced by the design:
 *
 *   - `resolve()` is only ever called by the core, in the main process, at the
 *     point of an authenticated call. It is deliberately absent from the
 *     DesktopFacade surface, so no IPC channel can return a secret value to the
 *     renderer.
 *   - Credential NAMES may be listed (they are not secret); values may not.
 *   - A credential is referenced by its environment-variable NAME, preserving
 *     the core's env-NAME-only convention; the store is simply an alternative
 *     backing for that name.
 */
export interface CredentialProvider {
  /** True if a value is stored for this name. */
  has(name: string): boolean;
  /**
   * Resolve a name to its value, or null when none is stored. The returned
   * value is the caller's responsibility: it must not be logged, stored in a
   * field that outlives the call, or placed in an error message.
   */
  resolve(name: string): string | null;
  /** Resolve or throw a typed error; for adapters that cannot run keyless. */
  resolveRequired(name: string): string;
  /** Store a value. Called from the main process only (settings UI handler). */
  set(name: string, value: string): void;
  /** Remove a stored value. */
  delete(name: string): void;
  /** The set of stored NAMES (never values). */
  listNames(): readonly string[];
}

export class CredentialUnavailableError extends Error {
  readonly name = "CredentialUnavailableError";
  readonly credentialName: string;
  constructor(credentialName: string) {
    super(`Credential ${credentialName} is not stored; refusing to make an authenticated call`);
    this.credentialName = credentialName;
  }
}
