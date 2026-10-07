/**
 * Zero-config execution stack (P4, relocated in P5 for testability).
 *
 * Only the deterministic local adapter and the local models are wired in: no
 * remote provider is registered, egress is deny-all, and the budget is 0 unless
 * a caller says otherwise. The machinery is complete but inert until a user
 * explicitly opens it.
 */
import { ModelCatalog } from "../models/catalog.ts";
import { PriorityChains } from "../models/priorities.ts";
import { CapabilityRegistry } from "../capabilities/registry.ts";
import { registerBaselineCapabilities } from "../capabilities/capabilities.ts";
import { ApprovalStore } from "../registry/approvals.ts";
import { BudgetLedger } from "../registry/budget.ts";
import { ExecutionEngine } from "./engine.ts";
import { LocalAdapter, registerLocalModels, registerLocalAgentModel } from "./local-adapter.ts";
import { AdapterRegistry as ProviderAdapterRegistry } from "./adapter-registry.ts";
import { DEFAULT_EGRESS_POLICY, allowHost } from "./egress.ts";
import { registerUserProvider, type UserProvidedProvider } from "./user-providers.ts";

export interface ExecutionStack {
  readonly catalog: ModelCatalog;
  readonly capabilities: CapabilityRegistry;
  readonly chains: PriorityChains;
  readonly approvals: ApprovalStore;
  readonly adapters: ProviderAdapterRegistry;
  readonly engine: ExecutionEngine;
  readonly egress: ReturnType<typeof allowHost>;
  readonly budget: BudgetLedger;
  /** Warnings from user-provider registration (D7), surfaced to the user. */
  readonly registrationWarnings: readonly string[];
}

export function buildExecutionStack(opts: {
  policy?: "FREE_ONLY" | "PREMIUM_ALLOWED";
  budgetUsd?: number;
  /**
   * Hosts to allowlist for egress. Applied BEFORE the engine is built so the
   * policy the engine holds is the policy that is enforced; mutating an egress
   * object after construction has no effect on the engine.
   */
  allowHosts?: readonly string[];
  /**
   * Inject a pre-built approval store (e.g. a persistent one hydrated from
   * disk). When omitted an in-memory store is created, exactly as before.
   */
  approvals?: ApprovalStore;
  /**
   * Inject a pre-built budget ledger (e.g. a persistent one hydrated from
   * disk). When omitted an in-memory ledger is created, exactly as before.
   */
  budget?: BudgetLedger;
  /**
   * Register the deterministic tool-capable agent model (D4). Opt-in: the
   * default catalogue stays exactly as it was so the stack's inertness is
   * unchanged. The desktop opts in because its agent loop needs a model that
   * declares tool calling.
   */
  agentModel?: boolean;
  /**
   * User-registered providers (D7). Each is validated and registered
   * additively; a bad entry is skipped with a warning, never thrown.
   */
  providers?: readonly UserProvidedProvider[];
} = {}): ExecutionStack {
  const catalog = new ModelCatalog();
  registerLocalModels(catalog);
  if (opts.agentModel) registerLocalAgentModel(catalog);
  const capabilities = new CapabilityRegistry();
  registerBaselineCapabilities(capabilities);
  const chains = new PriorityChains(catalog);
  const adapters = new ProviderAdapterRegistry();
  adapters.register(new LocalAdapter());
  const approvals = opts.approvals ?? new ApprovalStore();
  const budget =
    opts.budget ??
    new BudgetLedger(
      Number.isFinite(opts.budgetUsd) ? Math.max(0, opts.budgetUsd as number) : 0,
    );
  const egress = (opts.allowHosts ?? []).reduce(
    (policy, host) => allowHost(policy, host),
    DEFAULT_EGRESS_POLICY,
  );
  // D7: user providers are registered BEFORE the engine is built, so the engine
  // sees the catalogue and adapters it will actually select from.
  const registrationWarnings: string[] = [];
  for (const provider of opts.providers ?? []) {
    const result = registerUserProvider(provider, adapters, catalog);
    registrationWarnings.push(...result.warnings);
  }
  const engine = new ExecutionEngine({
    catalog,
    capabilities,
    chains,
    approvals,
    budget,
    adapters,
    policy: opts.policy,
    egress,
  });
  return { catalog, capabilities, chains, approvals, adapters, engine, egress, budget, registrationWarnings };
}
