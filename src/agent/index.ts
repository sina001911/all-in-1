/**
 * Agent runtime assembly (D3).
 *
 * Builds an `AgentRuntime` on top of a D2 `ToolRuntime` and a `ModelGateway`.
 * The gateway is the seam D4 fills with a real provider; until then the agent
 * is exercised against the scripted gateway in tests.
 *
 * The wiring order is the security property: the agent receives the tool
 * RUNTIME (executor + registry + policy) and never the APPROVER. There is no
 * parameter here through which a caller could hand the agent the power to
 * approve its own tool requests — that power stays inside the executor, where
 * the desktop's interactive approver lives.
 */
import { AgentRuntime, type AgentRuntimeOptions } from "./loop.ts";
import type { ToolRuntime } from "../tools/index.ts";
import type { ModelGateway } from "./types.ts";

export interface AgentRuntimeBuildOptions {
  readonly tools: ToolRuntime;
  readonly gateway: ModelGateway;
}

export function buildAgentRuntime(opts: AgentRuntimeBuildOptions): AgentRuntime {
  const runtimeOptions: AgentRuntimeOptions = {
    gateway: opts.gateway,
    executor: opts.tools.executor,
    registry: opts.tools.registry,
    policy: opts.tools.policy,
  };
  return new AgentRuntime(runtimeOptions);
}

export * from "./types.ts";
export * from "./loop.ts";
export * from "./visibility.ts";
export * from "./scripted-gateway.ts";
export * from "./provider-gateway.ts";
