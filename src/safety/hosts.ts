/**
 * Host policy. The browser layer navigates only to explicitly allowed hosts.
 * Default policy is localhost-only, which prevents the perception/browser
 * layer from becoming an exfiltration vector.
 */
export const HOST_POLICIES = ["localhost-only", "allowlist"] as const;
export type HostPolicy = (typeof HOST_POLICIES)[number];

const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const IPV6_LOOPBACK = /^::1$/;

function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost") return true;
  if (IPV4_LOOPBACK.test(h)) return true;
  if (IPV6_LOOPBACK.test(h)) return true;
  return false;
}

export class HostPolicyViolationError extends Error {
  readonly host: string;
  constructor(host: string) {
    super(`Host not allowed under current policy: ${host}`);
    this.name = "HostPolicyViolationError";
    this.host = host;
  }
}

export function isHostAllowed(host: string, policy: HostPolicy, allowlist?: readonly string[]): boolean {
  if (policy === "allowlist" && allowlist?.includes(host)) return true;
  return isLoopback(host); // loopback is always permitted under every policy
}

export function assertHostAllowed(url: string, policy: HostPolicy, allowlist?: readonly string[]): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new HostPolicyViolationError(url);
  }
  if (!isHostAllowed(host, policy, allowlist)) throw new HostPolicyViolationError(host);
}
