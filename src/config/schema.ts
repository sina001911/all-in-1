/**
 * Config schema with frozen defaults. Layered resolution is implemented in
 * index.ts. Secrets are referenced by environment-variable NAME only.
 */
import type { CostPolicy } from "../registry/cost-policy.ts";
import type { SafetyMode } from "../safety/guard.ts";
import type { HostPolicy } from "../safety/hosts.ts";

export interface VisualConfig {
  /**
   * The main coding model binding. `null` when no external coder (e.g. Atria)
   * is configured — AI1 still works through the built-in local agent. Making
   * this nullable is the optionality guarantee: the system never depends on
   * Atria being present, enabled, or reachable.
   */
  readonly mainCoder:
    | { readonly provider: string; readonly model: string; readonly fixed: boolean }
    | null;
  readonly roles: Record<string, { readonly policy: CostPolicy }>;
  readonly cost: {
    readonly spendBudgetUsd: number;
    readonly requireApprovalAboveUsd: number;
    readonly unknownPricing: "premium";
  };
  readonly workflow: {
    readonly humanInTheLoop: true;
    readonly maxIterations: number;
    readonly auto: {
      readonly enabled: false;
      readonly maxIterations: number;
      readonly maxEdits: number;
      readonly dryRunFirst: true;
    };
  };
  readonly artifacts: {
    readonly location: "global";
    readonly retentionDays: number;
    readonly keepRuns: number;
  };
  readonly browser: { readonly hostPolicy: HostPolicy };
  readonly media: {
    readonly enabled: false;
    readonly policy: CostPolicy;
    readonly providers: Record<string, never>;
    readonly budget: {
      readonly maxMediaGenerations: number;
      readonly maxVideoDurationSeconds: number;
      readonly maxCostPerRunUsd: number;
      readonly maxModelCalls: number;
    };
    /**
     * D35: per-call resilience. `maxRetries` is the number of ADDITIONAL
     * attempts after the first (so 1 = one retry, 2 = two retries).
     * `retryDelayMs` is the base of a linear backoff; the actual delay for
     * attempt N is `retryDelayMs * N`, capped at 30s. Both default to 0 in
     * the frozen schema — a fresh install makes no retries — and the desktop
     * stack raises them from Settings when the human opts into resilient
     * generation. They are NOT cost controls: a retry costs nothing extra
     * against the budget because the ledger commits only once, after the
     * successful attempt.
     */
    readonly maxRetries: number;
    readonly retryDelayMs: number;
  };
  readonly vision: {
    readonly provider: "openrouter";
    readonly endpoint: "https://openrouter.ai/api/v1";
    readonly apiKeyEnv: "OPENROUTER_API_KEY";
    readonly locale: string;
    readonly maxImageEdge: number;
  };
}

export const FROZEN_DEFAULTS: VisualConfig = {
  /**
   * No default main-coder binding. The user may configure one explicitly (e.g.
   * Atria-Dawn-Preview / s1) through settings or CLI flags; until then the
   * system falls back to the built-in local agent for all coding work.
   */
  mainCoder: null,
  roles: {
    VISION: { policy: "PREFERRED_FREE" },
    VISUAL_QA: { policy: "PREFERRED_FREE" },
    CODE_REVIEWER: { policy: "PREFERRED_FREE" },
    DEEP_REASONING: { policy: "PREFERRED_FREE" },
    CODING_ASSISTANT: { policy: "PREFERRED_FREE" },
    FAST_TASK: { policy: "PREFERRED_FREE" },
  },
  cost: {
    spendBudgetUsd: 0,
    requireApprovalAboveUsd: 0.01,
    unknownPricing: "premium",
  },
  workflow: {
    humanInTheLoop: true,
    maxIterations: 8,
    auto: { enabled: false, maxIterations: 5, maxEdits: 20, dryRunFirst: true },
  },
  artifacts: { location: "global", retentionDays: 30, keepRuns: 5 },
  browser: { hostPolicy: "localhost-only" },
  media: {
    enabled: false,
    policy: "PREFERRED_FREE",
    providers: {},
    budget: {
      maxMediaGenerations: 0,
      maxVideoDurationSeconds: 0,
      maxCostPerRunUsd: 0,
      maxModelCalls: 0,
    },
    maxRetries: 0,
    retryDelayMs: 0,
  },
  vision: {
    provider: "openrouter",
    endpoint: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    locale: "fa",
    maxImageEdge: 1568,
  },
};
