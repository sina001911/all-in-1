/**
 * Execution layer public surface (P4).
 *
 * The first real call path. Composes the selector, egress gate, secret
 * resolution, adapter registry, and budget settlement into one fixed gate
 * order. See `engine.ts` for why that order is a security property.
 */
export { ExecutionEngine } from "./engine.ts";
export type { ExecutionEngineOptions, ExecutionOutcome, InvokeOptions, InvocationPortal } from "./engine.ts";
export { buildExecutionStack } from "./stack.ts";
export type { ExecutionStack } from "./stack.ts";
export { select } from "./selector.ts";
export type { SelectorOptions } from "./selector.ts";
export { LocalAdapter } from "./local-adapter.ts";
export { OpenAICompatibleAdapter } from "./openai-compatible-adapter.ts";
export type { OpenAICompatibleOptions } from "./openai-compatible-adapter.ts";
export { AdapterRegistry } from "./adapter-registry.ts";
export {
  assertEgressAllowed,
  allowHost,
  isEgressAllowed,
  DEFAULT_EGRESS_POLICY,
} from "./egress.ts";
export type { EgressPolicy, EgressPolicyKind } from "./egress.ts";
export { resolveSecret, resolveBearerToken } from "./secrets.ts";
export { CredentialUnavailableError } from "./secrets.ts";
export type {
  ProviderInvokeResult,
  ProviderInvokeFailure,
  HttpTransport,
  HttpResponse,
} from "./types.ts";
