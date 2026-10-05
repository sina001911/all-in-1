/**
 * Redaction filter. Canaries for opaque tokens, sk-* keys, and hex secrets.
 * Applied defensively: a secret value should never reach a log sink even when
 * a caller passes one by mistake.
 */
import { SECRET_PATTERNS } from "../config/env.ts";

const REDACTED = "[REDACTED]";

export function redact(input: string): string {
  let out = input;
  // Bearer prefixes
  out = out.replace(/Bearer\s+[A-Za-z0-9-._~+/]+=*/gi, `Bearer ${REDACTED}`);
  // Long opaque tokens (40+ urlsafe chars)
  out = out.replace(/[A-Za-z0-9-_]{40,}/g, (m) => (SECRET_PATTERNS[0].test(m) ? REDACTED : m));
  // sk-* style keys
  out = out.replace(/sk-[A-Za-z0-9-_]{20,}/g, REDACTED);
  // 64-char hex
  out = out.replace(/\b[A-Fa-f0-9]{64}\b/g, REDACTED);
  return out;
}

export function isSecretLike(input: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(input));
}
