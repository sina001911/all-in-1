/**
 * Zero-config specialist + workflow stack (P5).
 *
 * The P4 execution engine, wrapped by the observability seam, plus the baseline
 * specialists. Deterministic local models only: no remote provider is
 * registered, egress stays deny-all, and no credential is read. The stack is
 * exported separately from the CLI entry point so its default-denial posture is
 * directly testable.
 */
import type { LogSink } from "../log/logger.ts";
import { Logger, MemorySink } from "../log/logger.ts";
import { buildExecutionStack, type ExecutionStack } from "../execution/stack.ts";
import type { UserProvidedProvider } from "../execution/user-providers.ts";
import type { ApprovalStore } from "../registry/approvals.ts";
import type { BudgetLedger } from "../registry/budget.ts";
import { LoggedExecutionEngine } from "../observability/execution-logger.ts";
import {
  SpecialistRegistry,
  registerBaselineSpecialists,
} from "./registry.ts";
import { SpecialistRunner } from "./runner.ts";

export interface SpecialistStack {
  readonly stack: ExecutionStack;
  readonly runner: SpecialistRunner;
  readonly logger: Logger;
  readonly sink: LogSink;
}

export function buildSpecialistStack(opts: {
  policy?: "FREE_ONLY" | "PREMIUM_ALLOWED";
  budgetUsd?: number;
  /** Defaults to an in-memory sink; the CLI passes an stderr writer. */
  logSink?: LogSink;
  /** Inject a pre-built approval store (e.g. a persistent one). */
  approvals?: ApprovalStore;
  /** Inject a pre-built budget ledger (e.g. a persistent one). */
  budget?: BudgetLedger;
  /**
   * Register the deterministic tool-capable agent model (D4). Opt-in; the
   * default stack is unchanged.
   */
  agentModel?: boolean;
  /**
   * Hosts to allowlist for egress (D7). Applied before the engine is built so
   * the policy the engine enforces is the policy that was requested.
   */
  allowHosts?: readonly string[];
  /** User-registered providers (D7). */
  providers?: readonly UserProvidedProvider[];
} = {}): SpecialistStack {
  const stack = buildExecutionStack(opts);
  const sink = opts.logSink ?? new MemorySink();
  const logger = new Logger(sink, "specialist");
  const logged = new LoggedExecutionEngine({ engine: stack.engine, logger });
  const specialists = new SpecialistRegistry();
  registerBaselineSpecialists(specialists);
  const runner = new SpecialistRunner({ engine: logged, specialists });
  return { stack, runner, logger, sink };
}
