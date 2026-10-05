/**
 * Config schema with frozen defaults. Layered resolution is implemented in
 * index.ts. Secrets are referenced by environment-variable NAME only.
 */
import type { CostPolicy } from "../registry/cost-policy.ts";
import type { SafetyMode } from "../safety/guard.ts";
import type { HostPolicy } from "../safety/hosts.ts";

export interface VisualConfig {
  readonly mainCoder: {
    readonly provider: "s1";
    readonly model: "Atria-Dawn-Preview";
    readonly fixed: true;
  };
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
  mainCoder: { provider: "s1", model: "Atria-Dawn-Preview", fixed: true },
  roles: {
    VISION: { policy: "FREE_ONLY" },
    VISUAL_QA: { policy: "FREE_ONLY" },
    CODE_REVIEWER: { policy: "PREFERRED_FREE" },
    DEEP_REASONING: { policy: "PREFERRED_FREE" },
    CODING_ASSISTANT: { policy: "FREE_ONLY" },
    FAST_TASK: { policy: "FREE_ONLY" },
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
    policy: "FREE_ONLY",
    providers: {},
    budget: {
      maxMediaGenerations: 0,
      maxVideoDurationSeconds: 0,
      maxCostPerRunUsd: 0,
      maxModelCalls: 0,
    },
  },
  vision: {
    provider: "openrouter",
    endpoint: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    locale: "fa",
    maxImageEdge: 1568,
  },
};
