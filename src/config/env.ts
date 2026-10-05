/**
 * Environment resolution. Secrets are referenced by variable NAME only.
 *
 * This module NEVER reads a secret's value, NEVER stores one, and NEVER logs
 * one. It only exposes the *name* that a caller must resolve from its own
 * environment at the moment a call is actually made (deferred to P3+).
 */
export interface EnvRef {
  readonly name: string;
}

export function envRef(name: string): EnvRef {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid environment variable name: ${name}`);
  }
  return { name };
}

export const KNOWN_ENV_REFS = {
  openrouterApiKey: envRef("OPENROUTER_API_KEY"),
} as const;

/** Redaction canary: any value matching these patterns is scrubbed in logs. */
export const SECRET_PATTERNS = [
  /^(?:Bearer\s+)?[A-Za-z0-9-_]{40,}$/, // long opaque tokens
  /^sk-[A-Za-z0-9-_]{20,}$/, // sk-* style keys
  /^[A-Fa-f0-9]{64}$/, // 256-bit hex secrets
] as const;
