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
import { LocalAdapter, registerLocalModels } from "./local-adapter.ts";
import { AdapterRegistry as ProviderAdapterRegistry } from "./adapter-registry.ts";
import { DEFAULT_EGRESS_POLICY, allowHost } from "./egress.ts";

export interface ExecutionStack {
  readonly catalog: ModelCatalog;
  readonly capabilities: CapabilityRegistry;
  readonly chains: PriorityChains;
  readonly approvals: ApprovalStore;
  readonly adapters: ProviderAdapterRegistry;
  readonly engine: ExecutionEngine;
  readonly egress: ReturnType<typeof allowHost>;
  readonly budget: BudgetLedger;
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
} = {}): ExecutionStack {
  const catalog = new ModelCatalog();
  registerLocalModels(catalog);
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
  return { catalog, capabilities, chains, approvals, adapters, engine, egress, budget };
}
