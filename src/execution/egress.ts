/**
 * Egress policy for model provider endpoints (P4).
 *
 * SECURITY BOUNDARY. This is the first component in the system that is allowed
 * to open an outbound connection to a non-loopback host. P2's localhost-only
 * `hostPolicy` governs the BROWSER and must not be reused here: model API
 * endpoints are remote by nature. This module is deliberately separate from
 * `safety/hosts.ts` so the two policies can evolve independently and neither
 * can weaken the other.
 *
 * Frozen-safe default: `denyAll()`. Under the shipped defaults the allowlist is
 * empty and loopback is the only permitted target, so NO remote provider is
 * reachable unless the user explicitly allowlists its host. A provider that is
 * registered but whose host is not allowlisted can never be contacted.
 */
import { AllInOneError } from "../errors.ts";

export const EGRESS_POLICIES = ["deny-all", "explicit-allowlist"] as const;
export type EgressPolicyKind = (typeof EGRESS_POLICIES)[number];

export interface EgressPolicy {
  readonly kind: EgressPolicyKind;
  /** Explicitly permitted remote hosts. Empty under the frozen default. */
  readonly allowlist: readonly string[];
  /** When true, plain http is permitted on loopback (for fixture servers). */
  readonly allowLoopbackHttp?: boolean;
}

export const DEFAULT_EGRESS_POLICY: EgressPolicy = {
  kind: "deny-all",
  allowlist: [],
  allowLoopbackHttp: true,
};

const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function isLoopback(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || IPV4_LOOPBACK.test(h);
}

export class EgressBlockedError extends AllInOneError {
  readonly host: string;
  constructor(host: string, reason: string) {
    super(`Egress to ${host} is not allowed: ${reason}`, "EGRESS_BLOCKED", "security");
    this.name = "EgressBlockedError";
    this.host = host;
  }
}

export function isEgressAllowed(endpoint: string | null, policy: EgressPolicy): boolean {
  if (endpoint === null) return true; // a keyless/local adapter with no endpoint
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return false;
  }
  const host = parsed.hostname;
  if (isLoopback(host)) {
    // Loopback is always permitted; plain http only when explicitly opted in.
    if (parsed.protocol === "https:") return true;
    return policy.allowLoopbackHttp !== false;
  }
  if (policy.kind === "deny-all") return false;
  if (!policy.allowlist.some((allowed) => allowed.toLowerCase() === host)) return false;
  // A remote endpoint must use https; a remote plain-http endpoint is refused
  // even when its host is allowlisted.
  return parsed.protocol === "https:";
}

export function assertEgressAllowed(endpoint: string | null, policy: EgressPolicy): void {
  if (endpoint === null) return;
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new EgressBlockedError(endpoint, "not a valid URL");
  }
  const host = parsed.hostname;
  if (isLoopback(host)) {
    if (parsed.protocol !== "https:" && policy.allowLoopbackHttp === false) {
      throw new EgressBlockedError(host, "plain http on loopback is not permitted");
    }
    return;
  }
  if (policy.kind === "deny-all") {
    throw new EgressBlockedError(host, "egress policy is deny-all");
  }
  if (!policy.allowlist.some((allowed) => allowed.toLowerCase() === host)) {
    throw new EgressBlockedError(host, "host is not on the egress allowlist");
  }
  if (parsed.protocol !== "https:") {
    throw new EgressBlockedError(host, "remote endpoints must use https");
  }
}

/** Add a host to a policy, returning a new policy (immutable update). */
export function allowHost(policy: EgressPolicy, host: string): EgressPolicy {
  if (isLoopback(host)) return policy;
  if (policy.allowlist.some((a) => a.toLowerCase() === host.toLowerCase())) return policy;
  return { ...policy, kind: "explicit-allowlist", allowlist: [...policy.allowlist, host] };
}
